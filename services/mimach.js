const fs = require('fs-extra');
const path = require('path');
const config = require('../config/config');
const logger = require('./logger');
const { withResourceLock } = require('./resourceLock');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeTarget = (value) => {
    let target = String(value || '').replace(/\D/g, '');
    if (target.startsWith('0')) target = `62${target.slice(1)}`;
    if (target && !target.startsWith('62')) target = `62${target}`;
    return target;
};

const gatewayUrl = (pathname) => {
    const url = new URL(`${config.MIMACH_API_URL}${pathname}`);
    if (config.MIMACH_API_KEY) url.searchParams.set('key', config.MIMACH_API_KEY);
    return url;
};

const requestJson = async (pathname, body) => {
    const headers = { 'Content-Type': 'application/json' };
    // Mimamch source membaca key melalui query `key` atau header `key`.
    if (config.MIMACH_API_KEY) headers.key = config.MIMACH_API_KEY;
    const response = await fetch(gatewayUrl(pathname), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
    });
    const raw = await response.text();
    let payload = raw;
    try { payload = JSON.parse(raw); } catch (_) { /* plain text response */ }
    if (!response.ok) {
        const detail = typeof payload === 'object'
            ? payload.message || payload.error || payload.detail || JSON.stringify(payload)
            : payload;
        throw new Error(`Mimach HTTP ${response.status}: ${String(detail).slice(0, 500)}`);
    }
    return payload;
};

const mediaUrl = (filePath) => {
    const relative = path.relative(config.BASE_PHOTO_FOLDER, filePath)
        .split(path.sep)
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
    if (!relative || relative.startsWith('..')) {
        throw new Error(`Foto berada di luar BASE_PHOTO_FOLDER: ${filePath}`);
    }
    return `${config.MIMACH_MEDIA_BASE_URL}/${relative}`;
};

const sendAttachment = (target, attachment, caption, attachmentUrl) => {
    const common = {
        session: config.MIMACH_SESSION,
        to: target,
        text: caption || ' ',
        is_group: false
    };
    // Kirim JPG/PNG sebagai dokumen agar WhatsApp tidak mengompresi gambar.
    return requestJson('/message/send-document', {
        ...common,
        document_url: attachmentUrl,
        document_name: attachment.filename
    });
};

const sendWhatsappJob = async (userWA, userName, attachments, options = {}) => {
    if (!userWA || attachments.length === 0) return { skipped: true };
    if (!config.ENABLE_WHATSAPP || config.WHATSAPP_PROVIDER !== 'mimach') {
        return { skipped: true };
    }
    const target = normalizeTarget(userWA);
    if (!target) throw new Error('Nomor WhatsApp tidak valid');
    const greeting = `Halo kak *${userName}*! ✨\nFoto photobox kamu udah siap nih 🥳\n\nMakasih yaa udah nyimpan kenangan bareng kita. Ditunggu kedatangannya lagi! 📸❤️`;
    const results = [];
    const attachmentOffset = Math.max(0, Number(options.attachmentOffset) || 0);

    for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index];
        const attachmentIndex = attachmentOffset + index;
        const caption = attachmentIndex === 0 ? greeting : `Foto ${attachmentIndex + 1}`;
        let attachmentUrl = null;
        try {
            await fs.access(attachment.path);
            attachmentUrl = mediaUrl(attachment.path);
            const payload = await sendAttachment(target, attachment, caption, attachmentUrl);
            logger.info('mimach_api_response', {
                target,
                session: config.MIMACH_SESSION,
                filename: attachment.filename,
                media_url: attachmentUrl,
                send_mode: 'document',
                status: true,
                detail: typeof payload === 'object' ? payload.message || payload.detail || null : payload
            });
            logger.info('whatsapp_file_sent', {
                provider: 'mimach', target, filename: attachment.filename,
                send_mode: 'document'
            });
            const result = { filename: attachment.filename, queued: true, result: payload };
            results.push(result);
            await options.onAttachmentResult?.(result);
        } catch (error) {
            logger.error('whatsapp_file_failed', {
                provider: 'mimach',
                target,
                session: config.MIMACH_SESSION,
                filename: attachment.filename,
                media_url: attachmentUrl,
                send_mode: 'document',
                error: error.message
            });
            const result = { filename: attachment.filename, queued: false, error: error.message };
            results.push(result);
            await options.onAttachmentResult?.(result);
        }
        await sleep(config.MIMACH_REQUEST_DELAY_MS);
    }

    if (!results.some((item) => item.queued)) {
        throw new Error('Semua file gagal dikirim melalui Mimach');
    }
    return { skipped: false, target, results };
};

const sendWhatsappMsg = (userWA, userName, attachments, options = {}) => withResourceLock(
    `mimach:${config.MIMACH_API_URL}:${config.MIMACH_SESSION}`,
    () => sendWhatsappJob(userWA, userName, attachments, options),
    { label: 'pengiriman Mimach', timeoutMs: 300000, staleMs: 600000 }
);

const getWhatsappStatus = async () => {
    if (!config.ENABLE_WHATSAPP || config.WHATSAPP_PROVIDER !== 'mimach') {
        return { ok: false, message: 'Pengiriman WhatsApp dinonaktifkan' };
    }
    try {
        const response = await fetch(gatewayUrl('/session'), { signal: AbortSignal.timeout(5000) });
        const payload = response.ok ? await response.json() : null;
        const session = Array.isArray(payload?.data)
            ? payload.data.find((item) => item.session === config.MIMACH_SESSION)
            : null;
        const connected = session?.status === 'connected';
        return {
            ok: response.ok && connected,
            message: response.ok
                ? (connected
                    ? `Mimach terhubung (session ${config.MIMACH_SESSION})`
                    : `Mimach online, session ${config.MIMACH_SESSION} belum connected`)
                : `Mimach gateway HTTP ${response.status}`
        };
    } catch (error) {
        return { ok: false, message: `Mimach: ${error.message}` };
    }
};

module.exports = { sendWhatsappMsg, getWhatsappStatus };
