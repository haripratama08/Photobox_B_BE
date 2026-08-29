const { execFile, spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config/config');
const nativeCameraAgent = require('./nativeCameraAgent');

let isLiveViewActive = false;
let cameraConnected = false;
let currentIso = "Auto";
let currentShutter = "Auto";
let targetLiveViewFps = Math.max(1, Math.min(120, config.LIVEVIEW_TARGET_FPS));
let liveViewGeneration = 0;

const cameraArgs = (args) => {
    if (!config.CAMERA_PORT) return args;
    return ['--port', config.CAMERA_PORT, ...args];
};

const runGphoto = (args, options, callback) => {
    execFile('gphoto2', cameraArgs(args), options, callback);
};

const delay = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

const runGphotoPromise = (args, options = {}) => new Promise((resolve, reject) => {
    runGphoto(args, options, (error, stdout, stderr) => {
        if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            return reject(error);
        }
        resolve({ stdout, stderr });
    });
});

const releaseDesktopCameraClaim = async () => {
    if (process.platform === 'win32') return;

    // Desktop Linux sering memasang kamera otomatis melalui GVFS tepat setelah
    // sesi gphoto2 ditutup. Hentikan hanya backend kamera GVFS milik user ini.
    await Promise.all([
        'gvfsd-gphoto2',
        'gvfs-gphoto2-volume-monitor'
    ].map((processName) => new Promise((resolve) => {
        execFile('pkill', ['-f', processName], { timeout: 3000 }, () => resolve());
    })));
};

