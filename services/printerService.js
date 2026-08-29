const { execFile } = require('child_process');
const net = require('net');
const config = require('../config/config');
const logger = require('./logger');

const run = (args) => new Promise((resolve) => {
    execFile('lpstat', args, { timeout: 5000, encoding: 'utf8' }, (error, stdout = '', stderr = '') => {
        resolve({ ok: !error, stdout, stderr });
    });
});

const runCommand = (command, args, timeout = 3000) => new Promise((resolve) => {
    execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout = '', stderr = '') => {
        resolve({ ok: !error, stdout, stderr });
    });
});

let cachedQueue = null;
let cachedAt = 0;
let discoveryInProgress = false;
let lastDiscoveryError = null;
let lastDiscoveryStartedAt = 0;

const deviceSettings = () => {
    try { return require('../config/devices.json').printer || {}; }
    catch (_) { return {}; }
};

const socketTarget = (uri) => {
    const match = String(uri || '').match(/^socket:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/i);
    return match ? { host: match[1], port: Number(match[2]) } : null;
};

const probeSocket = (host, port, timeoutMs = 450) => new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
});

const macForHost = async (host) => {
    const ipNeighbour = await runCommand('ip', ['neigh', 'show', 'to', host]);
    const fromIp = ipNeighbour.stdout.match(/lladdr\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i)?.[1];
    if (fromIp) return fromIp.toLowerCase();
    const arp = await runCommand('arp', ['-n', host]);
    return arp.stdout.match(/(?:at|ether)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i)?.[1]?.toLowerCase() || null;
};

async function scanJetDirectSubnet(unreachableUri) {
    const target = socketTarget(unreachableUri);
    if (!target || target.port !== 9100) return null;
    const octets = target.host.split('.');
    const prefix = octets.slice(0, 3).join('.');
    const expectedMac = String(deviceSettings().mac_address || '').toLowerCase();
    // Urut dari .1 ke .254 supaya hasil mudah diprediksi dan tidak membebani
    // jaringan outlet. Scanner berhenti segera setelah Epson yang tepat ditemukan.
    for (let last = 1; last <= 254; last += 1) {
        const host = `${prefix}.${last}`;
        if (host === target.host || !await probeSocket(host, 9100, config.PRINTER_SCAN_TIMEOUT_MS)) continue;
        const mac = await macForHost(host);
        if (!expectedMac || mac === expectedMac) {
            const uri = `socket://${host}:9100`;
            logger.info('printer_port_9100_found', { subnet: `${prefix}.0/24`, uri, mac });
            return uri;
        }
        logger.warn('printer_port_9100_ignored', { host, mac, reason: 'MAC tidak cocok' });
    }
    logger.warn('printer_port_9100_not_found', { subnet: `${prefix}.0/24` });
    return null;
}

function startBackgroundDiscovery(queue, currentUri) {
    if (discoveryInProgress || Date.now() - lastDiscoveryStartedAt < config.PRINTER_SCAN_RETRY_MS) return false;
    discoveryInProgress = true;
    lastDiscoveryStartedAt = Date.now();
    lastDiscoveryError = null;
    (async () => {
        let discoveredUri = await discoverDeviceUri();
        if (discoveredUri && socketTarget(discoveredUri)) {
            const discoveredSocket = socketTarget(discoveredUri);
            if (!await probeSocket(discoveredSocket.host, discoveredSocket.port)) discoveredUri = null;
        }
        if (!discoveredUri) discoveredUri = await scanJetDirectSubnet(currentUri);
        if (!discoveredUri) throw new Error('Epson tidak ditemukan pada port 9100');
        if (!config.PRINTER_AUTO_REBIND) return;
        if (!await updateQueueUri(queue, discoveredUri)) {
            throw new Error('URI Epson ditemukan, tetapi queue CUPS tidak dapat diperbarui');
        }
        cachedAt = 0;
    })().catch((error) => {
        lastDiscoveryError = error.message;
        logger.warn('printer_discovery_failed', { queue, error: error.message });
    }).finally(() => {
        discoveryInProgress = false;
    });
    return true;
}

