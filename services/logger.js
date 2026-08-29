const fs = require('fs-extra');
const path = require('path');
const config = require('../config/config');

const write = (level, message, details = {}) => {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        box_id: config.BOX_ID,
        message,
        ...details
    };
    const line = `${JSON.stringify(entry)}\n`;
    try {
        fs.ensureDirSync(path.dirname(config.LOG_FILE));
        if (fs.existsSync(config.LOG_FILE) && fs.statSync(config.LOG_FILE).size > 5 * 1024 * 1024) {
            fs.moveSync(config.LOG_FILE, `${config.LOG_FILE}.1`, { overwrite: true });
        }
        fs.appendFileSync(config.LOG_FILE, line);
    } catch (error) {
        console.error('[LOGGER] gagal menulis log:', error.message);
    }
    const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
    console[level === 'error' ? 'error' : 'log'](`[${level.toUpperCase()}] ${message}${suffix}`);
};

module.exports = {
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details),
    path: config.LOG_FILE
};
