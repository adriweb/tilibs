if (typeof Module !== 'undefined' && typeof importScripts === 'undefined') {
    Module.preRun = () => {
        ENV.G_MESSAGES_DEBUG = 'all';
    };
}
