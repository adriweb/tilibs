'use strict';

const assert = require('node:assert/strict');
const {
    HP_LEGACY_MAX_SEND_PACKET,
    HpLegacyBackend,
    KermitClient,
    applyNegotiatedParameters,
    computeChecksum,
    decodeData,
    decodeHpBinaryGrob,
    decodeHpBinaryString,
    decodeHpTransferredGrob,
    decodeHpTransferredString,
    encodeData,
    encodeDataChunks,
    makeHpTemporaryName,
    makePacket,
    parameterRequest,
    parseHpModelVersion,
    parseHpRdir,
    parsePacket
} = require('../hp_legacy_backend.js');

function packetWithoutTerminator(bytes) {
    return bytes.slice(0, -1);
}

const HP50_PARAMETER_ACK = Uint8Array.of(
    0x7E, 0x2A, 0x20, 0x40, 0x2D, 0x23, 0x20, 0x33
);

const HP50_C_KERMIT_I = Uint8Array.of(
    0x01, 0x39, 0x20, 0x49, 0x7E, 0x2F, 0x20, 0x40,
    0x2D, 0x23, 0x59, 0x33, 0x7E, 0x5E, 0x3E, 0x4A,
    0x29, 0x30, 0x5F, 0x5F, 0x5F, 0x46, 0x22, 0x55,
    0x31, 0x40, 0x35, 0x0D
);

const HP50_C_KERMIT_S = Uint8Array.of(
    0x01, 0x39, 0x20, 0x53, 0x7E, 0x2F, 0x20, 0x40,
    0x2D, 0x23, 0x59, 0x33, 0x7E, 0x5E, 0x3E, 0x4A,
    0x29, 0x30, 0x5F, 0x5F, 0x5F, 0x46, 0x22, 0x55,
    0x31, 0x40, 0x3F, 0x0D
);

const HP50_C_KERMIT_LCD_STO = Uint8Array.of(
    0x01, 0x35, 0x20, 0x43,
    0x4C, 0x43, 0x44, 0x23, 0xCD, 0x20,
    0x27, 0x57, 0x54, 0x49, 0x4C, 0x50, 0x31, 0x27,
    0x20, 0x53, 0x54, 0x4F,
    0x42, 0x0D
);

class ScriptedTransport {
    constructor(onWrite) {
        this.onWrite = onWrite;
        this.reads = [];
        this.writes = [];
        this.readCount = 0;
    }

    enqueue(packet) {
        this.reads.push(packet);
    }

    async write(bytes) {
        const copy = new Uint8Array(bytes);
        this.writes.push(copy);
        await this.onWrite(copy, this);
    }

    async read() {
        if (!this.reads.length) throw new Error('Scripted transport has no response.');
        this.readCount += 1;
        return this.reads.shift();
    }
}

function packNibbles(nibbles) {
    const output = new Uint8Array(Math.ceil(nibbles.length / 2));
    for (let index = 0; index < nibbles.length; index += 1) {
        output[index >> 1] |= (nibbles[index] & 0x0F) << ((index & 1) * 4);
    }
    return output;
}

function appendFiveNibbles(output, value) {
    for (let digit = 0; digit < 5; digit += 1) {
        output.push((value >>> (digit * 4)) & 0x0F);
    }
}

function makeGrobFixture(includeWrapper = true) {
    const width = 5;
    const height = 2;
    // The third nibble in each row is padding.  It verifies that decoding
    // uses the size-derived row stride instead of assuming tightly packed rows.
    const rows = [[0x5, 0x1, 0xF], [0xA, 0x0, 0xF]];
    const nibbles = [];
    appendFiveNibbles(nibbles, 0x02B1E);
    appendFiveNibbles(nibbles, 15 + rows.flat().length);
    appendFiveNibbles(nibbles, height);
    appendFiveNibbles(nibbles, width);
    nibbles.push(...rows.flat());
    const object = packNibbles(nibbles);
    if (!includeWrapper) return object;
    return Uint8Array.from([
        ...Buffer.from('HPHP49-C', 'ascii'),
        ...object
    ]);
}

