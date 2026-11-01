/* Optional private-corpus regression; no firmware or captures are copied here.
 * node webtilp/tests/test_rm_loader_captures.cjs /path/to/webtilp-rm-loader-handoff
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const api = require('../rm_loader_backend.js');
const { MockPort } = require('./test_rm_loader.js');
const corpus = process.argv[2];
if (!corpus) throw new Error('Supply the private handoff directory; this test does not download firmware.');
const read = name => fs.readFileSync(path.join(corpus, 'reference/private', name));
const unhex = value => Buffer.from(value.replaceAll(' ', ''), 'hex');
(async () => {
    for (const [name, firmware, roundtrip] of [
        ['fx7400-upload', 'fx7400gp_zx_1.0_rm.bin', false],
        ['fx7400-roundtrip', 'fx7400gp_zx_1.0_rm.bin', true],
        ['cfx9850gb-1.0-upload', 'cfx9850gbp_zx_1.0_rm.bin', false]
    ]) {
        const trace = JSON.parse(read(`captures/${name}.trace.json`));
        assert.deepEqual(trace.serial, api.SERIAL_OPTIONS);
        const stream = direction => Buffer.concat(trace.events.filter(event => event.direction === direction).map(event => unhex(event.hex)));
        const rx = stream('RX'), tx = stream('TX');
        assert.deepEqual(rx, read(`captures/${name}.rx.bin`));
        let written = 0;
        const port = new MockPort({ input: rx, chunkSizes: [1, 3, 37, 4096, 17, 8193], onWrite(data) {
            assert.deepEqual(Buffer.from(data), tx.subarray(written, written + data.length), 'TX matches physical recording');
            written += data.length;
        } });
        const link = new api.SerialLink(port); await link.open();
        const received = await api.receiveProgram(link, { pause: async () => {} });
        const image = api.parseInstaller(read(`firmware/${firmware}`));
        assert.deepEqual(received.header, image.header); assert.deepEqual(received.payload, image.payload);
        const rebuilt = api.parseInstaller(api.receivedToInstaller(received.header, received.payload));
        assert.deepEqual(rebuilt.header, image.header); assert.deepEqual(rebuilt.payload, image.payload);
        // A canonical installer preserves transmitted bytes, not padding which
        // was never uploaded by the calculator. Do not compare full containers.
        if (roundtrip) await api.sendProgram(link, rebuilt, { pause: async () => {} });
        assert.equal(written, tx.length); assert.equal(link.available, 0);
        await link.close();
        console.log(`PASS ${name}: ${received.length / 1024} KiB, all header/block checksums and recorded ACKs, installer round trip${roundtrip ? ', recorded send' : ''}; SHA-256 ${crypto.createHash('sha256').update(received.payload).digest('hex')}`);
    }
    const failed = JSON.parse(read('captures/no-handshake-reply.trace.json'));
    assert.deepEqual(failed.events.map(event => [event.direction, event.hex]), [['TX', '16']]);
    console.log('PASS private corpus: 3 native receives and 1 native send; no hardware accessed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
