'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');

function extract(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    const next = /\n(?:async )?function \w+\(/g;
    next.lastIndex = start + 1;
    const end = next.exec(source);
    return source.slice(start, end ? end.index : source.length);
}

const functions = ['parseClockInfo', 'normalizeClockSettings', 'clockInfoToDate', 'getClockInfo',
    'syncClockToNow', 'syncClock', 'formatClockTimezone', 'formatClockDisplayBase',
    'formatClockDisplay', 'formatClockDisplayFromDate', 'buildClockRowKey', 'updateClockInfoRow'];
const clock = (extra = {}) => ({year: 2026, month: 11, day: 14, hours: 12, minutes: 34, seconds: 20,
    time_format: 24, date_format: 2, state: 1, timezone_minutes: 60, ...extra});

function harness(options = {}) {
    const calls = [], loading = [], logs = [], errors = [];
    const module = {};
    let syncCount = 0, readCount = 0;
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : [2026, 10, 14, 12, 34, 20])); }
    }
    const key = {textContent: 'Clock (at last refresh)', innerHTML: ''};
    const value = {innerHTML: 'Before sync'};
    const row = {querySelector: selector => selector === '.key' ? key : value};
    const context = vm.createContext({
        Date: FixedDate, console,
        state: {features: options.unsupported ? 0 : 1}, FEATURE_FLAGS: {OPS_CLOCK: 1},
        PROGRESS_IDLE_TIMEOUT_MS: 30000,
        els: {btnSyncClock: {}, deviceInfoList: {querySelectorAll: () => [row]}},
        authorizeDevice: async () => {}, promptCableMismatchResolution: () => false,
        ensureSilverlinkModelSelected: () => true, initModule: async () => module,
        ensureCableOpen: async () => 42, updateCapabilities: async () => {},
        setButtonLoading: (_button, active) => loading.push(active),
        log: text => logs.push(text), logError: (error, label) => errors.push({error, label}),
        formatErrorResult: (_module, result) => `error ${result}`,
        async ccallAsync(actualModule, name, returnType, types, args, callOptions) {
            assert.equal(actualModule, module);
            calls.push({name, returnType, types: Array.from(types), args: Array.from(args), callOptions});
            if (options.throwAt === calls.length) throw new Error('Cable disconnected');
            if (name === 'calc_sync_clock') {
                return options.results?.[syncCount++] ?? 0;
            }
            assert.equal(name, 'calc_get_clock_json');
            return JSON.stringify(options.readbacks?.[readCount++] ?? clock());
        }
    });
    vm.runInContext(functions.map(extract).join('\n'), context);
    return {context, calls, loading, logs, errors, value, module};
}

async function main() {
    {
        const h = harness();
        assert.equal(await h.context.syncClockToNow(h.module, 42, 17), 0);
        assert.equal(h.calls.length, 1);
        const call = h.calls[0];
        assert.equal(call.name, 'calc_sync_clock');
        assert.equal(call.returnType, 'number');
        assert.deepEqual(call.types, ['number', 'number']);
        assert.deepEqual(call.args, [42, 17], 'existing sync API receives the time adjustment');
        assert.equal(call.callOptions.useProgress, true);
    }

    const h = harness();
    for (const [offset, label] of [[60, 'UTC+01:00'], [-330, 'UTC-05:30'], [345, 'UTC+05:45'], [0, 'UTC+00:00']]) {
        assert.equal(h.context.formatClockTimezone(offset), label);
        const info = clock({timezone_minutes: offset});
        const settings = h.context.normalizeClockSettings(info);
        assert.equal(settings.timezoneMinutes, offset);
        assert.ok(h.context.formatClockDisplay(info).includes(label));
        assert.ok(h.context.formatClockDisplayFromDate(new Date(2026, 10, 14, 12, 34, 20), settings).includes(label));
    }
    for (const invalid of [null, undefined, '60', 1.5, NaN, Infinity, -32769, 32768, {}]) {
        assert.equal(h.context.formatClockTimezone(invalid), null);
        assert.ok(!h.context.formatClockDisplay(clock({timezone_minutes: invalid})).includes('UTC'));
    }
    assert.equal(h.context.normalizeClockSettings(clock({timezone_minutes: null})).timezoneMinutes, null);
    assert.equal(h.context.normalizeClockSettings({}).timezoneMinutes, null);
    assert.equal(h.context.formatClockDisplay(null), null);
    assert.equal(h.context.parseClockInfo('not json'), null);

    {
        const r = harness();
        await r.context.syncClock();
        assert.deepEqual(r.calls.map(call => call.name), ['calc_sync_clock', 'calc_get_clock_json']);
        assert.ok(r.value.innerHTML.includes('UTC+01:00'), 'successful readback updates the existing clock row');
        assert.ok(r.logs.some(line => line.startsWith('Clock synced to ')));
        assert.deepEqual(r.loading, [true, false]);
        assert.equal(r.errors.length, 0);
    }
    {
        const r = harness({readbacks: [clock({timezone_minutes: -330})]});
        await r.context.syncClock();
        assert.deepEqual(r.calls[0].args, [42, 0]);
        assert.ok(r.value.innerHTML.includes('UTC-05:30'));
    }
    {
        const r = harness({readbacks: [clock({timezone_minutes: null})]});
        await r.context.syncClock();
        assert.ok(!r.value.innerHTML.includes('UTC'), 'unsupported timezone does not masquerade as UTC zero');
        assert.ok(r.logs.some(line => line.startsWith('Clock synced to ')));
    }
    {
        const r = harness({readbacks: [clock({hours: 11}), clock()]});
        await r.context.syncClock();
        const syncs = r.calls.filter(call => call.name === 'calc_sync_clock');
        assert.deepEqual(syncs.map(call => call.args), [[42, 0], [42, 60]],
            'readback correction changes only the wall-clock adjustment');
        assert.ok(r.value.innerHTML.includes('UTC+01:00'));
        assert.ok(r.logs.some(line => line.startsWith('Clock synced (time corrected)')));
    }
    for (const options of [{results: [4]}, {readbacks: [clock({hours: 11})], results: [0, 4]}, {throwAt: 1}]) {
        const r = harness(options);
        await r.context.syncClock();
        assert.equal(r.value.innerHTML, 'Before sync', 'failed operation does not publish a successful clock readback');
        assert.deepEqual(r.loading, [true, false]);
        assert.ok(r.logs.some(line => line.startsWith('Clock sync failed')) || r.errors.length === 1);
        assert.ok(!r.logs.some(line => line.startsWith('Clock synced')));
    }
    {
        const r = harness({unsupported: true});
        await r.context.syncClock();
        assert.equal(r.calls.length, 0);
        assert.deepEqual(r.loading, [true, false]);
    }
    console.log('Clock timezone frontend passed: existing sync API, offset labels, readback UI and failure cleanup.');
}

main().catch(error => {console.error(error); process.exitCode = 1;});
