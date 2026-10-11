'use strict';

/**
 * Wire feature dependencies at the application boundary. Factories only read
 * dependencies when a method is called, so mutually dependent UI callbacks can
 * be composed without importing or starting the browser entry point.
 */
function createApplicationContext(initial = {}, platform = globalThis) {
    const bindings = initial;
    const nativeFunctions = new Map();
    const boundPlatformMethods = new Set([
        'alert', 'confirm', 'prompt', 'fetch', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'requestAnimationFrame',
        'cancelAnimationFrame', 'createImageBitmap', 'getComputedStyle'
    ]);
    return new Proxy(bindings, {
        get(target, key) {
            if (key === 'provide') return dependencies => Object.assign(target, dependencies);
            if (Object.hasOwn(target, key)) return target[key];
            const value = platform[key];
            if (boundPlatformMethods.has(key) && typeof value === 'function') {
                if (!nativeFunctions.has(key)) nativeFunctions.set(key, value.bind(platform));
                return nativeFunctions.get(key);
            }
            return value;
        }
    });
}

module.exports = { createApplicationContext };
