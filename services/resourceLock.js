const crypto = require('crypto');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const LOCK_ROOT = path.join(os.tmpdir(), 'photobox-resource-locks');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lockPathFor = (resourceId) => {
    const digest = crypto
        .createHash('sha256')
        .update(String(resourceId))
        .digest('hex');
    return path.join(LOCK_ROOT, digest);
};

const acquireResourceLock = async (resourceId, options = {}) => {
    const timeoutMs = Number(options.timeoutMs || 300000);
    const staleMs = Number(options.staleMs || 600000);
    const retryMs = Number(options.retryMs || 150);
    const label = options.label || 'resource';
    const deadline = Date.now() + timeoutMs;
    const lockPath = lockPathFor(resourceId);

    await fs.ensureDir(LOCK_ROOT);

    while (Date.now() < deadline) {
        try {
            await fs.mkdir(lockPath);
            await fs.writeJson(path.join(lockPath, 'owner.json'), {
                pid: process.pid,
                label,
                acquired_at: new Date().toISOString()
            });

            const heartbeat = setInterval(() => {
                const now = new Date();
                fs.utimes(lockPath, now, now).catch(() => {});
            }, Math.min(30000, Math.max(5000, Math.floor(staleMs / 3))));
            heartbeat.unref?.();

            console.log(`🔒 Antrean ${label} diperoleh oleh PID ${process.pid}.`);
            return async () => {
                clearInterval(heartbeat);
                await fs.remove(lockPath).catch(() => {});
                console.log(`🔓 Antrean ${label} dilepas oleh PID ${process.pid}.`);
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;

            try {
                const stats = await fs.stat(lockPath);
                if (Date.now() - stats.mtimeMs > staleMs) {
                    await fs.remove(lockPath);
                    continue;
                }
            } catch (_) {
                continue;
            }
            await sleep(retryMs);
        }
    }

    throw new Error(`Timeout menunggu antrean ${label}`);
};

const withResourceLock = async (resourceId, operation, options = {}) => {
    const release = await acquireResourceLock(resourceId, options);
    try {
        return await operation();
    } finally {
        await release();
    }
};

module.exports = {
    acquireResourceLock,
    withResourceLock
};