function makeStringFixture(text, includeWrapper = true) {
    const nibbles = [];
    appendFiveNibbles(nibbles, 0x02A2C);
    appendFiveNibbles(nibbles, 5 + text.length * 2);
    for (const character of text) {
        const byte = character.charCodeAt(0);
        assert.ok(byte <= 0xFF, 'binary HP string fixtures must be Latin-1');
        nibbles.push(byte & 0x0F, byte >>> 4);
    }
    const object = packNibbles(nibbles);
    if (!includeWrapper) return object;
    return Uint8Array.from([
        ...Buffer.from('HPHP49-C', 'ascii'),
        ...object
    ]);
}

function makeAsciiGrobFixture() {
    // ASCII GROB rows are byte-aligned.  For a nine-pixel row, the fourth
    // nibble is padding and must not shift the start of the following row.
    return Uint8Array.from(Buffer.from(
        '%%HP: T(3)A(R)F(.);\r\nGROB 9 2\r\n 51\r\nF0 \n\tA01\r\nF \r\n',
        'ascii'));
}

function makeAsciiStringFixture(text) {
    return Uint8Array.from(Buffer.from(
        `%%HP: T(3)A(R)F(.);\r\n  "${text}" \r\n`, 'latin1'));
}

function testChecksumVectorsAndFraming() {
    const params = parameterRequest(3);
    assert.deepEqual([...params], [...HP50_C_KERMIT_I.slice(4, -2)]);
    assert.deepEqual([...computeChecksum(0, 'S', params, 1)], [63]);
    assert.deepEqual([...computeChecksum(0, 'S', params, 2)], [58, 62]);
    assert.deepEqual([...computeChecksum(0, 'S', params, 3)], [42, 44, 91]);
    assert.deepEqual(makePacket(0, 'I', params, 1), HP50_C_KERMIT_I);
    assert.deepEqual(makePacket(0, 'S', params, 1), HP50_C_KERMIT_S);
    const empty = makePacket(0, 'S', [], 1);
    assert.deepEqual([...empty], [1, 35, 32, 83, 56, 13]);
    assert.deepEqual(parsePacket(packetWithoutTerminator(empty), 1), {
        seq: 0,
        type: 'S',
        data: new Uint8Array(),
        checksumSize: 1,
        checksumValid: true,
        raw: packetWithoutTerminator(empty)
    });
}

function testBinaryQuotingRoundTripAndPacketLimit() {
    const params = applyNegotiatedParameters(Uint8Array.of(
        126, 35, 32, 64, 45, 35, 38, 51, 126
    ));
    const source = Uint8Array.from({ length: 256 }, (_, index) => index);
    assert.deepEqual(decodeData(encodeData(source, params), params), source);
    const chunks = encodeDataChunks(source, params);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length + 2 + params.checksumSize
        <= HP_LEGACY_MAX_SEND_PACKET));
}

function testRdirParsingWithSpacesAndWrappedLines() {
    const parsed = parseHpRdir(`
        { HOME EQUATION\n TRIGONOMETRY } 205651.
        TRIANGLE AREA 60.5 Algebraic 61717.
        HERONS RULE 26. Real Number 13207.
        TEST 57. Directory 59130.
    `);
    assert.deepEqual(parsed.pathParts, ['HOME', 'EQUATION', 'TRIGONOMETRY']);
    assert.equal(parsed.entries.length, 3);
    assert.deepEqual(parsed.entries.map(entry => [
        entry.name, entry.hpSize, entry.type_name, entry.checksum, entry.is_folder
    ]), [
        ['TRIANGLE AREA', '60.5', 'Algebraic', '61717.', 0],
        ['HERONS RULE', '26.', 'Real Number', '13207.', 0],
        ['TEST', '57.', 'Directory', '59130.', 1]
    ]);
}

