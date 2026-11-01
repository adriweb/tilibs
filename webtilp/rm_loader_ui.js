/* Standalone WebTILP native RM loader screen; no WASM/Cahute initialization. */
(function () {
'use strict';
const api = globalThis.WebTILPRMLoader;
const $ = id => document.getElementById(id);
const TEXT = {
    en: {
        selectModel: 'First select Casio RM-7000 or RM-9000 (native OS loader) in WebTILP Settings, then click Connect Calculator.',
        language: 'Language', back: 'Back to WebTILP', title: 'RM native loader — OS transfer',
        instructions: 'Hold OPTN + EXP while powering on to open Flash Memory. Use the Casio USB-to-2.5 mm serial cable, and close FA-124 first.',
        scope: 'Transfers the PROGRAM/OS only. The native LOADER is not included. The serial cable is not used to identify the installed PROGRAM or calculator model.',
        unsupported: "WebSerial requires desktop Chrome or Edge over HTTPS or localhost, or the Web'nTILP desktop app.",
        connect: 'Connect serial cable', disconnect: 'Disconnect / cancel transfer',
        sendTitle: 'Send OS to calculator',
        sendHint: 'On the calculator, choose Download [1], then confirm with [EXE]. Select an 896 KiB RM installation .bin. WebTILP checks the file before transmitting only the declared PROGRAM.',
        fileLabel: 'Installation file (.bin)', noFile: 'No installation file selected.',
        send: 'Send OS — calculator: Download [1] → EXE', receiveTitle: 'Receive OS from calculator',
        receiveHint: 'Start reception here first, then choose Upload [2] on the calculator and confirm with [EXE]. The received PROGRAM and its header are rebuilt into an installable .bin.',
        receive: 'Receive OS — then calculator: Upload [2] → EXE', noReceived: 'No complete OS received yet.',
        save: 'Save received OS (.bin)', metadata: 'Save header / transfer details', transferTitle: 'Transfer status', saveLog: 'Save diagnostic log',
        idle: 'Connect the serial cable to begin.', connected: 'Serial cable open at 19200 baud · 8O2. Choose a transfer direction.',
        recovery: 'After a transfer or an error the port closes. Before retrying, return to the Flash Memory menu and reconnect. Cancelling a send may leave an incomplete PROGRAM; reinstall a known-good .bin using Download [1], then [EXE].',
        image: '{name}: {size} KiB PROGRAM; expected Flash sum 0x{sum}. Installation-file checksum verified.',
        received: 'Last complete OS: {size} KiB PROGRAM received. Header and block checksums verified; installable .bin ready to save.',
        confirm: 'Send {name} ({size} KiB PROGRAM) to this RM calculator?\n\nChoose Download [1] in Flash Memory and confirm with [EXE] first. This replaces the installed PROGRAM. Keep the cable connected until completion.',
        sendDone: 'All PROGRAM blocks acknowledged. Verify the calculator restarts correctly; acknowledgements do not verify the physical Flash checksum or reboot.',
        receiveDone: 'Reception complete. Save the installable .bin and its transfer details. The header Flash sum was preserved, not recomputed from the PROGRAM.',
        cancelled: 'Transfer cancelled / port disconnected. Restart the calculator transfer before reconnecting.',
        error: 'Failed during {phase}: {error}', validating: 'Validating installation file…',
        connectPhase: 'Connecting: waiting for 0x13', receiveConnectPhase: 'Ready to receive: choose Upload [2], then press [EXE] now (waiting for 0x16, up to 120 s)',
        preparePhase: 'Preparing: waiting for Q after X (up to 6 minutes)', commandPhase: 'Waiting for the calculator Upload command X',
        headerPhase: 'Transferring and validating PROGRAM header', blocksPhase: 'Transferring PROGRAM blocks',
        selecting: 'Selecting / opening serial cable', closePhase: 'Closing serial cable',
        progress: '{done} / {total} KiB · block {block} / {blocks}', leave: 'A PROGRAM transfer is active. Leave and cancel it?'
    },
    fr: {
        selectModel: 'Sélectionnez d’abord Casio RM-7000 ou RM-9000 (native OS loader) dans les paramètres de WebTILP, puis cliquez sur Connecter la calculatrice.',
        language: 'Langue', back: 'Retour à WebTILP', title: 'Loader natif RM — transfert du système',
        instructions: 'Maintenez OPTN + EXP pendant l’allumage pour ouvrir Flash Memory. Utilisez le câble série Casio USB vers jack 2,5 mm et fermez FA-124 au préalable.',
        scope: 'Transfère uniquement le PROGRAM/système, sans le LOADER natif. Le câble série ne permet pas d’identifier le PROGRAM installé ni le modèle de calculatrice.',
        unsupported: 'WebSerial nécessite Chrome ou Edge sur ordinateur en HTTPS ou localhost, ou l’application Web’nTILP.',
        connect: 'Connecter le câble série', disconnect: 'Déconnecter / annuler le transfert', sendTitle: 'Envoyer le système à la calculatrice',
        sendHint: 'Sur la calculatrice, choisissez Download [1], puis validez avec [EXE]. Sélectionnez un .bin d’installation RM de 896 Kio. WebTILP vérifie le fichier puis envoie uniquement le PROGRAM déclaré.',
        fileLabel: 'Fichier d’installation (.bin)', noFile: 'Aucun fichier d’installation sélectionné.',
        send: 'Envoyer — calculatrice : Download [1] → EXE', receiveTitle: 'Recevoir le système de la calculatrice',
        receiveHint: 'Démarrez d’abord la réception ici, puis choisissez Upload [2] sur la calculatrice et validez avec [EXE]. Le PROGRAM reçu et son en-tête sont reconstruits en .bin installable.',
        receive: 'Recevoir — puis calculatrice : Upload [2] → EXE', noReceived: 'Aucun système complet reçu pour le moment.',
        save: 'Enregistrer le système reçu (.bin)', metadata: 'Enregistrer l’en-tête / les détails', transferTitle: 'État du transfert', saveLog: 'Enregistrer le journal',
        idle: 'Connectez le câble série pour commencer.', connected: 'Câble série ouvert à 19200 bauds · 8O2. Choisissez le sens du transfert.',
        recovery: 'Le port se ferme après un transfert ou une erreur. Avant de réessayer, revenez au menu Flash Memory et reconnectez le câble. Annuler un envoi peut laisser un PROGRAM incomplet ; réinstallez un .bin fonctionnel via Download [1], puis [EXE].',
        image: '{name} : PROGRAM de {size} Kio ; somme Flash attendue 0x{sum}. Somme du fichier d’installation vérifiée.',
        received: 'Dernier système complet : PROGRAM de {size} Kio reçu. Sommes de l’en-tête et des blocs vérifiées ; .bin installable prêt à enregistrer.',
        confirm: 'Envoyer {name} (PROGRAM de {size} Kio) à cette calculatrice RM ?\n\nChoisissez d’abord Download [1] dans Flash Memory, puis validez avec [EXE]. Le PROGRAM installé sera remplacé. Gardez le câble branché jusqu’à la fin.',
        sendDone: 'Tous les blocs du PROGRAM sont acquittés. Vérifiez le redémarrage de la calculatrice ; les acquittements ne prouvent ni la somme Flash physique ni le redémarrage.',
        receiveDone: 'Réception terminée. Enregistrez le .bin installable et ses détails. La somme Flash de l’en-tête est conservée, sans la recalculer à partir du PROGRAM.',
        cancelled: 'Transfert annulé / port déconnecté. Redémarrez le transfert sur la calculatrice avant de reconnecter.',
        error: 'Échec pendant « {phase} » : {error}', validating: 'Vérification du fichier d’installation…',
        connectPhase: 'Connexion : attente de 0x13', receiveConnectPhase: 'Réception prête : choisissez Upload [2], puis appuyez sur [EXE] maintenant (attente de 0x16, jusqu’à 120 s)',
        preparePhase: 'Préparation : attente de Q après X (jusqu’à 6 minutes)', commandPhase: 'Attente de la commande Upload X de la calculatrice',
        headerPhase: 'Transfert et vérification de l’en-tête du PROGRAM', blocksPhase: 'Transfert des blocs du PROGRAM',
        selecting: 'Sélection / ouverture du câble série', closePhase: 'Fermeture du câble série',
        progress: '{done} / {total} Kio · bloc {block} / {blocks}', leave: 'Un transfert du PROGRAM est en cours. Quitter et l’annuler ?'
    }
};
let settings = {};
try {
    settings = JSON.parse(localStorage.getItem('webtilp.settings') || '{}') || {};
    const theme = localStorage.getItem('webtilp.theme');
    if (theme) document.body.dataset.theme = theme;
} catch { /* Defaults also work when storage is disabled. */ }
let language = (settings.language && settings.language !== 'auto' ? settings.language : navigator.language).startsWith('fr') ? 'fr' : 'en';
const t = (key, values = {}) => TEXT[language][key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`);
let link = null, busy = false, opening = false, validating = false, image = null, selectedName = '', received = null;
let selection = 0, generation = 0, currentPhase = 'idle', lastProgress = null, leaving = false;
let statusKey = 'idle', statusValues = {}, statusError = false, logLines = [];
const selectedModel = { 'casio-rm7000': 'Casio RM-7000', 'casio-rm9000': 'Casio RM-9000' }[settings.calcModel];
const supported = Boolean(navigator.serial && (globalThis.isSecureContext || location.protocol === 'webntilp:'));
const sumText = sum => sum.toString(16).padStart(8, '0').toUpperCase();
function note(message) {
    logLines.push(`${new Date().toISOString()} ${message}`);
    if (logLines.length > 400) logLines.shift();
    $('rmLog').textContent = logLines.join('\n'); $('rmLog').scrollTop = $('rmLog').scrollHeight;
}
function status(key, values = {}, error = false) {
    statusKey = key; statusValues = values; statusError = error;
    $('rmStatus').textContent = t(key, values); $('rmStatus').classList.toggle('rm-error', error);
}
function update() {
    $('rmConnect').disabled = !supported || !selectedModel || opening || busy || Boolean(link);
    $('rmDisconnect').disabled = !link && !opening;
    $('rmSend').disabled = !link || busy || validating || !image;
    $('rmReceive').disabled = !link || busy || validating;
    $('rmFile').disabled = busy || opening;
    $('rmSave').disabled = !received; $('rmMetadata').disabled = !received;
    $('rmImage').textContent = image ? t('image', { name: selectedName, size: image.length / 1024, sum: sumText(image.expectedFlashSum) }) : t('noFile');
    $('rmReceived').textContent = received ? t('received', { size: received.payload.length / 1024 }) : t('noReceived');
    $('rmCount').textContent = lastProgress ? t('progress', lastProgress) : '';
}
function translate() {
    document.documentElement.lang = language; $('rmLanguage').value = language;
    document.querySelectorAll('[data-rm-text]').forEach(element => { element.textContent = t(element.dataset.rmText); });
    status(statusKey, statusValues, statusError); update();
}
function download(name, data, type = 'application/octet-stream') {
    const url = URL.createObjectURL(new Blob([data], { type })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function disconnect() {
    generation++; const old = link; link = null;
    // Keep the cancellation button available while requestPort/open is pending.
    status('cancelled'); note(t('cancelled')); update();
    if (old) {
        try { await old.close(); }
        catch (error) { note(`${t('closePhase')}: ${error.message}`); }
    }
    update();
}
$('rmConnect').addEventListener('click', async () => {
    if (opening || busy || link || !supported || !selectedModel) return;
    opening = true; const epoch = ++generation; currentPhase = 'selecting'; update();
    let candidate;
    try {
        // No VID/PID filter: the validated COM cable and adapters can omit USB IDs.
        const port = await navigator.serial.requestPort();
        if (epoch !== generation) return;
        candidate = new api.SerialLink(port);
        candidate.onError = error => {
            if (link === candidate && !busy) {
                note(error.message);
                disconnect();
            }
        };
        await candidate.open();
        if (candidate.failure) throw candidate.failure;
        if (epoch !== generation) { await candidate.close(); return; }
        link = candidate; status('connected'); note(t('connected'));
    } catch (error) {
        if (candidate && !candidate.closed) await candidate.close().catch(closeError => note(closeError.message));
        if (epoch === generation) {
            if (error.name === 'NotFoundError') status('idle');
            else { status('error', { phase: t('selecting'), error: error.message }, true); note($('rmStatus').textContent); }
        }
    } finally { opening = false; update(); }
});
$('rmDisconnect').addEventListener('click', disconnect);
$('rmFile').addEventListener('change', async event => {
    const epoch = ++selection, file = event.target.files[0]; image = null; validating = false; update();
    if (!file) return;
    validating = true; status('validating'); update();
    try {
        if (file.size !== api.INSTALLER_SIZE) throw new Error('Expected an 896 KiB RM installation .bin.');
        const parsed = api.parseInstaller(new Uint8Array(await file.arrayBuffer()));
        if (epoch !== selection) return;
        image = parsed; selectedName = file.name; update(); note($('rmImage').textContent);
        status(link ? 'connected' : 'idle');
    } catch (error) {
        if (epoch !== selection) return;
        status('error', { phase: t('validating'), error: error.message }, true); note($('rmStatus').textContent);
    } finally { if (epoch === selection) { validating = false; update(); } }
});
async function run(direction) {
    if (!link || busy || validating || (direction === 'send' && !image)) return;
    if (direction === 'send' && !confirm(t('confirm', { name: selectedName, size: image.length / 1024 }))) return;
    const active = link, epoch = generation; busy = true; lastProgress = null;
    $('rmProgress').value = 0; $('rmProgress').max = 1; update();
    let complete = false;
    const options = {
        phase(phase) {
            currentPhase = phase === 'connect' ? (direction === 'receive' ? 'receiveConnectPhase' : 'connectPhase') : `${phase}Phase`;
            status(currentPhase); note(t(currentPhase));
        },
        progress(done, total) {
            lastProgress = { done: done / 1024, total: total / 1024, block: done / api.BLOCK_SIZE, blocks: total / api.BLOCK_SIZE };
            $('rmProgress').max = total; $('rmProgress').value = done; update();
        }
    };
    try {
        if (direction === 'send') await api.sendProgram(active, image, options);
        else {
            const result = await api.receiveProgram(active, options);
            const installer = api.receivedToInstaller(result.header, result.payload);
            const digest = await crypto.subtle.digest('SHA-256', result.payload);
            if (epoch !== generation) return;
            received = { ...result, installer, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''), created: new Date().toISOString() };
        }
        if (epoch !== generation) return;
        complete = true; status(direction === 'send' ? 'sendDone' : 'receiveDone'); note($('rmStatus').textContent);
    } catch (error) {
        if (epoch === generation) {
            status('error', { phase: t(currentPhase), error: error.message }, true); note($('rmStatus').textContent);
        }
    } finally {
        try { await active.close(); }
        catch (error) { note(`${t('closePhase')}: ${error.message}`); }
        if (link === active) link = null;
        busy = false; update();
        if (complete) note('Serial port closed.');
    }
}
$('rmSend').addEventListener('click', () => run('send'));
$('rmReceive').addEventListener('click', () => run('receive'));
$('rmSave').addEventListener('click', () => {
    if (received) download(`casio-rm-program-${received.sha256.slice(0, 12)}.bin`, received.installer);
});
$('rmMetadata').addEventListener('click', () => {
    if (!received) return;
    download(`casio-rm-program-${received.sha256.slice(0, 12)}.json`, JSON.stringify({
        format: 'webtilp-rm-program-v1', created: received.created, serial: api.SERIAL_OPTIONS,
        header: Array.from(received.header), groups: received.groups, programBytes: received.length,
        expectedFlashSum: `0x${sumText(received.expectedFlashSum)}`, programSHA256: received.sha256,
        framingChecksumsVerified: true, flashChecksumVerified: false, physicalRebootVerified: false,
        installer: '896 KiB, canonical FF padding; original untransmitted padding is not retained.'
    }, null, 2), 'application/json');
});
$('rmLogSave').addEventListener('click', () => download('webtilp-rm-loader.log', logLines.join('\n') + '\n', 'text/plain'));
$('rmLanguage').addEventListener('change', event => { language = event.target.value; translate(); });
$('rmBack').addEventListener('click', event => {
    if (busy || opening) {
        if (!confirm(t('leave'))) event.preventDefault();
        else leaving = true;
    }
});
window.addEventListener('beforeunload', event => { if (!leaving && (busy || opening)) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { generation++; link?.close().catch(() => {}); });
navigator.serial?.addEventListener('disconnect', event => {
    if (link && (event.target === link.port || event.port === link.port)) disconnect();
});
$('rmSelectModel').classList.toggle('hidden', Boolean(selectedModel));
$('rmSelectedModel').textContent = selectedModel || '';
$('rmUnsupported').classList.toggle('hidden', supported);
translate();
// Register the common offline cache even when this is the first page visited.
if (location.protocol !== 'webntilp:' && navigator.serviceWorker) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(error => note(error.message));
}
})();
