const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config/config');
const logger = require('./logger');
const { sendWhatsappMsg } = require('./whatsapp');

let state = { version: 1, jobs: [] };
let running = false;
let timer = null;

const now = () => new Date().toISOString();

const save = () => {
    fs.ensureDirSync(path.dirname(config.WHATSAPP_OUTBOX_FILE));
    fs.writeJsonSync(config.WHATSAPP_OUTBOX_FILE, state, { spaces: 2 });
};

const load = () => {
    try {
        const loaded = fs.existsSync(config.WHATSAPP_OUTBOX_FILE)
            ? fs.readJsonSync(config.WHATSAPP_OUTBOX_FILE)
            : null;
        state = {
            version: 1,
            jobs: Array.isArray(loaded?.jobs) ? loaded.jobs : []
        };
        for (const job of state.jobs) {
            if (job.status === 'sending') {
                job.status = 'queued';
                job.resumed_at = now();
            }
        }
        save();
    } catch (error) {
        logger.error('whatsapp_outbox_load_failed', { error: error.message });
        state = { version: 1, jobs: [] };
    }
};

const prune = () => {
    const completed = state.jobs.filter((job) => ['sent', 'failed'].includes(job.status));
    if (completed.length <= 100) return;
    const keep = new Set(completed.slice(-100).map((job) => job.id));
    state.jobs = state.jobs.filter((job) => !['sent', 'failed'].includes(job.status) || keep.has(job.id));
};

const nextJob = () => state.jobs.find((job) =>
    ['queued', 'retrying'].includes(job.status)
    && (!job.next_attempt_at || Date.parse(job.next_attempt_at) <= Date.now())
);

const nextRetryDelay = () => {
    const delays = state.jobs
        .filter((job) => job.status === 'retrying' && job.next_attempt_at)
        .map((job) => Date.parse(job.next_attempt_at) - Date.now())
        .filter(Number.isFinite);
    return delays.length ? Math.max(0, Math.min(...delays)) : null;
};

const schedule = (delayMs = 0) => {
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        processNext().catch((error) => {
            logger.error('whatsapp_outbox_worker_failed', { error: error.message });
        });
    }, Math.max(0, delayMs));
    timer.unref?.();
};

const processNext = async () => {
    if (running) return;
    running = true;
    try {
        const job = nextJob();
        if (!job) return;

        const attachment = job.attachments[job.next_index];
        if (!attachment || !fs.existsSync(attachment.path)) {
            job.status = 'failed';
            job.last_error = attachment
                ? `File tidak ditemukan: ${attachment.path}`
                : 'Tidak ada file tersisa untuk dikirim';
            job.finished_at = now();
            save();
            logger.error('whatsapp_outbox_file_missing', { job_id: job.id, error: job.last_error });
            return;
        }

        job.status = 'sending';
        job.updated_at = now();
        save();
        logger.info('whatsapp_outbox_sending', {
            job_id: job.id,
            filename: attachment.filename,
            index: job.next_index + 1,
            total: job.attachments.length
        });

        let persistedSuccess = false;
        await sendWhatsappMsg(job.userWA, job.userName, [attachment], {
            attachmentOffset: job.next_index,
            onAttachmentResult: async (result) => {
                if (!result.queued) return;
                persistedSuccess = true;
                job.next_index += 1;
                job.attempts = 0;
                job.last_error = null;
                job.status = job.next_index >= job.attachments.length ? 'sent' : 'queued';
                job.updated_at = now();
                if (job.status === 'sent') job.finished_at = now();
                prune();
                save();
                logger.info('whatsapp_outbox_attachment_sent', {
                    job_id: job.id,
                    filename: result.filename,
                    sent: job.next_index,
                    total: job.attachments.length,
                    completed: job.status === 'sent'
                });
            }
        });

        if (!persistedSuccess) throw new Error('Gateway tidak mengonfirmasi file');
    } catch (error) {
        const job = state.jobs.find((item) => item.status === 'sending');
        if (!job) {
            logger.error('whatsapp_outbox_worker_failed', { error: error.message });
            return;
        }
        job.attempts = Number(job.attempts || 0) + 1;
        job.last_error = error.message;
        job.updated_at = now();
        if (job.attempts >= config.WHATSAPP_OUTBOX_MAX_RETRIES) {
            job.status = 'failed';
            job.finished_at = now();
            logger.error('whatsapp_outbox_failed', {
                job_id: job.id,
                attempts: job.attempts,
                error: error.message
            });
        } else {
            const delayMs = config.WHATSAPP_OUTBOX_RETRY_DELAY_MS * job.attempts;
            job.status = 'retrying';
            job.next_attempt_at = new Date(Date.now() + delayMs).toISOString();
            logger.warn('whatsapp_outbox_retry_scheduled', {
                job_id: job.id,
                attempts: job.attempts,
                retry_in_ms: delayMs,
                error: error.message
            });
        }
        save();
    } finally {
        running = false;
        const delay = nextJob() ? 0 : nextRetryDelay();
        if (delay !== null) schedule(delay);
    }
};

