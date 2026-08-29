const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const config = require('../config/config');
const logger = require('./logger');
const { withResourceLock } = require('./resourceLock');
const mimach = require('./mimach');

// Fonnte mendokumentasikan batas berkas 10 MB. Sisakan sedikit ruang untuk
// overhead dan kompres hanya jika memang diperlukan.
const MAX_UPLOAD_BYTES = 9.5 * 1024 * 1024;
const FILE_UPLOAD_RETRIES = 3;
const STATUS_CACHE_MS = 60 * 1000;
let cachedStatus = null;
let cachedStatusAt = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeTarget = (value) => {
    let target = String(value || '').replace(/\D/g, '');
    const countryCode = String(config.FONNTE_COUNTRY_CODE || '62').replace(/\D/g, '');
    if (target.startsWith('0')) target = `${countryCode}${target.slice(1)}`;
    if (target && !target.startsWith(countryCode)) target = `${countryCode}${target}`;
    return target;
};

const responseSucceeded = (payload) =>
    payload?.status === true || payload?.Status === true;

const fonnteRequest = async (pathname, options = {}) => {
    if (!config.FONNTE_TOKEN) {
        throw new Error('FONNTE_TOKEN belum dikonfigurasi');
    }

    const { timeoutMs = 30000, ...fetchOptions } = options;
    const response = await fetch(`${config.FONNTE_API_URL}${pathname}`, {
        method: 'POST',
        ...fetchOptions,
        headers: {
            Authorization: config.FONNTE_TOKEN,
            ...(fetchOptions.headers || {})
        },
        signal: AbortSignal.timeout(timeoutMs)
    });

    const rawBody = await response.text();
    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch (_) {
        throw new Error(`Respons Fonnte tidak valid (HTTP ${response.status})`);
    }

    if (!response.ok || !responseSucceeded(payload)) {
        const apiMessage = payload.reason
            || payload.detail
            || payload.message
            || payload.error;
        const payloadSummary = JSON.stringify(payload).slice(0, 500);
        throw new Error(
            apiMessage
                ? `${apiMessage} (HTTP ${response.status})`
                : `Fonnte HTTP ${response.status}: ${payloadSummary}`
        );
    }
    return payload;
};

const sendText = (target, message) => fonnteRequest('/send', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        target,
        message,
        countryCode: '0',
        connectOnly: config.FONNTE_CONNECT_ONLY
    })
});

const mimeForFile = (filename) => {
    const extension = path.extname(filename).toLowerCase();
    if (extension === '.png') return 'image/png';
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
    if (extension === '.pdf') return 'application/pdf';
    return 'application/octet-stream';
};