const isPtpSessionError = (value) => /ptp general|unspecified error|galat \(-1|i\/o error|no camera found|tak ada kamera|could not claim|device or resource busy|ptp device busy/i
    .test(String(value || ''));

let cameraRecoveryPromise = null;
let lastCameraResetAt = 0;

const detectCamera = () => new Promise((resolve) => {
    // Nomor bus dapat berubah setelah USB reset, jadi jangan gunakan CAMERA_PORT.
    execFile('gphoto2', ['--auto-detect'], { timeout: 5000 }, (error, stdout) => {
        resolve(!error && /Canon|EOS/i.test(stdout || ''));
    });
});

const resetCameraUsb = async (reason) => {
    if (process.platform === 'win32') return false;
    if (cameraRecoveryPromise) return cameraRecoveryPromise;

    const elapsed = Date.now() - lastCameraResetAt;
    if (elapsed < config.CAMERA_RESET_COOLDOWN_MS) {
        await delay(Math.min(2000, config.CAMERA_RESET_COOLDOWN_MS - elapsed));
        return false;
    }

    lastCameraResetAt = Date.now();
    cameraRecoveryPromise = (async () => {
        console.log(`🔄 [LINUX CAMERA] Pemulihan USB otomatis: ${reason}`);
        await nativeCameraAgent.stop();
        await releaseDesktopCameraClaim();

        // USB reset dari libgphoto2 menggantikan cabut-pasang pada sisi host.
        // Exit code diabaikan karena perangkat dapat hilang sesaat saat reset sukses.
        await new Promise((resolve) => {
            execFile('gphoto2', ['--reset'], { timeout: 10000 }, () => resolve());
        });
        await delay(config.CAMERA_RESET_SETTLE_MS);

        for (let attempt = 1; attempt <= 6; attempt += 1) {
            await releaseDesktopCameraClaim();
            if (await detectCamera()) {
                cameraConnected = true;
                console.log('✅ [LINUX CAMERA] Kamera pulih tanpa cabut kabel.');
                return true;
            }
            await delay(1500);
        }

        cameraConnected = false;
        console.log('⚠️ [LINUX CAMERA] Kamera belum muncul; pemantauan otomatis tetap berjalan.');
        return false;
    })().finally(() => {
        cameraRecoveryPromise = null;
    });

    return cameraRecoveryPromise;
};

/**
 * Layanan Kamera Linux Natif (Tanpa DigiCamControl)
 * Menggunakan command CLI gphoto2 / v4l2 agar super enteng, cepat, dan hemat resource RAM/CPU di Linux.
 */
async function getStatus() {
    // Jangan menjalankan `gphoto2 --summary` ketika LiveView sedang aktif.
    // Perintah status bersamaan dengan capture-preview sering memicu PTP General Error.
    if (isCameraBusy || isCapturingFrame || isLiveViewActive) {
        return {
            connected: cameraConnected,
            model: cameraConnected
                ? `🟢 Kamera ${config.BOX_ID} sedang digunakan`
                : `🔴 Kamera ${config.BOX_ID} tidak terdeteksi`
        };
    }

    if (nativeCameraAgent.enabled) {
        if (!nativeCameraAgent.available) {
            cameraConnected = false;
            return {
                connected: false,
                model: '🔴 Camera Agent belum dibangun'
            };
        }
        try {
            await releaseDesktopCameraClaim();
            await nativeCameraAgent.ping();
            cameraConnected = true;
            return {
                connected: true,
                model: `🟢 Kamera ${config.BOX_ID} terhubung melalui Camera Agent`
            };
        } catch (error) {
            cameraConnected = false;
            resetCameraUsb('inisialisasi Camera Agent gagal').catch(() => {});
            return {
                connected: false,
                model: `🟡 Camera Agent sedang memulihkan ${config.BOX_ID}`
            };
        }
    }

    return new Promise((resolve) => {
        // Health check tidak boleh memakai --summary karena membuka sesi PTP
        // baru dan dapat mengunci Canon saat worker kamera sedang aktif.
        runGphoto(['--auto-detect'], { timeout: 5000 }, (error, stdout) => {
            if (!error && stdout && /Canon|EOS/i.test(stdout)) {
                cameraConnected = true;
                return resolve({
                    connected: true,
                    model: `🟢 Kamera ${config.BOX_ID} terhubung`
                });
            }
            
            if (fs.existsSync(config.VIDEO_DEVICE)) {
                cameraConnected = true;
                return resolve({
                    connected: true,
                    model: `🟢 Kamera video ${config.VIDEO_DEVICE} terhubung`
                });
            }

            cameraConnected = false;
            resolve({
                connected: false,
                model: `🔴 Kamera ${config.BOX_ID} tidak terdeteksi`
            });
        });
    });
}

// --- SISTEM MUTEX LOCK ---
let isCameraBusy = false;
let isCapturingFrame = false; // Status untuk loop LiveView
let captureInProgress = false; // Mencegah double-tap/dua request memicu dua jepretan
let globalOnFrameCallback = null; // Menyimpan callback LiveView
let liveViewProcess = null;
let liveViewRestartTimer = null;
let liveViewRestartAttempt = 0;
let liveViewFrameBuffer = Buffer.alloc(0);
let latestLiveViewFrame = null;
let lastFrameEmittedAt = 0;
let liveViewMode = config.LIVEVIEW_MODE;
let liveViewUsesShell = false;
let lastCaptureRequestAt = 0;
let cameraAgentMissingLogged = false;

const MAX_LIVEVIEW_BUFFER_BYTES = 8 * 1024 * 1024;

const clearLiveViewRestartTimer = () => {
    if (liveViewRestartTimer) {
        clearTimeout(liveViewRestartTimer);
        liveViewRestartTimer = null;
    }
};

const stopLiveViewTransport = () => {
    clearLiveViewRestartTimer();
    liveViewFrameBuffer = Buffer.alloc(0);

    const child = liveViewProcess;
    liveViewProcess = null;
    if (!child || child.exitCode !== null) {
        isCapturingFrame = false;
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let finished = false;
        let terminateTimer = null;
        let forceStopTimer = null;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (terminateTimer) clearTimeout(terminateTimer);
            if (forceStopTimer) clearTimeout(forceStopTimer);
            isCapturingFrame = false;
            liveViewUsesShell = false;
            resolve();
        };

        child.once('close', finish);
        if (liveViewUsesShell && child.stdin?.writable) {
            child.stdin.write('exit\n');
        } else {
            // gphoto2 mendokumentasikan Ctrl+C untuk mengakhiri capture-movie.
            // SIGINT memberi driver kesempatan mengirim EndLiveView dan melepas USB.
            child.kill('SIGINT');
        }

        terminateTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGTERM');
        }, 3000);
        terminateTimer.unref?.();

        forceStopTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            finish();
        }, 5000);
        forceStopTimer.unref?.();
    });
};