const enqueue = ({ userWA, userName, attachments }) => {
    if (!userWA || !attachments?.length || !config.ENABLE_WHATSAPP) {
        return { queued: false, skipped: true };
    }
    const job = {
        id: crypto.randomUUID(),
        userWA,
        userName: userName || 'Tamu',
        attachments: attachments.map((item) => ({ filename: item.filename, path: item.path })),
        next_index: 0,
        attempts: 0,
        status: 'queued',
        created_at: now(),
        updated_at: now()
    };
    state.jobs.push(job);
    prune();
    save();
    logger.info('whatsapp_outbox_queued', {
        job_id: job.id,
        user: job.userName,
        files: job.attachments.length
    });
    schedule();
    return { queued: true, job_id: job.id, files: job.attachments.length };
};

const retry = (jobId) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error('Antrean WhatsApp tidak ditemukan');
    if (job.status === 'sent') {
        throw new Error('Antrean sudah selesai. Buat resend baru bila ingin mengirim ulang.');
    }
    if (job.status === 'sending') {
        throw new Error('Antrean sedang dikirim; tunggu proses saat ini selesai');
    }
    job.status = 'queued';
    job.attempts = 0;
    job.last_error = null;
    delete job.next_attempt_at;
    job.updated_at = now();
    save();
    logger.info('whatsapp_outbox_retry_requested', { job_id: job.id, sent: job.next_index, total: job.attachments.length });
    schedule();
    return { job_id: job.id, status: job.status, sent: job.next_index, total: job.attachments.length };
};

const enqueueFolder = ({ folder, userWA, userName, includeFrame = false }) => {
    const requestedFolder = String(folder || '').trim();
    const safeFolder = path.basename(requestedFolder);
    if (!safeFolder || safeFolder !== requestedFolder || safeFolder === '.') {
        throw new Error('Nama folder foto tidak valid');
    }
    const folderPath = path.resolve(config.BASE_PHOTO_FOLDER, safeFolder);
    const basePath = `${path.resolve(config.BASE_PHOTO_FOLDER)}${path.sep}`;
    if (!folderPath.startsWith(basePath) || !fs.existsSync(folderPath)) {
        throw new Error(`Folder sesi tidak ditemukan: ${safeFolder}`);
    }
    const files = fs.readdirSync(folderPath)
        .filter((filename) => /\.(jpe?g|png|webp)$/i.test(filename))
        .filter((filename) => !filename.endsWith('_mirror.jpg'))
        .filter((filename) => includeFrame || !filename.startsWith('Cetak_Frame_'))
        .sort((left, right) => left.localeCompare(right))
        .map((filename) => ({ filename, path: path.join(folderPath, filename) }));
    if (!files.length) throw new Error('Tidak ada foto yang dapat dikirim pada folder ini');
    return enqueue({ userWA, userName: userName || safeFolder, attachments: files });
};

const start = () => {
    load();
    const resumable = state.jobs.filter((job) => ['queued', 'retrying'].includes(job.status)).length;
    if (resumable) logger.info('whatsapp_outbox_resumed', { jobs: resumable });
    schedule();
};

const getStatus = () => ({
    queued: state.jobs.filter((job) => job.status === 'queued').length,
    retrying: state.jobs.filter((job) => job.status === 'retrying').length,
    sending: state.jobs.filter((job) => job.status === 'sending').length,
    failed: state.jobs.filter((job) => job.status === 'failed').length,
    jobs: state.jobs.map((job) => ({
        id: job.id,
        user: job.userName,
        status: job.status,
        sent: job.next_index,
        total: job.attachments.length,
        attempts: job.attempts,
        last_error: job.last_error || null,
        created_at: job.created_at || null,
        updated_at: job.updated_at || null,
        next_attempt_at: job.next_attempt_at || null
    }))
});

module.exports = { enqueue, enqueueFolder, retry, start, getStatus };
