'use strict';

/**
 * runtime downloads. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createRuntimeDownloads(dependencies) {
    async function downloadLastReceived(module, fallbackName) {
        let filename = fallbackName || 'download.bin';
        try {
            const lastPath = module.FS.readFile('/last_recv_path.txt', { encoding: 'utf8' }).trim();
            if (lastPath) {
                filename = lastPath.split('/').pop();
                let data = module.FS.readFile(lastPath);
                const converted = await dependencies.convertReceivedPythonFile(filename, data);
                if (converted) {
                    filename = converted.filename;
                    data = converted.data;
                }
                dependencies.triggerDownload(filename, data);
                module.FS.unlink(lastPath);
                return;
            }
        } catch (err) {
            dependencies.console.warn(err);
        }
        dependencies.log('No received file found to download.');
    }

    function triggerDownload(filename, data) {
        const blob = new dependencies.Blob([data], { type: 'application/octet-stream' });
        const link = dependencies.document.createElement('a');
        const url = dependencies.URL.createObjectURL(blob);
        link.href = url;
        link.download = filename;
        dependencies.document.body.appendChild(link);
        link.click();
        link.remove();
        dependencies.setTimeout(() => dependencies.URL.revokeObjectURL(url), 0);
    }

    function saveSharpDownload(result, backend) {
        if (!dependencies.state.connected || dependencies.state.sharpBackend !== backend) return;
        dependencies.triggerDownload(result.filename, result.data);
    }

    return { downloadLastReceived, triggerDownload, saveSharpDownload };
}

module.exports = { createRuntimeDownloads };
