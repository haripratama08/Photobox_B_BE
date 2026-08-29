const { execFile } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const config = require('../config/config');
const { withResourceLock } = require('../services/resourceLock');
const logger = require('../services/logger');
const printerService = require('../services/printerService');

const framesData = require(config.FRAMES_DATA_FILE);

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const preparePrintReadyImage = async (sourcePath, baseWidth, baseHeight, density) => {
    const safeScale = clamp(Number(config.PRINT_SAFE_SCALE) || 0.96, 0.9, 1);
    const contentWidth = Math.max(1, Math.round(baseWidth * safeScale));
    const contentHeight = Math.max(1, Math.round(baseHeight * safeScale));
    const pixelsPerMmX = baseWidth / (4 * 25.4);
    const pixelsPerMmY = baseHeight / (6 * 25.4);
    const horizontalRoom = baseWidth - contentWidth;
    const verticalRoom = baseHeight - contentHeight;
    const offsetXPixels = Math.round(config.PRINT_OFFSET_X_MM * pixelsPerMmX);
    const offsetYPixels = Math.round(config.PRINT_OFFSET_Y_MM * pixelsPerMmY);
    const left = clamp(
        Math.round(horizontalRoom / 2) + offsetXPixels,
        0,
        horizontalRoom
    );
    const top = clamp(
        Math.round(verticalRoom / 2) + offsetYPixels,
        0,
        verticalRoom
    );
    const right = horizontalRoom - left;
    const bottom = verticalRoom - top;
    const parsed = path.parse(sourcePath);
    const printPath = path.join(parsed.dir, `${parsed.name}_print${parsed.ext}`);

    // `extendWith: copy` membuat bleed dari piksel paling tepi. Area yang
    // dipotong mekanisme borderless tetap berwarna, tetapi seluruh desain asli
    // berada di dalam area aman dan rasio 2:3 tidak berubah.
    await sharp(sourcePath)
        .resize({
            width: contentWidth,
            height: contentHeight,
            fit: 'fill',
            kernel: sharp.kernel.lanczos3
        })
        .extend({ top, bottom, left, right, extendWith: 'copy' })
        .withMetadata({ density })
        .png({ compressionLevel: 6, adaptiveFiltering: true })
        .toFile(printPath);

    logger.info('print_preview_ready', {
        source: sourcePath,
        file: printPath,
        page: `${baseWidth}x${baseHeight}`,
        content: `${contentWidth}x${contentHeight}`,
        safeScale,
        offsetXmm: config.PRINT_OFFSET_X_MM,
        offsetYmm: config.PRINT_OFFSET_Y_MM,
        bleed: { top, right, bottom, left }
    });
    return printPath;
};

const queuePrint = async (finalCollagePath, printCopies) => {
    const copies = Math.max(1, Number(printCopies) || 1);
    const configuredMedia = config.PRINTER_MEDIA || 'T4X6FULL';
    // Epson ESC/P-R memakai T4X6FULL untuk 4 x 6 inci tanpa batas.
    // Konfigurasi lama 4x6/4X6FULL otomatis dinaikkan ke borderless.
    const isFourBySix = /^(?:4x6|4X6FULL|T4X6FULL)$/i.test(configuredMedia);
    const borderless = config.PRINTER_BORDERLESS && isFourBySix;
    const mediaOption = borderless ? 'T4X6FULL' : configuredMedia;
    const requestedMediaType = config.PRINTER_MEDIA_TYPE || 'PLAIN_HIGH';
    // PPD Epson menolak kombinasi borderless dengan PLAIN_HIGH. Gunakan
    // mode foto saat borderless agar driver tidak kembali ke halaman bermargin.
    const mediaType = borderless && /^PLAIN_/i.test(requestedMediaType)
        ? config.PRINTER_BORDERLESS_MEDIA_TYPE
        : requestedMediaType;
    const ink = config.PRINTER_INK || 'COLOR';
    const printerQueue = await printerService.resolveQueue();
    if (!printerQueue) throw new Error('Tidak ada printer CUPS yang terdeteksi');
    logger.info('print_start', {
        printer: printerQueue,
        file: finalCollagePath,
        copies,
        media: mediaOption,
        mediaType,
        requestedMediaType,
        ink,
        dpi: config.PRINT_DPI,
        borderless,
        fitToPage: true
    });

    await withResourceLock(
        `printer:${printerQueue}`,
        () => new Promise((resolve, reject) => {
            const lpArguments = [
                '-d', printerQueue,
                '-n', String(copies),
                '-o', `PageSize=${mediaOption}`,
                '-o', `MediaType=${mediaType}`,
                '-o', `Ink=${ink}`,
                '-o', 'print-quality=5',
                '-o', `resolution=${config.PRINT_DPI}dpi`,
                '-o', 'job-sheets=none,none',
                '-o', 'position=center',
                '-o', 'orientation-requested=3',
                '-o', 'sides=one-sided',
                // Selalu muatkan satu gambar ke satu halaman. Opsi scaling >100
                // membuat PNG high-res dianggap lebih besar dan ditile 2x2.
                '-o', 'fit-to-page',
                finalCollagePath
            ];
            execFile(
                'lp',
                lpArguments,
                { timeout: 30000 },
                (error, stdout) => {
                    if (error) {
                        logger.error('print_failed', { printer: printerQueue, file: finalCollagePath, error: error.message, stderr: error.stderr });
                        return reject(error);
                    }
                    console.log(`✅ [PRINT] Masuk antrean CUPS (${mediaOption}): ${stdout.trim()}`);
                    logger.info('print_queued', { printer: printerQueue, output: stdout.trim() });
                    resolve();
                }
            );
        }),
        {
            label: `printer ${config.PRINTER_NAME}`,
            timeoutMs: 120000,
            staleMs: 300000
        }
    );
};

