const express = require('express');
const app = express();
const http = require('http').createServer(app);
const fs = require('fs-extra');

const config = require('./config/config');

const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e8
});
const socketHandler = require('./sockets/socketHandler');
const watcherService = require('./services/watcher');
const cameraService = require('./services/cameraService');
const dashboardClient = require('./services/dashboardClient');
const deviceAgent = require('./services/deviceAgent');
const whatsappOutbox = require('./services/whatsappOutbox');

fs.ensureDirSync(config.BASE_PHOTO_FOLDER);
fs.ensureDirSync(config.FRAMES_FOLDER);
app.use(express.json({ limit: '1mb' }));
app.use('/photos', express.static(config.BASE_PHOTO_FOLDER));
app.use('/frames', express.static(config.FRAMES_FOLDER));

app.get('/device-status', async (req, res) => {
    try { res.json(await deviceAgent.getStatus()); }
    catch (error) { res.status(500).json({ connected: false, error: error.message }); }
});

app.get('/whatsapp-outbox', (req, res) => {
    res.json(whatsappOutbox.getStatus());
});

app.post('/whatsapp-outbox/:jobId/retry', (req, res) => {
    try { res.json(whatsappOutbox.retry(req.params.jobId)); }
    catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/whatsapp-outbox/resend-folder', (req, res) => {
    try { res.json(whatsappOutbox.enqueueFolder(req.body || {})); }
    catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/device/apply-touch-mapping', async (req, res) => {
    try { res.json(await deviceAgent.applyTouchMapping()); }
    catch (error) { res.status(500).json({ applied: false, error: error.message }); }
});

// HALAMAN PREVIEW LIVEVIEW BROWSER (Sangat Enteng)
app.get('/preview', (req, res) => {
    res.send(`
        <html>
        <head><title>Photobox Live Preview</title></head>
        <body style="background:black; color:white; text-align:center; font-family:sans-serif; margin:0; padding:20px;">
            <h2 style="margin-top:0;">Kamera Live Preview (Linux Low-CPU)</h2>
            <img id="camPreview" src="/preview-frame" style="max-width:100%; max-height:80vh; border:2px solid white; border-radius:8px;" />
            <br/><br/>
            <p style="color:#aaa; font-size:12px;">Mode Hemat Baterai/CPU (Auto-refresh 300ms)</p>
            <script>
                setInterval(() => {
                    document.getElementById('camPreview').src = '/preview-frame?t=' + new Date().getTime();
                }, 300);
            </script>
        </body>
        </html>
    `);
});

app.get('/preview-frame', (req, res) => {
    cameraService.getSinglePreviewFrame(res);
});

socketHandler(io);
watcherService.initWatcher(io);
whatsappOutbox.start();

http.listen(config.PORT, config.HOST, () => {
    console.log(`================================================`);
    console.log(`🚀 ${config.BOX_ID} AKTIF DI ${config.HOST}:${config.PORT}`);
    console.log(`================================================`);
    dashboardClient.startHeartbeat();
});

let shuttingDown = false;
const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await cameraService.shutdown();
    http.close(() => process.exit(0));

    const forceExitTimer = setTimeout(() => process.exit(0), 4000);
    forceExitTimer.unref?.();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
