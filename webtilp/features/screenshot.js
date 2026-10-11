'use strict';

/**
 * features screenshot. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createFeaturesScreenshot(dependencies) {
    function hpPrimePngPaethPredictor(left, above, upperLeft) {
        const estimate = left + above - upperLeft;
        const leftDistance = Math.abs(estimate - left);
        const aboveDistance = Math.abs(estimate - above);
        const upperLeftDistance = Math.abs(estimate - upperLeft);
        if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
            return left;
        }
        return aboveDistance <= upperLeftDistance ? above : upperLeft;
    }

    function parseHPPrimeRgb555Png(png) {
        const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        if (!(png instanceof dependencies.Uint8Array)
            || png.length < signature.length
            || !signature.every((value, index) => png[index] === value)) {
            throw new Error('The HP Prime returned an invalid PNG screenshot.');
        }

        const view = new dependencies.DataView(png.buffer, png.byteOffset, png.byteLength);
        let offset = signature.length;
        let header = null;
        const imageParts = [];
        let imageSize = 0;
        while (offset + 12 <= png.length) {
            const size = view.getUint32(offset, false);
            const dataStart = offset + 8;
            const dataEnd = dataStart + size;
            if (dataEnd + 4 > png.length) {
                throw new Error('The HP Prime returned a truncated PNG screenshot.');
            }
            const type = String.fromCharCode(
                png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]
            );
            if (type === 'IHDR') {
                if (size !== 13 || header) {
                    throw new Error('The HP Prime returned an invalid PNG header.');
                }
                header = {
                    width: view.getUint32(dataStart, false),
                    height: view.getUint32(dataStart + 4, false),
                    bitDepth: png[dataStart + 8],
                    colorType: png[dataStart + 9],
                    compression: png[dataStart + 10],
                    filter: png[dataStart + 11],
                    interlace: png[dataStart + 12]
                };
            } else if (type === 'IDAT') {
                imageParts.push(png.subarray(dataStart, dataEnd));
                imageSize += size;
            } else if (type === 'IEND') {
                break;
            }
            offset = dataEnd + 4;
        }

        if (!header) {
            throw new Error('The HP Prime screenshot has no PNG header.');
        }
        // Prime format 8 labels native little-endian RGB555 words as PNG
        // grayscale-16 samples. Standard PNG decoders therefore show a noisy
        // grayscale image; preserve other formats for the browser to decode.
        if (header.bitDepth !== 16 || header.colorType !== 0) {
            return null;
        }
        if (!header.width || !header.height
            || header.width > 4096 || header.height > 4096
            || header.compression !== 0 || header.filter !== 0
            || header.interlace !== 0 || imageParts.length === 0) {
            throw new Error('The HP Prime returned an unsupported PNG screenshot.');
        }

        const compressed = new dependencies.Uint8Array(imageSize);
        let imageOffset = 0;
        for (const part of imageParts) {
            compressed.set(part, imageOffset);
            imageOffset += part.length;
        }
        return { ...header, compressed };
    }

    async function decodeHPPrimeRgb555Png(png) {
        const parsed = dependencies.parseHPPrimeRgb555Png(png);
        if (!parsed) {
            return null;
        }
        if (typeof dependencies.DecompressionStream !== 'function') {
            throw new Error('This browser cannot decode HP Prime color screenshots.');
        }

        const stream = new dependencies.Blob([parsed.compressed])
            .stream()
            .pipeThrough(new dependencies.DecompressionStream('deflate'));
        const inflated = new dependencies.Uint8Array(await new dependencies.Response(stream).arrayBuffer());
        const bytesPerPixel = 2;
        const stride = parsed.width * bytesPerPixel;
        const expectedSize = (stride + 1) * parsed.height;
        if (inflated.length !== expectedSize) {
            throw new Error('The HP Prime returned incomplete PNG pixel data.');
        }

        const raw = new dependencies.Uint8Array(stride * parsed.height);
        let inputOffset = 0;
        for (let y = 0; y < parsed.height; y += 1) {
            const filter = inflated[inputOffset++];
            if (filter > 4) {
                throw new Error(`The HP Prime returned an unknown PNG filter (${filter}).`);
            }
            const rowOffset = y * stride;
            const previousRowOffset = rowOffset - stride;
            for (let x = 0; x < stride; x += 1) {
                const encoded = inflated[inputOffset++];
                const left = x >= bytesPerPixel ? raw[rowOffset + x - bytesPerPixel] : 0;
                const above = y > 0 ? raw[previousRowOffset + x] : 0;
                const upperLeft = y > 0 && x >= bytesPerPixel
                    ? raw[previousRowOffset + x - bytesPerPixel]
                    : 0;
                let predictor = 0;
                if (filter === 1) predictor = left;
                else if (filter === 2) predictor = above;
                else if (filter === 3) predictor = Math.floor((left + above) / 2);
                else if (filter === 4) predictor = dependencies.hpPrimePngPaethPredictor(left, above, upperLeft);
                raw[rowOffset + x] = (encoded + predictor) & 0xFF;
            }
        }

        const rgba = new dependencies.Uint8ClampedArray(parsed.width * parsed.height * 4);
        for (let source = 0, target = 0; source < raw.length; source += 2, target += 4) {
            const rgb555 = raw[source] | (raw[source + 1] << 8);
            const red = (rgb555 >> 10) & 0x1F;
            const green = (rgb555 >> 5) & 0x1F;
            const blue = rgb555 & 0x1F;
            rgba[target] = (red << 3) | (red >> 2);
            rgba[target + 1] = (green << 3) | (green >> 2);
            rgba[target + 2] = (blue << 3) | (blue >> 2);
            rgba[target + 3] = 0xFF;
        }
        return { width: parsed.width, height: parsed.height, rgba };
    }

    async function drawHPPrimeScreenshot(canvas, png) {
        const decoded = await dependencies.decodeHPPrimeRgb555Png(png);
        if (decoded) {
            canvas.width = decoded.width;
            canvas.height = decoded.height;
            const ctx = canvas.getContext('2d');
            const imageData = ctx.createImageData(decoded.width, decoded.height);
            imageData.data.set(decoded.rgba);
            ctx.putImageData(imageData, 0, 0);
            return;
        }

        const bitmap = await dependencies.createImageBitmap(new dependencies.Blob([png], { type: 'image/png' }));
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close?.();
    }

    async function takeScreenshot() {
        if (dependencies.state?.activeFamily === 'sharp') {
            await dependencies.runSharpOperation(dependencies.t('sharp_screen'), async backend => {
                const screenshot = await backend.captureScreenshot();
                if (dependencies.state.sharpBackend !== backend) return;
                const canvas = dependencies.els.screenshotCanvas;
                canvas.width = screenshot.width; canvas.height = screenshot.height;
                const ctx = canvas.getContext('2d');
                const image = ctx.createImageData(screenshot.width, screenshot.height);
                image.data.set(screenshot.rgba); ctx.putImageData(image, 0, 0);
                canvas.classList.add('filled'); dependencies.updateScreenshotCanvasScale();
            });
            return;
        }

        dependencies.setButtonLoading(dependencies.els.btnScreenshot, true);
        try {
            if (dependencies.isHPPrimeActive()) {
                const module = await dependencies.initModule();
                const target = '/hp-prime-screenshot.png';
                const result = await dependencies.ccallAsync(module, 'hp_prime_screenshot', 'number', ['string', 'number'], [target, 8], {
                    timeoutMs: null,
                    useProgress: true,
                    progressLabel: dependencies.t('hp_prime_progress_receiving_screenshot')
                });
                if (result !== 0) {
                    dependencies.log(dependencies.tFormat('hp_prime_screenshot_failed', {
                        error: dependencies.formatHPPrimeError(module, result)
                    }));
                    return;
                }
                const png = module.FS.readFile(target);
                const canvas = dependencies.els.screenshotCanvas;
                await dependencies.drawHPPrimeScreenshot(canvas, png);
                canvas.classList.add('filled');
                dependencies.updateScreenshotCanvasScale();
                module.FS.unlink(target);
                dependencies.log(dependencies.tFormat('hp_prime_screenshot_captured', {
                    width: canvas.width,
                    height: canvas.height
                }));
                return;
            }
            if (dependencies.isHPLegacyActive()) {
                if (!dependencies.state.hpLegacyKermitEnabled || !dependencies.state.hpLegacyBackend) {
                    dependencies.log(dependencies.t('hp_legacy_kermit_not_selected'));
                    return;
                }
                const backend = dependencies.state.hpLegacyBackend;
                const connectionGeneration = dependencies.state.hpLegacyConnectionGeneration;
                const screenshot = await backend.captureScreenshot();
                if (dependencies.state.hpLegacyBackend !== backend
                    || dependencies.state.hpLegacyConnectionGeneration !== connectionGeneration
                    || !dependencies.state.connected || !dependencies.isHPLegacyActive()) {
                    return;
                }
                const canvas = dependencies.els.screenshotCanvas;
                canvas.width = screenshot.width;
                canvas.height = screenshot.height;
                const ctx = canvas.getContext('2d');
                const imageData = ctx.createImageData(screenshot.width, screenshot.height);
                imageData.data.set(screenshot.rgba);
                ctx.putImageData(imageData, 0, 0);
                canvas.classList.add('filled');
                dependencies.updateScreenshotCanvasScale();
                dependencies.log(`Screenshot captured (${screenshot.width}x${screenshot.height}).`);
                return;
            }
            if (dependencies.isNumWorksActive()) {
                dependencies.log(dependencies.t('numworks_screenshot_unavailable'));
                return;
            }
            await dependencies.authorizeDevice();
            const module = await dependencies.initModule();
            const handle = await dependencies.ensureHandle();
            const result = await dependencies.ccallAsync(module, 'calc_screenshot', 'number', ['number'], [handle], { timeoutMs: null, useProgress: true, progressLabel: 'Receiving screenshot' });
            if (result !== 0) {
                dependencies.log(`Screenshot error (${dependencies.formatErrorResult(module, result)}).`);
                return;
            }
            const data = module.FS.readFile('/screenshot.bin');
            const view = new dependencies.DataView(data.buffer, data.byteOffset, data.byteLength);
            const width = view.getUint32(0, true);
            const height = view.getUint32(4, true);
            const rgb = data.subarray(8);
            const canvas = dependencies.els.screenshotCanvas;
            const ctx = canvas.getContext('2d');
            const imageData = ctx.createImageData(width, height);
            for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
                imageData.data[j] = rgb[i];
                imageData.data[j + 1] = rgb[i + 1];
                imageData.data[j + 2] = rgb[i + 2];
                imageData.data[j + 3] = 255;
            }
            canvas.width = width;
            canvas.height = height;
            ctx.putImageData(imageData, 0, 0);
            dependencies.els.screenshotCanvas.classList.add('filled');
            dependencies.updateScreenshotCanvasScale();
            dependencies.log(`Screenshot captured (${width}x${height}).`);
            try {
                module.FS.unlink('/screenshot.bin');
            } catch (cleanupErr) {
                dependencies.console.warn(cleanupErr);
            }
        } catch (err) {
            dependencies.logError(err, 'Screenshot failed');
        } finally {
            dependencies.setButtonLoading(dependencies.els.btnScreenshot, false);
        }
    }

    function downloadCanvas() {
        dependencies.setButtonLoading(dependencies.els.btnDownloadScreenshot, true);
        const canvas = dependencies.els.screenshotCanvas;
        if (!canvas.width || !canvas.height) {
            dependencies.log('No screenshot to download.');
            dependencies.setButtonLoading(dependencies.els.btnDownloadScreenshot, false);
            return;
        }
        const link = dependencies.document.createElement('a');
        link.download = 'screenshot.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
        dependencies.setButtonLoading(dependencies.els.btnDownloadScreenshot, false);
    }

    return { hpPrimePngPaethPredictor, parseHPPrimeRgb555Png, decodeHPPrimeRgb555Png, drawHPPrimeScreenshot, takeScreenshot, downloadCanvas };
}

module.exports = { createFeaturesScreenshot };
