'use strict';

const { createFrontend } = require('../frontend');
const { createApplicationContext } = require('../runtime/context');
const { createWasmClient } = require('../runtime/wasm-client');
const { createSession } = require('../session');
const catalogs = Object.assign({},
    require('../catalog/devices'), require('../catalog/models'),
    require('../catalog/file-types'), require('../catalog/keymaps'),
    require('../catalog/locales'), require('../catalog/themes'));
const instances = new WeakMap();

// Import the production factories directly. Tests choose which real methods to
// install and supply the remaining dependencies as mocks in the same object.
function installFrontendFunctions(context, names) {
    let methods = instances.get(context);
    if (!methods) {
        for (const [key, value] of Object.entries(catalogs)) {
            if (!Object.hasOwn(context, key)) context[key] = value;
        }
        context.state ??= {};
        context.state.operationEpoch ??= 0;
        context.previewRenderId ??= 0;
        context.previewSession ??= null;
        context.LOCALE_CACHE ??= new Map([['en', context.I18N_EN]]);
        context.CREATE_HANDLE_RETRY_DELAY_MS ??= 300;
        context.PROGRESS_IDLE_TIMEOUT_MS ??= 5000;
        context.AUTO_QUERY_DELAY_MS ??= 500;
        context.MAX_LOG_LINES ??= 500;
        context.isFatalRuntimeError ??= require('../runtime/wasm-client').isFatalWasmRuntimeError;
        context.createFileModel ??= require('../features/file-model').createFileModel;
        context.getBackendCapabilities ??= require('../backends/capabilities').getBackendCapabilities;
        context.getEntryPermissions ??= require('../backends/capabilities').getEntryPermissions;
        context.deriveSelectionActions ??= require('../backends/capabilities').deriveSelectionActions;
        context.deriveControlAvailability ??= require('../features/capability-ui').deriveControlAvailability;
        context.renderControlAvailability ??= require('../features/capability-ui').renderControlAvailability;
        context.createFileBackends ??= require('../backends').createFileBackends;
        context.closeTISerialTransport ??= require('../runtime/transports').closeTISerialTransport;
        context.createFileActions ??= require('../features/file-actions').createFileActions;
        const platform = Object.create(globalThis);
        platform.globalThis = context;
        const deps = createApplicationContext(context, platform);
        context.wasmRuntime ??= createWasmClient({
            getGeneration: () => context.state.operationEpoch,
            minGapMs: context.CCALL_MIN_GAP_MS ?? 0,
            timeoutMs: Object.hasOwn(context, 'CCALL_TIMEOUT_MS') ? context.CCALL_TIMEOUT_MS : 12000
        });
        context.session ??= createSession(context.state, context.wasmRuntime);
        methods = createFrontend(deps);
        instances.set(context, methods);
        for (const [name, method] of Object.entries(methods)) {
            if (!Object.hasOwn(context, name)) context[name] = method;
        }
    }
    for (const name of names.flat()) {
        if (!methods[name]) throw new Error(`Unknown frontend method: ${name}`);
        context[name] = methods[name];
    }
    return context;
}

module.exports = { installFrontendFunctions };
