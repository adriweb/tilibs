'use strict';

// Compose feature and view factories without starting the browser application.
function createFrontend(ctx) {
    return {
        ...require('./transport/browser-devices.js').createTransportBrowserDevices(ctx),
        ...require('./ui/localization.js').createUiLocalization(ctx),
        ...require('./ui/theme.js').createUiTheme(ctx),
        ...require('./runtime/diagnostics.js').createRuntimeDiagnostics(ctx),
        ...require('./ui/progress.js').createUiProgress(ctx),
        ...require('./runtime/bridge.js').createRuntimeBridge(ctx),
        ...require('./ui/key-controls.js').createUiKeyControls(ctx),
        ...require('./offline.js').createOffline(ctx),
        ...require('./features/settings.js').createFeaturesSettings(ctx),
        ...require('./ui/feedback.js').createUiFeedback(ctx),
        ...require('./ui/connection.js').createUiConnection(ctx),
        ...require('./features/ti-transfer-policy.js').createFeaturesTiTransferPolicy(ctx),
        ...require('./features/connections.js').createFeaturesConnections(ctx),
        ...require('./backends/device-info.js').createBackendsDeviceInfo(ctx),
        ...require('./features/device-controls.js').createFeaturesDeviceControls(ctx),
        ...require('./ui/device-info.js').createUiDeviceInfo(ctx),
        ...require('./features/directory.js').createFeaturesDirectory(ctx),
        ...require('./ui/directory.js').createUiDirectory(ctx),
        ...require('./ui/dropzone.js').createUiDropzone(ctx),
        ...require('./ui/selection.js').createUiSelection(ctx),
        ...require('./features/hp-apps.js').createFeaturesHpApps(ctx),
        ...require('./features/transfers.js').createFeaturesTransfers(ctx),
        ...require('./backends/uploads.js').createBackendsUploads(ctx),
        ...require('./features/backup.js').createFeaturesBackup(ctx),
        ...require('./features/bundles.js').createFeaturesBundles(ctx),
        ...require('./features/preview.js').createFeaturesPreview(ctx),
        ...require('./features/converters.js').createFeaturesConverters(ctx),
        ...require('./features/transfer-plan.js').createFeaturesTransferPlan(ctx),
        ...require('./ui/transfer-dialog.js').createUiTransferDialog(ctx),
        ...require('./features/ti-transfer-executor.js').createFeaturesTiTransferExecutor(ctx),
        ...require('./features/file-controller.js').createFeaturesFileController(ctx),
        ...require('./features/screenshot.js').createFeaturesScreenshot(ctx),
        ...require('./runtime/downloads.js').createRuntimeDownloads(ctx),
        ...require('./ui/events.js').createUiEvents(ctx),
    };
}

module.exports = { createFrontend };
