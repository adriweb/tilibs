'use strict';

/**
 * runtime bridge. Browser and application dependencies are injected
 * by app.js; importing this module does not start the application.
 * @param {object} dependencies
 * @returns {object}
 */
function createRuntimeBridge(dependencies) {
    function runWasmOperation(module, operation) {
        return dependencies.wasmRuntime.runOperation(module, operation);
    }

    return { runWasmOperation };
}

module.exports = { createRuntimeBridge };