/**
 * Mengambil foto dari kamera dan menyimpannya di folder target.
 * Saat foto disimpan ke folder utama, watcher.js akan mendeteksi dan mengompresnya secara otomatis.
 */
async function capturePhoto(targetFolder) {
    const now = Date.now();
    if (now - lastCaptureRequestAt < config.CAPTURE_DEBOUNCE_MS) {
        console.log('⚠️ [LINUX CAMERA] Permintaan foto ganda diabaikan.');
        return null;
    }
    lastCaptureRequestAt = now;

    if (captureInProgress || isCameraBusy) {
        console.log('⚠️ [LINUX CAMERA] Permintaan foto diabaikan: kamera masih sibuk.');
        return null;
    }
    captureInProgress = true;
    const shouldResumeLiveView = isLiveViewActive;
    isCameraBusy = true;

    fs.ensureDirSync(targetFolder);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `photo_linux_${timestamp}.jpg`;
    const filePath = path.join(targetFolder, filename);
    let captureError = null;

    try {
        await stopLiveViewTransport();

        if (nativeCameraAgent.enabled) {
            if (!nativeCameraAgent.available) {
                console.log('⚠️ [CAMERA AGENT] Foto dibatalkan: binary agent belum dibangun.');
                return null;
            }
            console.log('📸 [CAMERA AGENT] Mengeksekusi pengambilan foto pada sesi persisten...');
            try {
                await nativeCameraAgent.capture(filePath);
            } catch (error) {
                try {
                    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1024) {
                        console.log(`✅ [CAMERA AGENT] Foto sudah tersimpan: ${filename}`);
                        return filePath;
                    }
                } catch (_) {}

                console.log('⚠️ [CAMERA AGENT] Koneksi terputus saat foto; memulihkan otomatis.');
                await resetCameraUsb('Camera Agent gagal mengambil foto');
                return null;
            }

            console.log(`✅ [CAMERA AGENT] Sukses jepret & unduh foto: ${filename}`);
            return filePath;
        }

        await releaseDesktopCameraClaim();
        await delay(900);

        console.log('📸 [LINUX CAMERA] (LOCK AKTIF) Mengeksekusi pengambilan foto utama...');
        const captureArgs = [
            '--capture-image-and-download',
            '--filename', filePath,
            '--force-overwrite'
        ];

        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                await runGphotoPromise(captureArgs, { timeout: 30000 });
                captureError = null;
                break;
            } catch (error) {
                captureError = error;
                try {
                    // Beberapa Canon mengembalikan galat setelah file sebenarnya
                    // sudah selesai diunduh. Anggap sukses agar shutter tidak dipicu lagi.
                    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1024) {
                        captureError = null;
                        break;
                    }
                } catch (_) {}

                const errorText = `${error.message}\n${error.stderr || ''}`;
                const cameraClaimed = /could not claim|device or resource busy|ptp device busy|no camera found|tak ada kamera/i
                    .test(errorText);
                if (!cameraClaimed || attempt === 3) {
                    // PTP General/Unspecified bisa muncul sesudah shutter bekerja.
                    // Jangan retry karena dapat menghasilkan jepretan ganda.
                    if (isPtpSessionError(errorText)) {
                        await resetCameraUsb('sesi PTP gagal saat mengambil foto');
                    }
                    break;
                }

                console.log(`⏳ [LINUX CAMERA] USB masih dipakai proses lain; retry ${attempt}/3...`);
                await releaseDesktopCameraClaim();
                if (attempt >= 2) {
                    await resetCameraUsb('USB tetap sibuk sebelum shutter');
                }
                await delay(1000 * attempt);
            }
        }

        if (captureError) {
            console.log('❌ [LINUX CAMERA] Error saat menjepret:', captureError.message);
            return null;
        }

        console.log(`✅ [LINUX CAMERA] Sukses jepret & unduh foto: ${filename}`);
        return filePath;
    } finally {
        isCameraBusy = false;
        captureInProgress = false;

        if (shouldResumeLiveView && isLiveViewActive && globalOnFrameCallback) {
            console.log('📸 [LINUX CAMERA] Melanjutkan LiveView kembali...');
            scheduleLiveViewStart(2000, liveViewGeneration);
        }
    }
}

