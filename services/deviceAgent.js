const fs = require('fs-extra');
const { execFile } = require('child_process');
const config = require('../config/config');

const run = (command, args = [], timeout = 5000) => new Promise((resolve) => {
    execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout = '', stderr = '') => {
        resolve({ ok: !error, stdout, stderr, error });
    });
});

const readConfig = () => {
    try { return fs.readJsonSync(config.DEVICE_CONFIG_FILE); }
    catch (_) { return { version: 1, box_id: config.BOX_ID }; }
};

async function cameras() {
    const result = await run('gphoto2', ['--auto-detect']);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const devices = lines.filter((line) => /Canon|Nikon|Sony|Fuji|camera/i.test(line) && !/^Model\s+Port/i.test(line))
        .map((line) => {
            const match = line.match(/^(.*?)\s{2,}(usb:\S+)\s*$/i);
            return { model: (match?.[1] || line).trim(), port: match?.[2] || null, connected: true };
        });
    return { connected: devices.length > 0, devices };
}

async function printers() {
    const result = await run('lpstat', ['-e']);
    const queues = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const preferred = readConfig().printer?.queue || 'PHOTO_PRINTER';
    return { connected: queues.length > 0, preferred, queues, preferred_available: queues.includes(preferred) };
}

async function displays() {
    const result = await run('xrandr', ['--query']);
    const connectors = result.stdout.split(/\r?\n/).filter((line) => / connected(?: primary)?/.test(line))
        .map((line) => line.trim().split(/\s+/)[0]);
    return { connected: connectors.length > 0, connectors };
}

async function touchscreens() {
    const result = await run('xinput', ['list', '--short']);
    const devices = result.stdout.split(/\r?\n/).filter((line) => /touch|egalax|goodix|ilitek|quanta|silead|wch/i.test(line))
        .map((line) => ({ name: line.replace(/^.*?⎜?\s*/, '').replace(/\s+id=\d+.*$/, '').trim(), raw: line.trim() }));
    return { connected: devices.length > 0, devices };
}

async function getStatus() {
    const [camera, printer, display, touchscreen] = await Promise.all([
        cameras(), printers(), displays(), touchscreens()
    ]);
    const saved = readConfig();
    return {
        box_id: config.BOX_ID,
        config_file: config.DEVICE_CONFIG_FILE,
        camera, printer, display, touchscreen,
        mapping: {
            display_connector: saved.display?.connector || null,
            touchscreen_name: saved.touchscreen?.name || null,
            mapping_ready: Boolean(saved.display?.connector && saved.touchscreen?.name)
        },
        checked_at: new Date().toISOString()
    };
}

async function applyTouchMapping() {
    const saved = readConfig();
    const output = saved.display?.connector;
    const expected = saved.touchscreen?.name;
    if (!output || !expected) return { applied: false, reason: 'display.connector dan touchscreen.name belum dikonfigurasi' };
    const list = await run('xinput', ['list', '--short']);
    const line = list.stdout.split(/\r?\n/).find((item) => item.toLowerCase().includes(expected.toLowerCase()));
    const id = line?.match(/id=(\d+)/)?.[1];
    if (!id) return { applied: false, reason: `touchscreen '${expected}' tidak ditemukan` };
    const mapped = await run('xinput', ['map-to-output', id, output]);
    return { applied: mapped.ok, id, output, error: mapped.ok ? null : mapped.stderr.trim() };
}

module.exports = { getStatus, applyTouchMapping, readConfig };
