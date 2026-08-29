const chokidar = require('chokidar');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config/config');
const session = require('../state/session');

const initWatcher = (io) => {
    // Pastikan direktori utama penampungan foto tersedia di Linux sebelum pemantauan dimulai
    fs.ensureDirSync(config.BASE_PHOTO_FOLDER);

    // Di Linux, chokidar memanfaatkan kernel inotify natif (tanpa polling CPU-heavy) sehingga super enteng
    chokidar.watch(config.BASE_PHOTO_FOLDER, { 
        depth: 0, 
        ignoreInitial: true,
        usePolling: false 
    }).on('add', (filePath) => {
        const filename = path.basename(filePath);
        // File tersembunyi/.tmp hanya dipakai preflight untuk menguji akses
        // tulis dan langsung dihapus; jangan diproses sebagai hasil foto.
        if (filename.startsWith('.') || filename.endsWith('.tmp')) return;

        const activeUserFolder = session.getActiveUserFolder();
        const userFolderPath = path.join(config.BASE_PHOTO_FOLDER, activeUserFolder);
        
        fs.ensureDirSync(userFolderPath);
        const newFilePath = path.join(userFolderPath, filename);

        setTimeout(async () => {
            try {
                // Pertahankan byte dan resolusi asli kamera. Versi sebelumnya
                // mengecilkan foto ke 1920px dan JPEG 80% sebelum dicetak.
                await fs.move(filePath, newFilePath, { overwrite: true });
                console.log(`📸 [LINUX INOTIFY] Foto asli diamankan: /${activeUserFolder}/${filename}`);

                io.emit('photo-ready', {
                    url: `${config.PUBLIC_BASE_URL}/photos/${encodeURIComponent(activeUserFolder)}/${filename}`,
                    filename: filename
                });
            } catch (err) {
                console.log(`❌ Gagal memproses foto ${filename}:`, err.message);
            }
        }, 500); // Respon 500ms yang lebih cepat di disk POSIX Linux
    });
};

module.exports = { initWatcher };