function testBinaryGrobDecoding() {
    const expectedPixels = Uint8Array.of(
        1, 0, 1, 0, 1,
        0, 1, 0, 1, 0
    );
    for (const fixture of [makeGrobFixture(false), makeGrobFixture(true)]) {
        const decoded = decodeHpBinaryGrob(fixture);
        assert.equal(decoded.width, 5);
        assert.equal(decoded.height, 2);
        assert.deepEqual(decoded.pixels, expectedPixels);
        assert.deepEqual([...decoded.rgba.slice(0, 8)], [
            0, 0, 0, 255,
            255, 255, 255, 255
        ]);
        assert.equal(decoded.rgba.length, 5 * 2 * 4);
    }
    assert.deepEqual(
        decodeHpBinaryGrob(Uint8Array.from([
            ...Buffer.from('HPHP48-B', 'ascii'),
            ...makeGrobFixture(false)
        ])).pixels,
        expectedPixels
    );

    const truncated = makeGrobFixture(false).slice(0, -1);
    assert.throws(() => decodeHpBinaryGrob(truncated), /truncated/i);
    const wrongProlog = makeGrobFixture(false);
    wrongProlog[0] ^= 1;
    assert.throws(() => decodeHpBinaryGrob(wrongProlog), /prolog 02B1E/i);
    assert.throws(() => decodeHpBinaryGrob(Buffer.from('HPHP48', 'ascii')),
        /header is truncated/i);
    assert.throws(() => decodeHpBinaryGrob(Buffer.from('HPHP47-A', 'ascii')),
        /unsupported binary-file header/i);
}

function testBinaryStringDecoding() {
    const expected = 'HP50-C Revision #2.15\nCopyright \xA9 HP';
    assert.equal(decodeHpBinaryString(makeStringFixture(expected, false)), expected);
    assert.equal(decodeHpBinaryString(makeStringFixture(expected, true)), expected);
    assert.equal(decodeHpBinaryString(Uint8Array.from([
        ...Buffer.from('HPHP48-B', 'ascii'),
        ...makeStringFixture(expected, false)
    ])), expected);
    assert.equal(decodeHpBinaryString(makeStringFixture('', true)), '');

    const truncated = makeStringFixture(expected, false).slice(0, -1);
    assert.throws(() => decodeHpBinaryString(truncated), /truncated/i);
    const wrongProlog = makeStringFixture(expected, false);
    wrongProlog[0] ^= 1;
    assert.throws(() => decodeHpBinaryString(wrongProlog), /prolog 02A2C/i);

    const oddPayloadNibbles = [];
    appendFiveNibbles(oddPayloadNibbles, 0x02A2C);
    appendFiveNibbles(oddPayloadNibbles, 6);
    oddPayloadNibbles.push(1);
    assert.throws(() => decodeHpBinaryString(packNibbles(oddPayloadNibbles)),
        /invalid character payload size/i);
    assert.throws(() => decodeHpBinaryString(Buffer.from('HPHP48', 'ascii')),
        /header is truncated/i);
    assert.throws(() => decodeHpBinaryString(Buffer.from('HPHP47-A', 'ascii')),
        /unsupported binary-file header/i);
}

function testTransferredGrobAutoDecoding() {
    assert.deepEqual(decodeHpTransferredGrob(makeGrobFixture(true)),
        decodeHpBinaryGrob(makeGrobFixture(true)));

    const decoded = decodeHpTransferredGrob(makeAsciiGrobFixture());
    assert.equal(decoded.width, 9);
    assert.equal(decoded.height, 2);
    assert.deepEqual(decoded.pixels, Uint8Array.of(
        1, 0, 1, 0, 1, 0, 0, 0, 1,
        0, 1, 0, 1, 0, 0, 0, 0, 1
    ));
    assert.equal(decoded.rgba.length, 9 * 2 * 4);

    assert.throws(() => decodeHpTransferredGrob(Buffer.from(
        '%%HP: T(3)A(R)F(.);\nGROB 9 2 51F0A01', 'ascii')),
    /expected 8/i);
    assert.throws(() => decodeHpTransferredGrob(Buffer.from(
        '%%HP: T(3)A(R)F(.);\nGROB 9 2 51F0A01FF', 'ascii')),
    /expected 8/i);
    assert.throws(() => decodeHpTransferredGrob(Buffer.from(
        '%%HP: T(3)A(R)F(.);\nGROB 9 2 51F0A01Z', 'ascii')),
    /invalid hexadecimal/i);
}

