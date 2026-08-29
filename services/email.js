const nodemailer = require('nodemailer');
const config = require('../config/config');
const logger = require('./logger');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: config.EMAIL_USER,
        pass: config.EMAIL_PASS
    }
});

const sendEmailMsg = async (userEmail, userName, attachments) => {
    if (!userEmail || attachments.length === 0) {
        logger.warn('email_skipped', { reason: !userEmail ? 'email kosong' : 'tidak ada lampiran' });
        return { skipped: true };
    }

    console.log(`⏳ Mengirim Email ke: ${userEmail}...`);
    try {
        await transporter.sendMail({
            from: '"Photobox Studio" <no-reply@photobox.com>',
            to: userEmail,
            subject: `Hasil Foto Photobox Anda, ${userName}! 📸`,
            text: `Halo ${userName}!\n\nTerima kasih telah berkunjung. Terlampir adalah 1 Foto Frame hasil cetak beserta seluruh foto mentahannya.\n\nSalam Hangat,\nTim Photobox`,
            attachments: attachments
        });
        console.log(`✅ [EMAIL] Sukses terkirim!`);
        logger.info('email_sent', { to: userEmail, attachments: attachments.map((item) => item.filename) });
        return { skipped: false, sent: true };
    } catch (err) {
        logger.error('email_failed', { to: userEmail, error: err.message, attachments: attachments.map((item) => item.filename) });
        console.log(`❌ [EMAIL] Gagal:`, err.message);
    }
};

module.exports = { sendEmailMsg };
