'use strict';

/**
 * offline. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createOffline(dependencies) {
    function showOfflineBanner() {
        if (!dependencies.els.offlineBanner) {
            return;
        }
        dependencies.els.offlineBanner.classList.remove('hidden');
    }

    function showOfflineUpdateBanner() {
        if (!dependencies.els.offlineBanner || !dependencies.els.btnReloadOffline) {
            return;
        }
        if (dependencies.els.offlineBannerText) {
            dependencies.els.offlineBannerText.textContent = dependencies.t('offline_update_available');
        }
        dependencies.els.btnReloadOffline.classList.remove('hidden');
        dependencies.els.offlineBanner.classList.remove('hidden');
        if (dependencies.els.settingsUpdateDot) {
            dependencies.els.settingsUpdateDot.classList.remove('hidden');
        }
        if (dependencies.els.btnSettings) {
            dependencies.els.btnSettings.title = dependencies.t('update_available');
        }
        dependencies.state.offlineUpdateShown = true;
    }

    function hideOfflineUpdateBanner() {
        if (!dependencies.els.offlineBanner || !dependencies.els.btnReloadOffline) {
            return;
        }
        if (dependencies.els.offlineBannerText) {
            dependencies.els.offlineBannerText.textContent = dependencies.t('offline_ready');
        }
        dependencies.els.btnReloadOffline.classList.add('hidden');
        if (dependencies.els.settingsUpdateDot) {
            dependencies.els.settingsUpdateDot.classList.add('hidden');
        }
        if (dependencies.els.btnSettings) {
            dependencies.els.btnSettings.removeAttribute('title');
        }
        if (!dependencies.state.offlineUpdateShown) {
            return;
        }
        dependencies.state.offlineUpdateShown = false;
    }

    async function clearOfflineCache() {
        if (typeof dependencies.caches !== 'undefined') {
            const keys = await dependencies.caches.keys();
            await Promise.all(keys.map(key => dependencies.caches.delete(key)));
        }
        if ('serviceWorker' in dependencies.navigator) {
            const regs = await dependencies.navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(reg => reg.unregister()));
        }
        if (dependencies.els.offlineBanner) {
            dependencies.els.offlineBanner.classList.add('hidden');
        }
        dependencies.log('Offline cache cleared.');
    }

    async function loadBuildInfo() {
        let info = null;
        try {
            const res = await dependencies.fetch('version.json', { cache: 'no-store' });
            if (res.ok) {
                info = await res.json();
            }
        } catch {
            // ignore
        }
        if (!info) {
            try {
                const res = await dependencies.fetch('version.json');
                if (res.ok) {
                    info = await res.json();
                }
            } catch {
                return;
            }
        }
        if (!info) {
            return;
        }
        const title = `${info.gitSha || 'unknown'} ${info.buildDate || ''}`.trim();
        if (dependencies.els.brandMark) {
            dependencies.els.brandMark.title = title;
        }
        const previous = dependencies.localStorage.getItem('webtilp.buildId');
        if (info.buildId) {
            if (previous && previous !== info.buildId) {
                dependencies.showOfflineUpdateBanner();
            } else {
                dependencies.hideOfflineUpdateBanner();
            }
            dependencies.localStorage.setItem('webtilp.buildId', info.buildId);
        }
    }

    function waitForIsolationWorker(registration, timeoutMs = 30000) {
        return new Promise(resolve => {
            const ports = [];
            const finish = value => {
                dependencies.clearTimeout(timer);
                dependencies.navigator.serviceWorker.removeEventListener('controllerchange', check);
                ports.forEach(port => port.close());
                resolve(value);
            };
            const check = () => {
                // Hard refresh bypasses the worker and leaves controller null, but
                // the active registration can still confirm that a normal reload is safe.
                const controller = dependencies.navigator.serviceWorker.controller || registration.active;
                if (!controller) return;
                const channel = new dependencies.MessageChannel();
                ports.push(channel.port1);
                channel.port1.onmessage = event => {
                    if (event.data?.type === 'ISOLATION_READY') finish(event.data.version);
                };
                controller.postMessage({ type: 'GET_ISOLATION_STATUS' }, [channel.port2]);
            };
            const timer = dependencies.setTimeout(() => finish(null), timeoutMs);
            dependencies.navigator.serviceWorker.addEventListener('controllerchange', check);
            check();
        });
    }

    async function prepareServiceWorker() {
        // Hard refresh can restore the pre-isolation sessionStorage snapshot. Keep
        // the one-retry guard in the navigation URL instead, then remove it on success.
        const reloadParam = '__webtilp_isolation';
        const url = new dependencies.URL(dependencies.window.location.href);
        if (dependencies.window.crossOriginIsolated && url.searchParams.has(reloadParam)) {
            url.searchParams.delete(reloadParam);
            dependencies.window.history.replaceState(dependencies.window.history.state, '', url.href);
        }
        if (!dependencies.window.isSecureContext || !('serviceWorker' in dependencies.navigator)) return false;
        try {
            const reg = await dependencies.navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
            dependencies.navigator.serviceWorker.ready.then(dependencies.showOfflineBanner).catch(() => {});
            reg.addEventListener('updatefound', () => {
                const worker = reg.installing;
                worker?.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && dependencies.navigator.serviceWorker.controller) {
                        dependencies.showOfflineUpdateBanner();
                    }
                });
            });
            if (dependencies.window.crossOriginIsolated) return false;
            const version = await dependencies.waitForIsolationWorker(reg);
            if (!version) return false;
            if (url.searchParams.get(reloadParam) === version) return false;
            url.searchParams.set(reloadParam, version);
            dependencies.window.location.replace(url.href);
            return true;
        } catch (error) {
            dependencies.console.warn('[WebTILP] Service worker setup failed.', error);
            return false;
        }
    }

    return { showOfflineBanner, showOfflineUpdateBanner, hideOfflineUpdateBanner, clearOfflineCache, loadBuildInfo, waitForIsolationWorker, prepareServiceWorker };
}

module.exports = { createOffline };