async function runCameraControl(args, fallbackArgs = null) {
    if (captureInProgress || isCameraBusy) return;

    isCameraBusy = true;
    const shouldResumeLiveView = isLiveViewActive;
    await stopLiveViewTransport();

    if (nativeCameraAgent.enabled) {
        if (!nativeCameraAgent.available) {
            console.log('⚠️ [CAMERA AGENT] Kontrol dibatalkan: binary agent belum dibangun.');
            isCameraBusy = false;
            return;
        }
        const applyArgs = async (selectedArgs) => {
            const assignment = selectedArgs?.[1] || '';
            const separator = assignment.indexOf('=');
            if (selectedArgs?.[0] !== '--set-config' || separator <= 0) {
                throw new Error('Perintah Camera Agent tidak didukung.');
            }
            return nativeCameraAgent.setConfig(
                assignment.slice(0, separator),
                assignment.slice(separator + 1)
            );
        };

        try {
            await applyArgs(args);
        } catch (error) {
            if (fallbackArgs) {
                try {
                    await applyArgs(fallbackArgs);
                } catch (_) {}
            }
        } finally {
            isCameraBusy = false;
            if (shouldResumeLiveView && isLiveViewActive && globalOnFrameCallback) {
                scheduleLiveViewStart(500, liveViewGeneration);
            }
        }
        return;
    }

    await releaseDesktopCameraClaim();
    await delay(600);

    await new Promise((resolve) => {
        runGphoto(args, { timeout: 10000 }, (error) => {
            if (error && fallbackArgs) {
                return runGphoto(fallbackArgs, { timeout: 10000 }, () => resolve());
            }
            resolve();
        });
    });

    isCameraBusy = false;
    if (shouldResumeLiveView && isLiveViewActive && globalOnFrameCallback) {
        scheduleLiveViewStart(1200, liveViewGeneration);
    }
}

function autoFocus() {
    console.log(`🎯 [LINUX CAMERA] Memicu Auto-Focus kamera...`);
    runCameraControl(
        ['--set-config', 'autofocusdrive=1'],
        ['--set-config', 'autofocus=1']
    ).catch(() => {});
}

function setIso(val) {
    currentIso = val;
    console.log(`⚙️ [LINUX CAMERA] Set ISO ke: ${val}`);
    runCameraControl(['--set-config', `iso=${val}`]).catch(() => {});
}

function setShutter(val) {
    currentShutter = val;
    console.log(`⚙️ [LINUX CAMERA] Set Shutter Speed ke: ${val}`);
    runCameraControl(['--set-config', `shutterspeed=${val}`]).catch(() => {});
}

function emitJpegFrames(data, onFrameCallback) {
    liveViewFrameBuffer = Buffer.concat([liveViewFrameBuffer, data]);
    let emittedFrames = 0;

    while (liveViewFrameBuffer.length > 0) {
        const start = liveViewFrameBuffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) {
            liveViewFrameBuffer = liveViewFrameBuffer.subarray(
                Math.max(0, liveViewFrameBuffer.length - 1)
            );
            return emittedFrames;
        }

        const end = liveViewFrameBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end < 0) {
            liveViewFrameBuffer = liveViewFrameBuffer.subarray(start);
            if (liveViewFrameBuffer.length > MAX_LIVEVIEW_BUFFER_BYTES) {
                liveViewFrameBuffer = Buffer.alloc(0);
            }
            return emittedFrames;
        }

        const frame = Buffer.from(liveViewFrameBuffer.subarray(start, end + 2));
        liveViewFrameBuffer = liveViewFrameBuffer.subarray(end + 2);
        latestLiveViewFrame = frame;
        cameraConnected = true;
        liveViewRestartAttempt = 0;

        const minimumFrameInterval = Math.round(1000 / targetLiveViewFps);
        if (Date.now() - lastFrameEmittedAt >= minimumFrameInterval) {
            lastFrameEmittedAt = Date.now();
            onFrameCallback(frame.toString('base64'));
            emittedFrames += 1;
        }
    }
    return emittedFrames;
}