async function discoverDeviceUri() {
    const result = await new Promise((resolve) => {
        execFile('lpinfo', ['-v'], { timeout: 8000, encoding: 'utf8' }, (error, stdout = '', stderr = '') =>
            resolve({ ok: !error, stdout, stderr }));
    });
    const devices = result.stdout.split(/\r?\n/)
        .map((line) => line.match(/^\s*(?:direct|network|serial|file)\s+(.+)$/i)?.[1]?.trim())
        .filter(Boolean);
    const saved = deviceSettings();
    const requested = String(saved.device_uri || '').trim();
    const modelHint = String(saved.preferred_make_model || '').trim();
    const matchHint = modelHint
        ? new RegExp(modelHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        : /epson|l8050|photo/i;
    const uri = devices.find((value) => value === requested)
        || devices.find((value) => matchHint.test(value))
        || (devices.length === 1 ? devices[0] : null);
    logger.info('printer_discovery', { uri, devices });
    return uri;
}

async function updateQueueUri(queue, uri) {
    if (!queue || !uri) return false;
    const args = ['-p', queue, '-v', uri, '-E'];
    let result = await runCommand('lpadmin', args, 10000);
    // `sudo -n` tidak pernah meminta password atau membuat aplikasi berhenti;
    // ia hanya berhasil bila aturan sudo sekali-pasang sudah diberikan operator.
    if (!result.ok && config.PRINTER_USE_SUDO) {
        result = await runCommand('sudo', ['-n', 'lpadmin', ...args], 10000);
    }
    if (result.ok) logger.info('printer_uri_updated', { queue, uri });
    else logger.warn('printer_uri_update_failed', { queue, uri, error: result.stderr || result.error?.message });
    return result.ok;
}

async function queueUri(queue) {
    const result = await run(['-v', queue]);
    return result.stdout.match(/device for \S+:\s*(.+)\s*$/im)?.[1]?.trim() || null;
}

async function resolveQueue(force = false) {
    if (!force && cachedQueue && Date.now() - cachedAt < 30000) return cachedQueue;
    const printers = await run(['-p']);
    const queues = printers.stdout.split(/\r?\n/)
        .map((line) => line.match(/^printer\s+(\S+)\s+/i)?.[1])
        .filter(Boolean);
    const configured = config.PRINTER_NAME;
    const savedQueue = deviceSettings().queue;
    const preferred = [configured, savedQueue, 'PHOTO_PRINTER']
        .filter(Boolean)
        .find((name) => queues.includes(name));
    // lpstat -v is intentionally queried here as a diagnostic source; the
    // actual print queue must already exist in CUPS so its URI/IP stays managed
    // by CUPS rather than being hardcoded in the application.
    // lpstat -v does not always expose a queue in the same order as -p;
    // prefer an existing queue whose name identifies Epson/L8050.
    const namedEpson = queues.find((name) => /epson|l8050|photo_printer/i.test(name));
    // Jangan memilih antrean pertama bila beberapa printer aktif: itu dapat
    // mengirim hasil photobox ke printer yang salah. Fallback aman hanya
    // ketika CUPS memang memiliki satu antrean saja.
    cachedQueue = preferred || namedEpson || (queues.length === 1 ? queues[0] : null);
    cachedAt = Date.now();
    logger.info('printer_resolved', { queue: cachedQueue, configured, queues });
    return cachedQueue;
}

async function status() {
    const queue = await resolveQueue();
    if (!queue) return { ok: false, queue: null, message: 'Tidak ada queue printer CUPS' };
    const uri = await queueUri(queue);
    const target = socketTarget(uri);
    if (target && !await probeSocket(target.host, target.port)) {
        const searching = startBackgroundDiscovery(queue, uri) || discoveryInProgress;
        return {
            ok: false,
            queue,
            searching,
            message: searching
                ? 'Printer belum siap, sedang mencari Epson di port 9100...'
                : `Printer belum siap${lastDiscoveryError ? `: ${lastDiscoveryError}` : ''}`
        };
    }
    const result = await run(['-p', queue]);
    const ok = result.ok && result.stdout.toLowerCase().includes('printer');
    return { ok, queue, searching: false, message: ok ? `Printer ${queue} siap` : `Printer ${queue} tidak siap` };
}

module.exports = { resolveQueue, status };