const prepareAttachment = async (attachment) => {
    const sourcePath = attachment.path;
    const stats = await fs.stat(sourcePath);
    if (stats.size <= MAX_UPLOAD_BYTES) {
        return { path: sourcePath, filename: attachment.filename, temporary: false };
    }

    if (!/\.(png|jpe?g)$/i.test(sourcePath)) {
        throw new Error(`${attachment.filename} melebihi batas unggahan Fonnte`);
    }

    const outputPath = path.join(
        os.tmpdir(),
        `fonnte-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`
    );
    await sharp(sourcePath)
        .rotate()
        .resize({ width: 1800, withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(outputPath);

    const outputStats = await fs.stat(outputPath);
    if (outputStats.size > MAX_UPLOAD_BYTES) {
        await fs.remove(outputPath);
        await sharp(sourcePath)
            .rotate()
            .resize({ width: 1400, withoutEnlargement: true })
            .jpeg({ quality: 68, mozjpeg: true })
            .toFile(outputPath);
    }

    return {
        path: outputPath,
        filename: `${path.parse(attachment.filename).name}.jpg`,
        temporary: true
    };
};

const sendFile = async (target, attachment, message = '') => {
    const prepared = await prepareAttachment(attachment);
    try {
        const buffer = await fs.readFile(prepared.path);
        if (buffer.length > MAX_UPLOAD_BYTES) {
            throw new Error(`${prepared.filename} masih melebihi batas unggahan Fonnte`);
        }

        const mimeType = mimeForFile(prepared.filename);
        const fileBlob = new Blob([buffer], { type: mimeType });

        const form = new FormData();
        form.append('target', target);
        // Fonnte API mewajibkan parameter 'message' tidak boleh string kosong ('')
        form.append('message', message && message.trim() ? message : ' ');
        form.append('countryCode', '0');
        form.append('connectOnly', String(config.FONNTE_CONNECT_ONLY));
        // Fonnte hanya memakai filename untuk dokumen/audio. Untuk gambar,
        // filename dapat membuat request diterima sebagai teks tanpa media.
        if (!/^image\//i.test(mimeType) && !/^video\//i.test(mimeType)) {
            form.append('filename', prepared.filename);
        }
        // Hanya sertakan 'file' untuk unggahan berkas multipart (JANGAN sertakan 'url' agar Fonnte tidak menganggapnya link web)
        form.append('file', fileBlob, prepared.filename);

        return await fonnteRequest('/send', { body: form });
    } finally {
        if (prepared.temporary) {
            await fs.remove(prepared.path).catch(() => {});
        }
    }
};

const getWhatsappStatus = async () => {
    if (config.WHATSAPP_PROVIDER === 'mimach') {
        return mimach.getWhatsappStatus();
    }
    if (!config.ENABLE_WHATSAPP) {
        return { ok: false, message: 'Pengiriman WhatsApp dinonaktifkan' };
    }
    if (!config.FONNTE_TOKEN) {
        return { ok: false, message: 'Token Fonnte belum diisi' };
    }

    if (cachedStatus && Date.now() - cachedStatusAt < STATUS_CACHE_MS) {
        return cachedStatus;
    }

    try {
        const profile = await fonnteRequest('/device', { timeoutMs: 5000 });
        cachedStatus = {
            ok: profile.device_status === 'connect',
            message: profile.device_status === 'connect'
                ? `Fonnte terhubung (kuota ${profile.quota ?? '-'})`
                : 'Perangkat Fonnte tidak terhubung'
        };
    } catch (error) {
        cachedStatus = { ok: false, message: `Fonnte: ${error.message}` };
    }
    cachedStatusAt = Date.now();
    return cachedStatus;
};

const sendWhatsappJob = async (userWA, userName, attachments, options = {}) => {
    if (!userWA || attachments.length === 0) return { skipped: true };
    if (!config.ENABLE_WHATSAPP || !config.FONNTE_TOKEN) {
        console.log(`⚠️ Fonnte belum aktif untuk ${config.BOX_ID}.`);
        return { skipped: true };
    }

    const target = normalizeTarget(userWA);
    if (!target) throw new Error('Nomor WhatsApp tidak valid');

    const greetingCaption = `Halo kak *${userName}*! ✨\nFoto photobox kamu udah siap nih 🥳\n\nMakasih yaa udah nyimpan kenangan bareng kita. Ditunggu kedatangannya lagi! 📸❤️`;

    const results = [];
    const attachmentOffset = Math.max(0, Number(options.attachmentOffset) || 0);

    for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index];
        const attachmentIndex = attachmentOffset + index;
        const caption = attachmentIndex === 0
            ? greetingCaption
            : `Foto ${attachmentIndex + 1}`;
        let sentResult = null;
        let lastError = null;

        for (let attempt = 1; attempt <= FILE_UPLOAD_RETRIES; attempt += 1) {
            try {
                sentResult = await sendFile(target, attachment, caption);
                logger.info('whatsapp_api_response', {
                    target,
                    filename: attachment.filename,
                    status: sentResult?.status,
                    id: sentResult?.id || sentResult?.message_id || null,
                    detail: sentResult?.reason || sentResult?.message || null
                });
                break;
            } catch (error) {
                lastError = error;
                console.log(
                    `[FONNTE] ${attachment.filename} gagal `
                    + `percobaan ${attempt}/${FILE_UPLOAD_RETRIES}: ${error.message}`
                );
                if (attempt < FILE_UPLOAD_RETRIES) {
                    await sleep(1000 * attempt);
                }
            }
        }

        if (sentResult) {
            const result = { filename: attachment.filename, queued: true, result: sentResult };
            results.push(result);
            console.log(`[FONNTE] File ${attachment.filename} diterima API Fonnte.`);
            logger.info('whatsapp_file_sent', { target, filename: attachment.filename });
            await options.onAttachmentResult?.(result);
        } else {
            const result = {
                filename: attachment.filename,
                queued: false,
                error: lastError?.message || 'Unggahan ditolak tanpa alasan'
            };
            results.push(result);
            console.log(`[FONNTE] File ${attachment.filename} tidak terkirim.`);
            logger.error('whatsapp_file_failed', { target, filename: attachment.filename, error: lastError?.message });
            await options.onAttachmentResult?.(result);
        }
        await sleep(config.FONNTE_REQUEST_DELAY_MS);
    }

    // Jika semua berkas foto gagal dikirim, kirim pesan teks sebagai fallback
    const anyFileSent = results.some(r => r.queued);
    if (!anyFileSent) {
        console.log('[FONNTE] Semua unggahan file gagal; mengirim pemberitahuan teks.');
        await sendText(target, greetingCaption);
        const details = results
            .map((item) => `${item.filename}: ${item.error}`)
            .join('; ');
        logger.error('whatsapp_all_files_failed', { target, details });
        throw new Error(`Semua file foto gagal dikirim. ${details}`);
    }

    return { skipped: false, target, results };
};

const sendWhatsappMsg = (userWA, userName, attachments, options = {}) => {
    if (!userWA || attachments.length === 0) return Promise.resolve({ skipped: true });
    if (config.WHATSAPP_PROVIDER === 'mimach') {
        return mimach.sendWhatsappMsg(userWA, userName, attachments, options);
    }
    if (!config.ENABLE_WHATSAPP || !config.FONNTE_TOKEN) {
        return sendWhatsappJob(userWA, userName, attachments, options);
    }

    return withResourceLock(
        `fonnte:${config.FONNTE_TOKEN}`,
        () => sendWhatsappJob(userWA, userName, attachments, options),
        {
            label: 'pengiriman Fonnte',
            timeoutMs: 300000,
            staleMs: 600000
        }
    );
};

module.exports = {
    sendWhatsappMsg,
    getWhatsappStatus
};
