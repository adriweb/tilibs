'use strict';

function deriveControlAvailability(capabilities, context) {
    const { family } = capabilities;
    const ti = family === 'ti';
    const sharp = family === 'sharp';
    const known = !ti || context.tiCapabilitiesKnown;
    const receiveOs = sharp || (ti && known && context.nspire);
    const canReceiveOs = sharp || (receiveOs && capabilities.rom);
    const controls = {
        fileInput: { disabled: !capabilities.send },
        btnRefreshDirlist: { disabled: !known || !(capabilities.nativeDirectory
            || capabilities.cachedDirectory || capabilities.backupDirectory) },
        btnScreenshot: { disabled: !known || !capabilities.screenshot },
        btnReceiveBackup: { disabled: !known || !capabilities.backup },
        btnSyncClock: { disabled: !known || !capabilities.clock },
        btnNewFolder: { disabled: !known || !capabilities.newFolder },
        btnIsReady: { hidden: !known || !capabilities.ready },
        btnDumpRom: { hidden: !(sharp || (ti && known && !context.nspire)),
            disabled: !known || !capabilities.rom },
        btnReceiveOs: { hidden: !receiveOs, disabled: !canReceiveOs },
        btnDownloadOsPartial: { hidden: !(receiveOs && ti && context.osStarted),
            disabled: !(receiveOs && ti && context.osStarted) },
        btnLeaveExam: { hidden: !ti || !known || !context.leaveExam,
            disabled: !ti || !known || !context.leaveExam },
        varsPanel: { hidden: ti && known && !capabilities.nativeDirectory
            && !(capabilities.backupDirectory && context.backupLoaded) },
        btnBackupDirlist: { hidden: !known || !capabilities.backupDirectory },
        backupDirlistNote: { hidden: !known || !(capabilities.backupDirectory && context.backupLoaded) }
    };
    return controls;
}

function renderControlAvailability(els, controls) {
    for (const [name, control] of Object.entries(controls)) {
        const element = els[name];
        if (!element) continue;
        if (control.hidden !== undefined) element.classList.toggle('hidden', control.hidden);
        if (control.disabled !== undefined) {
            const loading = element.classList.contains?.('loading');
            if (loading && element.dataset) element.dataset.prevDisabled = control.disabled ? '1' : '0';
            element.disabled = Boolean(loading || control.disabled);
            element.classList.toggle('disabled', control.disabled);
        }
    }
}

module.exports = { deriveControlAvailability, renderControlAvailability };