function startGphotoMovieStream(onFrameCallback, generation) {
    if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;
    if (liveViewProcess && liveViewProcess.exitCode === null) return;

    liveViewFrameBuffer = Buffer.alloc(0);
    lastFrameEmittedAt = 0;
    const child = spawn(
        'gphoto2',
        cameraArgs([
            '--set-config', 'viewfinder=1',
            '--capture-movie',
            '--stdout'
        ]),
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    liveViewProcess = child;
    isCapturingFrame = true;
    let stderrText = '';
    let receivedFrame = false;

    child.stdout.on('data', (data) => {
        if (isLiveViewActive && !isCameraBusy && generation === liveViewGeneration) {
            if (data.indexOf(Buffer.from([0xff, 0xd8])) >= 0) receivedFrame = true;
            emitJpegFrames(data, onFrameCallback);
        }
    });

    child.stderr.on('data', (data) => {
        stderrText = `${stderrText}${data.toString()}`.slice(-4000);
    });

    child.on('error', (error) => {
        stderrText = error.message;
    });

    child.on('close', (code, signal) => {
        if (liveViewProcess === child) liveViewProcess = null;
        isCapturingFrame = false;
        if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;

        if (!receivedFrame && /0\s*(frame|bingkai)|movie capture error|galat menangkap film/i.test(stderrText)) {
            liveViewMode = 'preview';
            liveViewRestartAttempt = 0;
            console.log('🔄 [LINUX CAMERA] capture-movie tidak didukung; beralih ke mode capture-preview aman.');
            scheduleLiveViewStart(1500, generation);
            return;
        }

        liveViewRestartAttempt += 1;
        const retryDelay = Math.min(15000, 2000 * liveViewRestartAttempt);
        const reason = stderrText.trim().split(/\r?\n/).slice(-2).join(' ')
            || `exit=${code || signal}`;
        console.log(`⚠️ [LINUX CAMERA] LiveView terputus: ${reason}`);
        if (/0\s*(frame|bingkai)|movie capture error|galat menangkap film/i.test(stderrText)) {
            console.log('🎥 [LINUX CAMERA] Canon EOS harus berada pada mode Movie/Video untuk LiveView USB.');
        }
        console.log(`⏳ [LINUX CAMERA] Mencoba lagi dalam ${retryDelay / 1000} detik...`);
        scheduleLiveViewStart(retryDelay, generation);
    });
}

function startGphotoPreviewShell(onFrameCallback, generation) {
    if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;
    if (liveViewProcess && liveViewProcess.exitCode === null) return;

    isCapturingFrame = true;
    liveViewFrameBuffer = Buffer.alloc(0);
    let stderrText = '';
    let stdoutText = '';
    let requestTimer = null;
    let requestWatchdog = null;
    let filePollTimer = null;
    let sessionFailed = false;
    let sessionFailureReason = '';
    let failureStopTimer = null;
    const previewFile = config.PREVIEW_FILE;
    const thumbFile = path.join(
        path.dirname(previewFile),
        `thumb_${path.basename(previewFile)}`
    );
    const shellDefaultPreviewFile = path.join(path.dirname(previewFile), 'capture_preview.jpg');
    const shellDefaultThumbPreviewFile = path.join(
        path.dirname(previewFile),
        'thumb_capture_preview.jpg'
    );

    const child = spawn(
        'gphoto2',
        cameraArgs([
            '--filename', path.basename(previewFile),
            '--force-overwrite',
            '--shell'
        ]),
        {
            cwd: path.dirname(previewFile),
            stdio: ['pipe', 'pipe', 'pipe']
        }
    );
    liveViewProcess = child;
    liveViewUsesShell = true;

    const failSession = (reason) => {
        if (sessionFailed || child.exitCode !== null) return;
        sessionFailed = true;
        sessionFailureReason = reason;
        if (requestTimer) clearTimeout(requestTimer);
        if (requestWatchdog) clearTimeout(requestWatchdog);
        if (filePollTimer) clearTimeout(filePollTimer);

        // Tutup shell secara normal agar libgphoto2 sempat mengakhiri sesi PTP.
        if (child.stdin.writable) child.stdin.write('exit\n');
        failureStopTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGTERM');
        }, 1500);
        failureStopTimer.unref?.();
    };

    const requestFrame = () => {
        if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;
        if (liveViewProcess !== child || child.exitCode !== null || !child.stdin.writable) return;

        try {
            fs.removeSync(previewFile);
            fs.removeSync(thumbFile);
            fs.removeSync(shellDefaultPreviewFile);
            fs.removeSync(shellDefaultThumbPreviewFile);
        } catch (_) {}

        child.stdin.write('capture-preview\n');
        if (requestWatchdog) clearTimeout(requestWatchdog);
        const pollForFrame = () => {
            if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;
            const framePath = [
                thumbFile,
                previewFile,
                shellDefaultThumbPreviewFile,
                shellDefaultPreviewFile
            ]
                .find(candidate => fs.existsSync(candidate)) || null;

            if (framePath) {
                try {
                    const frame = fs.readFileSync(framePath);
                    if (frame.length > 100) {
                        latestLiveViewFrame = frame;
                        cameraConnected = true;
                        liveViewRestartAttempt = 0;
                        if (requestWatchdog) clearTimeout(requestWatchdog);
                        onFrameCallback(frame.toString('base64'));
                        const frameDelay = Math.max(8, Math.round(1000 / targetLiveViewFps));
                        requestTimer = setTimeout(requestFrame, frameDelay);
                        requestTimer.unref?.();
                        return;
                    }
                } catch (_) {}
            }
            filePollTimer = setTimeout(pollForFrame, 100);
            filePollTimer.unref?.();
        };
        filePollTimer = setTimeout(pollForFrame, 100);
        filePollTimer.unref?.();

        requestWatchdog = setTimeout(() => {
            if (filePollTimer) clearTimeout(filePollTimer);
            console.log('⚠️ [LINUX CAMERA] Preview macet; menjalankan pemulihan otomatis.');
            failSession('preview tidak menghasilkan frame');
        }, config.LIVEVIEW_FRAME_TIMEOUT_MS);
        requestWatchdog.unref?.();
    };

    child.stdout.on('data', (data) => {
        const text = data.toString();
        stdoutText = `${stdoutText}${text}`.slice(-4000);
        if (isPtpSessionError(text)) failSession(text.trim());
    });

    child.stderr.on('data', (data) => {
        const text = data.toString();
        stderrText = `${stderrText}${text}`.slice(-4000);
        if (isPtpSessionError(text)) failSession(text.trim());
    });

    child.on('error', (error) => {
        stderrText = error.message;
    });

    child.on('close', (code, signal) => {
        if (requestTimer) clearTimeout(requestTimer);
        if (requestWatchdog) clearTimeout(requestWatchdog);
        if (filePollTimer) clearTimeout(filePollTimer);
        if (failureStopTimer) clearTimeout(failureStopTimer);
        if (liveViewProcess === child) liveViewProcess = null;
        isCapturingFrame = false;
        liveViewUsesShell = false;
        if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;

        liveViewRestartAttempt += 1;
        const retryDelay = Math.min(15000, 2000 * liveViewRestartAttempt);
        const reason = `${stderrText}\n${stdoutText}`.trim().split(/\r?\n/).slice(-2).join(' ')
            || `exit=${code || signal}`;
        console.log(`⚠️ [LINUX CAMERA] Sesi preview berhenti: ${reason}`);

        if (sessionFailed || isPtpSessionError(reason)) {
            resetCameraUsb(sessionFailureReason || reason)
                .then((recovered) => {
                    if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;
                    scheduleLiveViewStart(recovered ? 1200 : 15000, generation);
                })
                .catch(() => {
                    if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;
                    scheduleLiveViewStart(15000, generation);
                });
            return;
        }

        scheduleLiveViewStart(retryDelay, generation);
    });

    // Shell mempertahankan satu Camera object/libgphoto2 session. capture-preview
    // mengaktifkan EVF sendiri; perubahan capturetarget/viewfinder justru dapat
    // membuat sesi PTP EOS 700D ini macet.
    setTimeout(() => {
        if (liveViewProcess !== child || !child.stdin.writable) return;
        requestTimer = setTimeout(requestFrame, 300);
        requestTimer.unref?.();
    }, 300);
}

