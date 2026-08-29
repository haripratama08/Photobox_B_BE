const { execFile } = require('child_process');
const config = require('../config/config');
const cameraService = require('./cameraService');
const whatsappOutbox = require('./whatsappOutbox');

let heartbeatTimer = null;
let liveViewBalanceTimer = null;
let liveViewActive = false;
let applyTargetFps = null;

const postJson = async (pathname, payload) => {
    const response = await fetch(`${config.DASHBOARD_URL}${pathname}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Photobox-Token': config.DASHBOARD_AGENT_TOKEN
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
};

const getPrinterStatus = () => new Promise((resolve) => {
    execFile('lpstat', ['-p', config.PRINTER_NAME], { timeout: 3000 }, (error, stdout) => {
        resolve(!error && stdout && !stdout.toLowerCase().includes('disabled')
            ? 'Online'
            : 'Offline');
    });
});

const reportCommandResult = (command, success, result) => postJson('/api/heartbeat/command-result', {
    box_id: config.BOX_ID,
    command_id: command.id,
    success,
    result
});

const processDashboardCommands = async (commands) => {
    for (const command of commands || []) {
        try {
            const payload = command.payload || {};
            if (command.type !== 'whatsapp_outbox_retry') {
                throw new Error(`Perintah dashboard tidak dikenal: ${command.type}`);
            }
            const result = whatsappOutbox.retry(payload.job_id);
            await reportCommandResult(command, true, result);
        } catch (error) {
            try {
                await reportCommandResult(command, false, { error: error.message });
            } catch (reportError) {
                console.log(`âš ï¸ Hasil perintah dashboard ${config.BOX_ID} gagal dilaporkan: ${reportError.message}`);
            }
        }
    }
};

const sendHeartbeat = async () => {
    const [camera, printerStatus] = await Promise.all([
        cameraService.getStatus(),
        getPrinterStatus()
    ]);

    const response = await postJson('/api/heartbeat', {
        box_id: config.BOX_ID,
        camera_status: camera.connected ? 'Online' : 'Offline',
        printer_status: printerStatus,
        launcher_pid: config.LAUNCHER_PID,
        whatsapp_outbox: whatsappOutbox.getStatus()
    });
    await processDashboardCommands(response.commands);
};

const startHeartbeat = () => {
    if (heartbeatTimer) return;

    const tick = () => {
        sendHeartbeat().catch((error) => {
            console.log(`⚠️ Dashboard heartbeat ${config.BOX_ID} gagal: ${error.message}`);
        });
    };

    tick();
    heartbeatTimer = setInterval(tick, config.HEARTBEAT_INTERVAL_MS);
};

const reportSession = (photosPrinted) => postJson('/api/session', {
    box_id: config.BOX_ID,
    photos_printed: Number(photosPrinted) || 1
});

const syncLiveViewBalance = async () => {
    const allocation = await postJson('/api/liveview', {
        box_id: config.BOX_ID,
        active: liveViewActive
    });

    if (liveViewActive && applyTargetFps) {
        applyTargetFps(allocation.target_fps, allocation.active_count);
    }
    return allocation;
};

const setLiveViewActive = (active, onTargetFps) => {
    liveViewActive = Boolean(active);
    if (onTargetFps) applyTargetFps = onTargetFps;

    if (liveViewBalanceTimer) {
        clearInterval(liveViewBalanceTimer);
        liveViewBalanceTimer = null;
    }

    syncLiveViewBalance().catch((error) => {
        if (liveViewActive && applyTargetFps) {
            applyTargetFps(config.LIVEVIEW_FALLBACK_FPS, 0);
        }
        console.log(`⚠️ Liveview balancer ${config.BOX_ID} gagal: ${error.message}`);
    });

    if (liveViewActive) {
        liveViewBalanceTimer = setInterval(() => {
            syncLiveViewBalance().catch((error) => {
                if (applyTargetFps) {
                    applyTargetFps(config.LIVEVIEW_FALLBACK_FPS, 0);
                }
                console.log(`⚠️ Liveview balancer ${config.BOX_ID} gagal: ${error.message}`);
            });
        }, config.LIVEVIEW_BALANCE_INTERVAL_MS);
    }
};

module.exports = {
    startHeartbeat,
    reportSession,
    setLiveViewActive
};