function testTransferredStringAutoDecoding() {
    const expected = 'HP50-C Revision #2.15 Copyright HP 2009';
    assert.equal(decodeHpTransferredString(makeStringFixture(expected, true)), expected);
    assert.equal(decodeHpTransferredString(makeAsciiStringFixture(expected)), expected);
    assert.throws(() => decodeHpTransferredString(Buffer.from(
        '%%HP: T(3)A(R)F(.)\n"HP50-C Revision #2.15"', 'ascii')),
    /header is truncated/i);
    assert.throws(() => decodeHpTransferredString(Buffer.from(
        '%%HP: T(3)A(R)F(.);\nHP50-C Revision #2.15', 'ascii')),
    /ASCII HP string/i);
}

function testModelVersionParsingUsesSpecificRuntimeMarkers() {
    assert.deepEqual(parseHpModelVersion('HP50-C Revision #2.15 HP49-C HP48'), {
        modelId: 'hp50g',
        modelName: 'HP 50g',
        versionText: 'HP50-C Revision #2.15 HP49-C HP48'
    });
    assert.deepEqual(parseHpModelVersion('hp49-c Revision #2.00 HP48'), {
        modelId: 'hp49gplus',
        modelName: 'HP 49g+',
        versionText: 'hp49-c Revision #2.00 HP48'
    });
    assert.deepEqual(parseHpModelVersion('HP48 Revision R'), {
        modelId: 'hp48gii',
        modelName: 'HP 48gII',
        versionText: 'HP48 Revision R'
    });
    assert.deepEqual(parseHpModelVersion('unrecognized firmware'), {
        modelId: null,
        modelName: null,
        versionText: 'unrecognized firmware'
    });
}

function testTemporaryNameUsesSecureRandomBytes() {
    const source = {
        getRandomValues(output) {
            output.fill(0xAB);
            return output;
        }
    };
    assert.equal(makeHpTemporaryName(source), `WT${'AB'.repeat(12)}`);
}

async function testSendNegotiatesAndCapsPacketsAt80() {
    let checksumSize = 1;
    let dataNakSent = false;
    let retriedDataPackets = 0;
    const transport = new ScriptedTransport(async (wire, mock) => {
        const packet = parsePacket(packetWithoutTerminator(wire), checksumSize);
        assert.equal(packet.checksumValid, true);
        if (packet.type === 'S') {
            assert.deepEqual(wire, HP50_C_KERMIT_S);
            mock.enqueue(makePacket(0, 'Y', HP50_PARAMETER_ACK, 1));
            checksumSize = 3;
            return;
        }
        assert.ok(['F', 'D', 'Z', 'B'].includes(packet.type));
        if (packet.type === 'D' && packet.seq === 0 && !dataNakSent) {
            dataNakSent = true;
            retriedDataPackets += 1;
            mock.enqueue(makePacket(packet.seq, 'N', [], checksumSize));
            return;
        }
        if (packet.type === 'D' && packet.seq === 0
            && dataNakSent && retriedDataPackets === 1) {
            retriedDataPackets += 1;
        }
        mock.enqueue(makePacket(packet.seq, 'Y', [], checksumSize));
    });
    transport.enqueue(makePacket(0, 'N', [], 1));
    const client = new KermitClient(transport, { timeoutMs: 50, retries: 2 });
    const payload = Uint8Array.from({ length: 6000 }, (_, index) => index & 0xFF);
    await client.sendFile('TEST', payload);
    const dataPackets = transport.writes.slice(2, -2);
    assert.equal(retriedDataPackets, 2);
    assert.ok(dataPackets.length > 64);
    assert.ok(dataPackets.every(packet => packet.length - 1 <= HP_LEGACY_MAX_SEND_PACKET + 2),
        'SOH and LEN are outside the negotiated Kermit packet length');
}