async function captureNativeAgentFrame(onFrameCallback, generation) {
    if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;
    if (isCapturingFrame) return;

    isCapturingFrame = true;
    const cycleStartedAt = Date.now();
    const previewFile = config.PREVIEW_FILE;
    let recoveryDelay = null;
    try {
        fs.ensureDirSync(path.dirname(previewFile));
        fs.removeSync(previewFile);
        await nativeCameraAgent.preview(previewFile);
        const frame = fs.readFileSync(previewFile);
        if (frame.length <= 100) throw new Error('Frame preview kosong.');

        latestLiveViewFrame = frame;
        cameraConnected = true;
        liveViewRestartAttempt = 0;
        if (isLiveViewActive && !isCameraBusy && generation === liveViewGeneration) {
            onFrameCallback(frame.toString('base64'));
        }
    } catch (error) {
        cameraConnected = false;
        console.log('⚠️ [CAMERA AGENT] Preview terputus; memulihkan otomatis.');
        const recovered = await resetCameraUsb('Camera Agent preview terputus');
        recoveryDelay = recovered ? 1200 : 15000;
    } finally {
        isCapturingFrame = false;
    }

    if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;
    if (recoveryDelay !== null) {
        scheduleLiveViewStart(recoveryDelay, generation);
        return;
    }
    const frameDelay = Math.max(8, Math.round(1000 / targetLiveViewFps));
    const elapsed = Date.now() - cycleStartedAt;
    scheduleLiveViewStart(Math.max(0, frameDelay - elapsed), generation);
}