const processAndPrint = async ({
    mergedImageBase64,
    frameName,
    photos,
    userFolderPath,
    printCopies
}) => {
    const baseWidth = config.PRINT_WIDTH;
    const baseHeight = config.PRINT_HEIGHT;
    // Tetapkan ukuran fisik PNG tepat 4 x 6 inci. Contoh 2400x3600
    // menghasilkan metadata 600 DPI dan tidak dianggap sebagai poster multi-page.
    const outputDensity = Math.max(
        72,
        Math.round(Math.min(baseWidth / 4, baseHeight / 6))
    );
    const finalCollagePath = path.join(
        userFolderPath,
        `Cetak_Frame_${Date.now()}.png`
    );
    let renderingDone = false;

    if (frameName && photos && photos.length > 0) {
        const frameConfig = framesData.find((frame) => frame.name === frameName);
        if (frameConfig) {
            const frameFileName = path.basename(
                new URL(frameConfig.asset_path, config.PUBLIC_BASE_URL).pathname
            );
            const frameLocalPath = path.join(config.FRAMES_FOLDER, frameFileName);
            const compositeOperations = [];

            for (let index = 0; index < photos.length; index += 1) {
                if (!frameConfig.slots[index]) continue;
                const slot = frameConfig.slots[index];
                const urlPath = new URL(photos[index]).pathname;
                const relativePath = decodeURIComponent(
                    urlPath.replace('/photos/', '')
                );
                const absolutePath = path.join(
                    config.BASE_PHOTO_FOLDER,
                    relativePath
                );
                const slotWidth = Math.round(baseWidth * slot.w);
                const slotHeight = Math.round(baseHeight * slot.h);

                if (fs.existsSync(absolutePath)) {
                    compositeOperations.push({
                        input: await sharp(absolutePath)
                            // Sharp 0.33 belum memiliki autoOrient(). rotate()
                            // tanpa argumen menerapkan orientasi EXIF yang sama.
                            .rotate()
                            .resize({
                                width: slotWidth,
                                height: slotHeight,
                                fit: 'cover',
                                kernel: sharp.kernel.lanczos3
                            })
                            .toBuffer(),
                        top: Math.round(baseHeight * slot.t),
                        left: Math.round(baseWidth * slot.l)
                    });
                }
            }

            if (fs.existsSync(frameLocalPath)) {
                compositeOperations.push({
                    input: await sharp(frameLocalPath)
                        .resize(baseWidth, baseHeight, {
                            fit: 'fill',
                            kernel: sharp.kernel.lanczos3
                        })
                        .toBuffer(),
                    top: 0,
                    left: 0
                });
            } else {
                console.log(`⚠️ Template frame tidak ditemukan: ${frameLocalPath}`);
            }

            await sharp({
                create: {
                    width: baseWidth,
                    height: baseHeight,
                    channels: 4,
                    background: { r: 255, g: 255, b: 255, alpha: 1 }
                }
            })
                .composite(compositeOperations)
                .withMetadata({ density: outputDensity })
                .png({ compressionLevel: 6, adaptiveFiltering: true })
                .toFile(finalCollagePath);

            console.log(`✅ Kolase high-res berhasil dibuat: ${finalCollagePath}`);
            renderingDone = true;
        }
    }

    if (!renderingDone && mergedImageBase64) {
        const base64Data = mergedImageBase64.replace(
            /^data:image\/\w+;base64,/,
            ''
        );
        await sharp(Buffer.from(base64Data, 'base64'))
            .resize({
                width: baseWidth,
                height: baseHeight,
                fit: 'cover',
                kernel: sharp.kernel.lanczos3
            })
            .withMetadata({ density: outputDensity })
            .png({ compressionLevel: 6, adaptiveFiltering: true })
            .toFile(finalCollagePath);
        renderingDone = true;
    }

    if (!renderingDone || !fs.existsSync(finalCollagePath)) {
        throw new Error('Kolase cetak gagal dibuat');
    }

    const printReadyPath = await preparePrintReadyImage(
        finalCollagePath,
        baseWidth,
        baseHeight,
        outputDensity
    );

    console.log(
        `🖨️ Mengantrekan ${printCopies} salinan ke ${config.PRINTER_NAME}...`
    );
    try {
        await queuePrint(printReadyPath, printCopies);
    } catch (error) {
        console.log(
            `⚠️ [PRINT] Gagal masuk antrean ${config.PRINTER_NAME}: ${error.message}`
        );
        logger.error('print_pipeline_failed', { printer: config.PRINTER_NAME, file: printReadyPath, error: error.message });
    }

    return finalCollagePath;
};

module.exports = { processAndPrint };