async function testDirectoryGenericCommandAndInboundTransfer() {
    const listing = new TextEncoder().encode(
        '{ HOME } 205642.\nTEST 57. Directory 59130.\nIOPAR 29.5 List 45664.');
    let step = 0;
    const negotiated = applyNegotiatedParameters(parameterRequest(3));
    const transport = new ScriptedTransport(async (wire, mock) => {
        if (step === 0) {
            const packet = parsePacket(packetWithoutTerminator(wire), 1);
            assert.equal(packet.type, 'I');
            assert.deepEqual(wire, HP50_C_KERMIT_I);
            mock.enqueue(makePacket(0, 'Y', HP50_PARAMETER_ACK, 1));
        } else if (step === 1 || step === 2) {
            const packet = parsePacket(packetWithoutTerminator(wire), 1);
            assert.equal(packet.type, 'G');
            assert.equal(new TextDecoder().decode(decodeData(packet.data, negotiated)), 'D');
            mock.enqueue(step === 1
                ? makePacket(0, 'N', [], 1)
                : makePacket(0, 'S', parameterRequest(3), 1));
        } else if (step === 3) {
            const packet = parsePacket(packetWithoutTerminator(wire), 1);
            assert.equal(packet.type, 'Y');
            mock.enqueue(makePacket(1, 'X', encodeData(new TextEncoder().encode('File listing'), negotiated), 3));
        } else if (step === 4) {
            mock.enqueue(makePacket(2, 'D', encodeData(listing, negotiated), 3));
        } else if (step === 5) {
            mock.enqueue(makePacket(3, 'Z', [], 3));
        } else if (step === 6) {
            mock.enqueue(makePacket(4, 'B', [], 3));
        }
        step += 1;
    });
    transport.enqueue(makePacket(0, 'N', [], 1));
    const client = new KermitClient(transport, { timeoutMs: 50, retries: 2 });
    const response = await client.listDirectory();
    const parsed = parseHpRdir(response);
    assert.deepEqual(parsed.entries.map(entry => entry.name), ['TEST', 'IOPAR']);
}

async function testReceiveSkipsQueuedServerReadyPacket() {
    const payload = new TextEncoder().encode('HP50G-OBJECT');
    const negotiated = applyNegotiatedParameters(parameterRequest(3));
    let step = 0;
    const transport = new ScriptedTransport(async (wire, mock) => {
        const checksumSize = step < 3 ? 1 : 3;
        const packet = parsePacket(packetWithoutTerminator(wire), checksumSize);
        if (step === 0) {
            assert.equal(mock.readCount, 1,
                'R0 must not be written until the queued N0 has been consumed');
            assert.equal(packet.type, 'R');
            assert.equal(new TextDecoder().decode(decodeData(packet.data, negotiated)), 'TEST');
            mock.enqueue(makePacket(0, 'S', parameterRequest(3), 1));
        } else if (step === 1) {
            assert.equal(packet.type, 'Y');
            mock.enqueue(makePacket(1, 'F', encodeData(
                new TextEncoder().encode('TEST'), negotiated), 3));
        } else if (step === 2) {
            mock.enqueue(makePacket(2, 'D', encodeData(payload, negotiated), 3));
        } else if (step === 3) {
            mock.enqueue(makePacket(3, 'Z', [], 3));
        } else if (step === 4) {
            mock.enqueue(makePacket(4, 'B', [], 3));
        }
        step += 1;
    });
    transport.enqueue(makePacket(0, 'N', [], 1));
    const client = new KermitClient(transport, { timeoutMs: 50, retries: 2 });
    const received = await client.receiveFile('TEST');
    assert.equal(received.name, 'TEST');
    assert.deepEqual(received.data, payload);
}