function captureV4l2Frame(onFrameCallback, generation) {
    if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;
    isCapturingFrame = true;
    const cycleStartedAt = Date.now();
    execFile('ffmpeg', [
        '-loglevel', 'error', '-y', '-f', 'video4linux2',
        '-i', config.VIDEO_DEVICE, '-frames:v', '1', '-f', 'image2pipe', '-'
    ], { encoding: 'buffer', timeout: 5000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (!err && stdout && stdout.length > 100 && isLiveViewActive && !isCameraBusy) {
            latestLiveViewFrame = Buffer.from(stdout);
            onFrameCallback(stdout.toString('base64'));
        }
        isCapturingFrame = false;
        if (isLiveViewActive && !isCameraBusy && generation === liveViewGeneration) {
            const delay = Math.max(
                0,
                Math.round(1000 / targetLiveViewFps) - (Date.now() - cycleStartedAt)
            );
            scheduleLiveViewStart(delay, generation);
        }
    });
}

function scheduleLiveViewStart(delayMs, generation = liveViewGeneration) {
    clearLiveViewRestartTimer();
    liveViewRestartTimer = setTimeout(() => {
        liveViewRestartTimer = null;
        if (!isLiveViewActive || isCameraBusy || generation !== liveViewGeneration) return;

        if (config.VIDEO_DEVICE && fs.existsSync(config.VIDEO_DEVICE)) {
            captureV4l2Frame(globalOnFrameCallback, generation);
            return;
        }
        if (nativeCameraAgent.enabled) {
            if (nativeCameraAgent.available) {
                cameraAgentMissingLogged = false;
                captureNativeAgentFrame(globalOnFrameCallback, generation).catch(() => {});
                return;
            }
            cameraConnected = false;
            if (!cameraAgentMissingLogged) {
                cameraAgentMissingLogged = true;
                console.log('⚠️ [CAMERA AGENT] Binary belum dibangun; fallback gphoto2 diblokir demi keamanan shutter.');
                console.log('ℹ️ [CAMERA AGENT] Jalankan sekali: bash scripts/build-camera-agent.sh');
            }
            scheduleLiveViewStart(15000, generation);
            return;
        }
        releaseDesktopCameraClaim()
            .then(() => delay(300))
            .then(() => {
                if (isLiveViewActive && !isCameraBusy && generation === liveViewGeneration) {
                    if (liveViewMode === 'preview') {
                        startGphotoPreviewShell(globalOnFrameCallback, generation);
                    } else {
                        startGphotoMovieStream(globalOnFrameCallback, generation);
                    }
                }
            })
            .catch(() => {});
    }, Math.max(0, delayMs));
    liveViewRestartTimer.unref?.();
}

