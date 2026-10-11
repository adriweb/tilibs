'use strict';

const { createTiFileBackend } = require('./ti');
const { createHpPrimeFileBackend } = require('./hp-prime');
const { createNumWorksFileBackend } = require('./numworks');
const { createCasioFileBackend } = require('./casio');
const { createHpLegacyFileBackend } = require('./hp-legacy');
const { createSharpFileBackend } = require('./sharp');

function createFileBackends(deps) {
    return Object.fromEntries([
        createTiFileBackend(deps), createHpPrimeFileBackend(deps), createNumWorksFileBackend(deps),
        createCasioFileBackend(deps), createHpLegacyFileBackend(deps), createSharpFileBackend(deps)
    ].map(backend => [backend.family, backend]));
}

module.exports = { createFileBackends };