async function testHostCommandUsesCWithChecksumOneAndAcceptsShortAck() {
    const negotiated = applyNegotiatedParameters(HP50_PARAMETER_ACK);
    let step = 0;
    const transport = new ScriptedTransport(async (wire, mock) => {
        if (step === 0) {
            assert.equal(mock.readCount, 1,
                'I0 must not be written until the queued N0 has been consumed');
            const packet = parsePacket(packetWithoutTerminator(wire), 1);
            assert.equal(packet.type, 'I');
            mock.enqueue(makePacket(0, 'Y', HP50_PARAMETER_ACK, 1));
        } else if (step === 1) {
            assert.deepEqual(wire, HP50_C_KERMIT_LCD_STO);
            const raw = packetWithoutTerminator(wire);
            const packet = parsePacket(raw, 1);
            assert.equal(packet.type, 'C');
            assert.equal(packet.seq, 0);
            assert.equal(packet.checksumValid, true);
            assert.equal(parsePacket(raw, 3).checksumValid, false,
                'the C0 packet must retain checksum size 1');
            const decodedCommand = decodeData(packet.data, negotiated);
            assert.deepEqual(decodedCommand,
                Uint8Array.from(Buffer.from("LCD\x8D 'WTILP1' STO", 'latin1')));
            mock.enqueue(makePacket(0, 'Y', encodeData(
                new TextEncoder().encode('OK'), negotiated), 1));
        }
        step += 1;
    });
    transport.enqueue(makePacket(0, 'N', [], 1));
    const client = new KermitClient(transport, { timeoutMs: 50, retries: 2 });
    assert.equal(await client.hostCommand("LCD\x8D 'WTILP1' STO"), 'OK');
    assert.equal(step, 2);
}

async function testHostCommandConsumesFullStackTextTransfer() {
    const payload = new TextEncoder().encode('1: "HP50 Serial Number: CNA123"\n');
    const negotiated = applyNegotiatedParameters(parameterRequest(3));
    let step = 0;
    const transport = new ScriptedTransport(async (wire, mock) => {
        const checksumSize = step < 3 ? 1 : 3;
        const packet = parsePacket(packetWithoutTerminator(wire), checksumSize);
        assert.equal(packet.checksumValid, true);
        if (step === 0) {
            assert.equal(packet.type, 'I');
            mock.enqueue(makePacket(0, 'Y', HP50_PARAMETER_ACK, 1));
        } else if (step === 1) {
            assert.equal(packet.type, 'C');
            assert.equal(new TextDecoder().decode(decodeData(packet.data, negotiated)),
                'SERIAL');
            mock.enqueue(makePacket(0, 'S', parameterRequest(3), 1));
        } else if (step === 2) {
            assert.equal(packet.type, 'Y');
            mock.enqueue(makePacket(1, 'X', encodeData(
                new TextEncoder().encode('REMOTE HOST'), negotiated), 3));
        } else if (step === 3) {
            mock.enqueue(makePacket(2, 'D', encodeData(payload, negotiated), 3));
        } else if (step === 4) {
            mock.enqueue(makePacket(3, 'Z', [], 3));
        } else if (step === 5) {
            mock.enqueue(makePacket(4, 'B', [], 3));
        }
        step += 1;
    });
    transport.enqueue(makePacket(0, 'N', [], 1));
    const client = new KermitClient(transport, { timeoutMs: 50, retries: 2 });
    assert.equal(await client.hostCommand('SERIAL'),
        '1: "HP50 Serial Number: CNA123"\n');
    assert.equal(step, 7, 'the complete X/D/Z/B transfer must be acknowledged');
}

async function testHostCommandSurfacesErrorPacket() {
    const negotiated = applyNegotiatedParameters(HP50_PARAMETER_ACK);
    let step = 0;
    const transport = new ScriptedTransport(async (wire, mock) => {
        const packet = parsePacket(packetWithoutTerminator(wire), 1);
        if (step === 0) {
            assert.equal(packet.type, 'I');
            mock.enqueue(makePacket(0, 'Y', HP50_PARAMETER_ACK, 1));
        } else {
            assert.equal(packet.type, 'C');
            mock.enqueue(makePacket(0, 'E', encodeData(
                new TextEncoder().encode('Invalid Server Cmd.'), negotiated), 1));
        }
        step += 1;
    });
    transport.enqueue(makePacket(0, 'N', [], 1));
    const client = new KermitClient(transport, { timeoutMs: 50, retries: 2 });
    await assert.rejects(client.hostCommand('NOT-A-COMMAND'), /Invalid Server Cmd\./);
}