function setTargetFps(fps, activeCount = 0) {
    // Photobox A memakai target tetap dari .env (LIVEVIEW_TARGET_FPS).
    // Dashboard tidak dapat menurunkan FPS. Cap dinaikkan ke 120 agar
    // mendukung target 60-80 FPS untuk live view yang lebih smooth.
    void fps;
    const nextFps = Math.max(1, Math.min(120, Math.round(config.LIVEVIEW_TARGET_FPS)));

    if (nextFps === targetLiveViewFps) return;
    targetLiveViewFps = nextFps;
    const source = activeCount > 0 ? `${activeCount} liveview aktif, mode tetap` : 'mode tetap';
    console.log(`⚖️ [LIVEVIEW BALANCER] Target ${targetLiveViewFps} FPS (${source}).`);
}

function getLiveViewState() {
    return {
        active: isLiveViewActive,
        targetFps: targetLiveViewFps
    };
}

function startLiveView(onFrameCallback) {
    globalOnFrameCallback = onFrameCallback;
    if (isLiveViewActive) {
        if (!liveViewProcess && !isCapturingFrame && !isCameraBusy) {
            scheduleLiveViewStart(0, liveViewGeneration);
        }
        return;
    }
    isLiveViewActive = true;
    const generation = ++liveViewGeneration;
    console.log(`📹 [LINUX CAMERA] Memulai streaming LiveView...`);

    isCapturingFrame = false;
    liveViewRestartAttempt = 0;
    latestLiveViewFrame = null;
    // viewfinder dan capture-movie dijalankan oleh proses gphoto2 yang sama
    // sehingga aktivasi LiveView tidak membuka sesi PTP kedua.
    scheduleLiveViewStart(1000, generation);
}

function stopLiveView() {
    isLiveViewActive = false;
    liveViewGeneration += 1;
    console.log(`⏹️ [LINUX CAMERA] LiveView dihentikan.`);
    stopLiveViewTransport().catch(() => {});
}

async function shutdown() {
    isLiveViewActive = false;
    liveViewGeneration += 1;
    await stopLiveViewTransport();
    await nativeCameraAgent.stop();
}

/**
 * Menarik SATU frame pratinjau cepat (JPEG) langsung dari buffer stdout (Tanpa simpan ke disk).
 * Digunakan untuk Web Browser Live Preview (http://localhost:3000/preview)
 */
function getSinglePreviewFrame(res) {
    // Endpoint browser hanya memakai frame dari sesi bersama. Jangan pernah
    // membuka proses gphoto2 per HTTP request karena halaman memanggil endpoint
    // ini tiap 300 ms dan Canon hanya mengizinkan satu sesi PTP.
    if (latestLiveViewFrame && isLiveViewActive) {
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        return res.end(latestLiveViewFrame);
    }

    if (!isLiveViewActive && !isCameraBusy && !captureInProgress) {
        startLiveView(() => {});
    }
    return res.status(503).send('LiveView sedang menyiapkan frame.');
}

module.exports = {
    getStatus,
    capturePhoto,
    autoFocus,
    setIso,
    setShutter,
    startLiveView,
    stopLiveView,
    shutdown,
    setTargetFps,
    getLiveViewState,
    getSinglePreviewFrame
};
