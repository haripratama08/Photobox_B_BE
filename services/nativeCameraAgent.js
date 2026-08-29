const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

class NativeCameraAgent {
    constructor() {
        this.child = null;
        this.startPromise = null;
        this.nextId = 1;
        this.pending = new Map();
        this.stdoutBuffer = '';
        this.stderrText = '';
    }

    get enabled() {
        return process.platform !== 'win32' && config.CAMERA_AGENT_ENABLED;
    }

    get available() {
        return this.enabled
            && fs.existsSync(config.CAMERA_AGENT_BIN);
    }

    get running() {
        return Boolean(this.child && this.child.exitCode === null);
    }

    async ensureStarted() {
        if (!this.available) throw new Error('Camera agent native belum dibangun.');
        if (this.running) return;
        if (this.startPromise) return this.startPromise;

        this.startPromise = (async () => {
            const child = spawn(config.CAMERA_AGENT_BIN, [], {
                cwd: path.dirname(config.CAMERA_AGENT_BIN),
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, LC_ALL: 'C' }
            });
            this.child = child;
            this.stdoutBuffer = '';
            this.stderrText = '';

            child.stdout.on('data', (data) => this.handleStdout(data));
            child.stderr.on('data', (data) => {
                this.stderrText = `${this.stderrText}${data.toString()}`.slice(-8000);
            });
            child.on('error', (error) => this.handleExit(error, child));
            child.on('close', (code, signal) => {
                this.handleExit(new Error(
                    `Camera agent berhenti (${code ?? signal}). ${this.stderrText}`.trim()
                ), child);
            });

            await this.requestRaw('PING', [], 20000);
            console.log('✅ [CAMERA AGENT] Koneksi persisten libgphoto2 siap.');
        })().finally(() => {
            this.startPromise = null;
        });

        return this.startPromise;
    }

    handleStdout(data) {
        this.stdoutBuffer += data.toString();
        let newline;
        while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (!line) continue;

            let message;
            try {
                message = JSON.parse(line);
            } catch (_) {
                this.stderrText = `${this.stderrText}\nOutput tidak dikenal: ${line}`.slice(-8000);
                continue;
            }

            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.ok) pending.resolve(message);
            else {
                const error = new Error(message.message || `libgphoto2 error ${message.code}`);
                error.code = message.code;
                pending.reject(error);
            }
        }
    }

    handleExit(error, child) {
        if (this.child !== child) return;
        this.child = null;
        if (child?.stdin?.writable) child.stdin.destroy();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    requestRaw(command, args = [], timeoutMs = 15000) {
        if (!this.running || !this.child.stdin.writable) {
            return Promise.reject(new Error('Camera agent tidak berjalan.'));
        }
        const fields = args.map((value) => String(value));
        if (fields.some((value) => /[\t\r\n]/.test(value))) {
            return Promise.reject(new Error('Argumen camera agent tidak valid.'));
        }

        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Camera agent timeout saat ${command}.`));
            }, timeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write([id, command, ...fields].join('\t') + '\n');
        });
    }

    async request(command, args = [], timeoutMs = 15000) {
        await this.ensureStarted();
        return this.requestRaw(command, args, timeoutMs);
    }

    ping() {
        return this.request('PING', [], 10000);
    }

    preview(targetPath) {
        return this.request('PREVIEW', [targetPath], config.LIVEVIEW_FRAME_TIMEOUT_MS);
    }

    capture(targetPath) {
        return this.request('CAPTURE', [targetPath], 45000);
    }

    setConfig(key, value) {
        return this.request('SET', [key, value], 15000);
    }

    async restart() {
        await this.stop();
        return this.ensureStarted();
    }

    async stop() {
        const child = this.child;
        if (!child || child.exitCode !== null) {
            this.child = null;
            return;
        }

        try {
            await this.requestRaw('EXIT', [], 3000);
        } catch (_) {}
        if (child.exitCode === null) child.kill('SIGTERM');
        this.child = null;
    }
}

module.exports = new NativeCameraAgent();