async function testScreenshotCapturePreservesStackAndCleansUp() {
    const calls = [];
    const kermit = {
        async hostCommand(command) {
            calls.push(['host', command]);
            return '';
        },
        async receiveFile(name) {
            calls.push(['get', name]);
            return { name, data: makeAsciiGrobFixture() };
        }
    };
    const backend = new HpLegacyBackend({
        temporaryNameFactory: () => 'WTILPCAFEBABE'
    });
    backend.kermitEnabled = true;
    backend.kermit = kermit;
    const screenshot = await backend.captureScreenshot();
    assert.equal(screenshot.width, 9);
    assert.equal(screenshot.height, 2);
    assert.deepEqual(calls, [
        ['host', "LCD\x8D 'WTILPCAFEBABE' STO"],
        ['get', 'WTILPCAFEBABE'],
        ['host', "'WTILPCAFEBABE' PURGE"]
    ]);
    assert.ok(calls.filter(call => call[0] === 'host')
        .every(([, command]) => !command.includes('CLEAR')));
}

async function testScreenshotCleanupOnlyAfterSuccessfulCreation() {
    const creationCalls = [];
    const creationFailure = new HpLegacyBackend({
        temporaryNameFactory: () => 'WTILPDEADBEEF'
    });
    creationFailure.kermitEnabled = true;
    creationFailure.kermit = {
        async hostCommand(command) {
            creationCalls.push(command);
            throw new Error('creation failed');
        },
        async receiveFile() {
            assert.fail('GET must not run after failed screenshot creation');
        }
    };
    await assert.rejects(creationFailure.captureScreenshot(), /creation failed/);
    assert.deepEqual(creationCalls, ["LCD\x8D 'WTILPDEADBEEF' STO"]);

    const cleanupCalls = [];
    const receiveFailure = new HpLegacyBackend({
        temporaryNameFactory: () => 'WTILP01234567'
    });
    receiveFailure.kermitEnabled = true;
    receiveFailure.kermit = {
        async hostCommand(command) {
            cleanupCalls.push(command);
            return '';
        },
        async receiveFile(name) {
            cleanupCalls.push(`GET ${name}`);
            throw new Error('GET failed');
        }
    };
    await assert.rejects(receiveFailure.captureScreenshot(), /GET failed/);
    assert.deepEqual(cleanupCalls, [
        "LCD\x8D 'WTILP01234567' STO",
        'GET WTILP01234567',
        "'WTILP01234567' PURGE"
    ]);
}

async function testModelDetectionPreservesStackAndCleansUp() {
    const versionText = 'HP50-C Revision #2.15 Copyright HP 2009';
    const calls = [];
    const backend = new HpLegacyBackend({
        temporaryNameFactory: () => 'WTILP50CAFEBABE'
    });
    backend.kermitEnabled = true;
    backend.kermit = {
        async hostCommand(command) {
            calls.push(['host', command]);
            return '';
        },
        async receiveFile(name) {
            calls.push(['get', name]);
            return { name, data: makeAsciiStringFixture(versionText) };
        }
    };

    assert.deepEqual(await backend.detectModel(), {
        modelId: 'hp50g',
        modelName: 'HP 50g',
        versionText
    });
    assert.deepEqual(calls, [
        ['host', "VERSION + 'WTILP50CAFEBABE' STO"],
        ['get', 'WTILP50CAFEBABE'],
        ['host', "'WTILP50CAFEBABE' PURGE"]
    ]);
    assert.ok(calls.filter(call => call[0] === 'host')
        .every(([, command]) => !/CLEAR|DROP|SERIAL/.test(command)));
}

async function testSerialNumberReadPreservesStackAndCleansUp() {
    const serialText = 'HP50 Serial Number: CNA6110007';
    const calls = [];
    const backend = new HpLegacyBackend({
        temporaryNameFactory: () => 'WTILPSERIAL1234'
    });
    backend.kermitEnabled = true;
    backend.kermit = {
        timeoutMs: 20000,
        retries: 5,
        async hostCommand(command) {
            calls.push(['host', command]);
            return '';
        },
        async receiveFile(name) {
            calls.push(['get', name]);
            return { name, data: makeAsciiStringFixture(serialText) };
        }
    };

    assert.equal(await backend.readSerialNumber(), serialText);
    assert.deepEqual(calls, [
        ['host', "SERIAL 'WTILPSERIAL1234' STO"],
        ['get', 'WTILPSERIAL1234'],
        ['host', "'WTILPSERIAL1234' PURGE"]
    ]);
    assert.equal(backend.kermit.timeoutMs, 20000);
    assert.equal(backend.kermit.retries, 5);
}

async function testModelDetectionCleanupRequiresConfirmedCreation() {
    const creationCalls = [];
    const creationFailure = new HpLegacyBackend({
        temporaryNameFactory: () => 'WTILP49DEADBEEF'
    });
    creationFailure.kermitEnabled = true;
    creationFailure.kermit = {
        async hostCommand(command) {
            creationCalls.push(command);
            throw new Error('version creation failed');
        },
        async receiveFile() {
            assert.fail('GET must not run after failed version-object creation');
        }
    };
    await assert.rejects(creationFailure.detectModel(), /version creation failed/);
    assert.deepEqual(creationCalls, ["VERSION + 'WTILP49DEADBEEF' STO"]);

    const getCalls = [];
    const getFailure = new HpLegacyBackend({
        temporaryNameFactory: () => 'WTILP4801234567'
    });
    getFailure.kermitEnabled = true;
    getFailure.kermit = {
        async hostCommand(command) {
            getCalls.push(command);
            return '';
        },
        async receiveFile(name) {
            getCalls.push(`GET ${name}`);
            throw new Error('version GET failed');
        }
    };
    await assert.rejects(getFailure.detectModel(), /version GET failed/);
    assert.deepEqual(getCalls, [
        "VERSION + 'WTILP4801234567' STO",
        'GET WTILP4801234567',
        "'WTILP4801234567' PURGE"
    ]);

    const decodeCalls = [];
    const decodeFailure = new HpLegacyBackend({
        temporaryNameFactory: () => 'WTILPBAD1234567'
    });
    decodeFailure.kermitEnabled = true;
    decodeFailure.kermit = {
        async hostCommand(command) {
            decodeCalls.push(command);
            return '';
        },
        async receiveFile(name) {
            decodeCalls.push(`GET ${name}`);
            return { name, data: Uint8Array.of(0) };
        }
    };
    await assert.rejects(decodeFailure.detectModel(), /string header is truncated/i);
    assert.deepEqual(decodeCalls, [
        "VERSION + 'WTILPBAD1234567' STO",
        'GET WTILPBAD1234567',
        "'WTILPBAD1234567' PURGE"
    ]);
}

(async () => {
    testChecksumVectorsAndFraming();
    testBinaryQuotingRoundTripAndPacketLimit();
    testRdirParsingWithSpacesAndWrappedLines();
    testBinaryGrobDecoding();
    testBinaryStringDecoding();
    testTransferredGrobAutoDecoding();
    testTransferredStringAutoDecoding();
    testModelVersionParsingUsesSpecificRuntimeMarkers();
    testTemporaryNameUsesSecureRandomBytes();
    await testSendNegotiatesAndCapsPacketsAt80();
    await testDirectoryGenericCommandAndInboundTransfer();
    await testReceiveSkipsQueuedServerReadyPacket();
    await testHostCommandUsesCWithChecksumOneAndAcceptsShortAck();
    await testHostCommandConsumesFullStackTextTransfer();
    await testHostCommandSurfacesErrorPacket();
    await testScreenshotCapturePreservesStackAndCleansUp();
    await testScreenshotCleanupOnlyAfterSuccessfulCreation();
    await testModelDetectionPreservesStackAndCleansUp();
    await testSerialNumberReadPreservesStackAndCleansUp();
    await testModelDetectionCleanupRequiresConfirmedCreation();
    console.log('Old HP Kermit backend tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
