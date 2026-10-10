'use strict';
const assert = require('node:assert/strict');
const {SharpUsbPort, createPort, shouldUse} = require('../sharp_usb.js');
const {SharpBackend, frame, checksum, CATEGORIES, RAM_SIZE} = require('../sharp_backend.js');
const reply = p => frame(Uint8Array.from(p), '9:');
class Device {
    constructor() {
        this.vendorId=0x04fc; this.productId=0x0201; this.opened=false; this.calls=[]; this.pending=[]; this.input=[];
        const alternate={alternateSetting:0,endpoints:[{type:'bulk',direction:'in',endpointNumber:1,packetSize:16},{type:'bulk',direction:'out',endpointNumber:2}]};
        this.configuration={configurationValue:1,interfaces:[{interfaceNumber:0,alternate,alternates:[alternate]}]};
    }
    async open(){this.opened=true;this.calls.push(['open']);}
    async claimInterface(n){assert.equal(n,0);}
    async clearHalt(direction,n){this.calls.push(['halt',direction,n]);}
    async controlTransferOut(setup){this.calls.push(['control',setup]);return {status:'ok',bytesWritten:0};}
    async transferIn(n,size){assert.equal(n,1); return new Promise((resolve,reject)=>{this.pending.push({resolve,reject,size});this.flush();});}
    flush(){
        while(this.pending.length && this.input.length){
            const request=this.pending[0]; let count=0, packets=0, complete=false;
            for(const packet of this.input){
                count+=packet.length;packets++;
                if(count>=request.size || packet.length<16){complete=true;break;}
            }
            if(!complete)return; // Full USB packets do not terminate a larger read.
            assert.ok(count<=request.size);
            this.pending.shift();
            const bytes=Uint8Array.from(Buffer.concat(this.input.splice(0,packets)));
            request.resolve({status:'ok',data:new DataView(bytes.buffer)});
        }
    }
    feed(data){for(let i=0;i<data.length;i+=16)this.input.push(data.slice(i,i+16));this.flush();}
    async transferOut(n,bytes){
        assert.equal(n,2);this.calls.push(['write',bytes.slice()]);
        if(this.partial)return {status:'ok',bytesWritten:bytes.length-1};
        this.respond?.(bytes);return {status:'ok',bytesWritten:bytes.length};
    }
    async close(){this.opened=false;this.calls.push(['close']);for(const p of this.pending.splice(0))p.reject(new Error('USB closed'));}
}
(async()=>{
    assert.equal(shouldUse({usb:{},serial:{},platform:'MacIntel'}),true);
    assert.equal(shouldUse({usb:{},serial:{},platform:'Win32'}),false);
    assert.equal(shouldUse({usb:{},platform:'Linux'}),true);
    assert.equal(shouldUse({serial:{},platform:'MacIntel'}),false);
    assert.throws(()=>new SharpUsbPort({vendorId:0x0451,productId:0xe008}),/CE-LK4/);
    const device=new Device(); assert.equal(createPort(device),createPort(device));
    const port=createPort(device);
    await assert.rejects(port.open({baudRate:9600}),/settings/);assert.equal(device.opened,false);
    let step=0;
    device.respond=bytes=>{
        const commands=[0x42,0x63,1,1,1];
        assert.deepEqual(bytes,frame(Uint8Array.of(commands[step])));
        if(step===0)device.feed(reply([1]));
        if(step===1){device.feed(reply([1]));device.feed(reply([0x23]));}
        if(step===2)device.feed(reply([132,0,64,0]));
        if(step===3)device.feed(reply(new Uint8Array(1056)));
        step++;
    };
    const backend=new SharpBackend({serialPort:port,model:'sharp-el9950',timeoutMs:1000});
    await backend.connect();
    assert.deepEqual(device.calls.find(c=>c[0]==='control')[1],{requestType:'vendor',recipient:'device',request:0x21,value:0x0709,index:0});
    assert.equal((await backend.captureScreenshot()).rgba.length,132*64*4);
    assert.equal(step,5,'screenshot must not send an end command');
    await backend.close();assert.equal(device.opened,false);assert.equal(device.pending.length,0);
    // One program produces exactly 16 wire bytes. The device sends no ZLP;
    // requesting a larger USB buffer would deadlock before the host ACK.
    const directoryDevice=new Device(); let directoryStep=0;
    const selector=Uint8Array.from(Buffer.from('INTEGRAL\0\0\0'));
    const category=Uint8Array.from(Buffer.from('PROGRAM    '));
    const directoryScript=[
        [frame([0x42]),reply([1])], [frame([0x61]),reply([1])],
        [frame(category),Uint8Array.from([...reply([1]),...reply([0x21])])],
        [frame([1]),reply(category)], [frame([1]),reply([1,...selector])],
        [frame([1]),null], [frame([0x41]),reply([1])]
    ];
    assert.equal(directoryScript[4][1].length,16);
    directoryDevice.respond=packet=>{
        const [expected,response]=directoryScript[directoryStep++];assert.deepEqual(packet,expected);
        if(response)directoryDevice.feed(response);
    };
    const directoryBackend=new SharpBackend({serialPort:new SharpUsbPort(directoryDevice),model:'sharp-el9950',timeoutMs:50});
    await directoryBackend.connect();
    const names=await directoryBackend.operation(()=>directoryBackend.readDirectory(CATEGORIES[0]));
    assert.deepEqual(names,Uint8Array.from([1,...selector]));assert.equal(directoryStep,directoryScript.length);
    await directoryBackend.close();
    // The USB engine can fill already-submitted requests while JavaScript is
    // busy. Model UART bursts with a finite 512-byte adapter FIFO: a lone read
    // loses bytes between callbacks, but queued packet-sized reads retain them.
    class BufferedDevice extends Device {
        constructor() { super(); this.dropped = 0; }
        burst(data) {
            for (let offset = 0; offset < data.length; offset += 16) {
                const packet = data.slice(offset, offset + 16);
                this.input.push(packet); this.flush();
                if (this.input.length > 32) {
                    this.input.pop(); this.dropped += packet.length;
                }
            }
        }
        feed(data) {
            if (data.length < RAM_SIZE) { this.burst(data); return; }
            for (let offset = 0; offset < data.length; offset += 1024) {
                setTimeout(() => this.burst(data.slice(offset, offset + 1024)), offset / 1024 * 2);
            }
        }
    }
    const buffered = new BufferedDevice();
    const ram = Uint8Array.from({length: RAM_SIZE}, (_, i) => (i * 17 ^ i >>> 8) & 255);
    const ramLength = new Uint8Array(4); new DataView(ramLength.buffer).setUint32(0, RAM_SIZE, true);
    const backupScript = [
        [frame([0x42]), reply([1])], [frame([0x67]), Uint8Array.from([...reply([1]), ...reply([0x27])])],
        [frame([1]), reply(ramLength)], [frame([1]), reply(ram)],
        [frame([1]), null], [frame([0x41]), reply([1])]
    ];
    let backupStep = 0;
    buffered.respond = bytes => {
        const [expected, response] = backupScript[backupStep++]; assert.deepEqual(bytes, expected);
        if (response) buffered.feed(response);
    };
    const bufferedBackend = new SharpBackend({serialPort: new SharpUsbPort(buffered),
        model: 'sharp-el9950', timeoutMs: 1000});
    await bufferedBackend.connect();
    assert.deepEqual((await bufferedBackend.receiveBackup()).data.slice(54), ram);
    assert.equal(buffered.dropped, 0, 'continuous UART data survives delayed JavaScript callbacks');
    assert.equal(backupStep, backupScript.length);
    await bufferedBackend.close(); assert.equal(buffered.pending.length, 0);
    // Both dump choices retain their queued USB reads across UART changes.
    // The first fast frame reproduces the separately captured four-byte damage.
    const dumpPacket = (address, payload) => {
        const h = Buffer.alloc(6); h.writeUInt32LE(address); h.writeUInt16LE(payload.length, 4);
        const body = Uint8Array.from([...h, ...payload]), sum = checksum(body);
        return Uint8Array.from([...body, sum & 255, sum >>> 8]);
    };
    for (const includeBoot of [false, true]) {
        const dumpDevice = new Device(), dumpPort = new SharpUsbPort(dumpDevice);
        const payload = Uint8Array.from({length: 0x4000}, (_, i) => (0x81 + i) & 255);
        const system = dumpPacket(0xF00000, payload);
        let stage = 'header';
        const setup = dumpDevice.controlTransferOut.bind(dumpDevice);
        dumpDevice.controlTransferOut = async options => {
            const result = await setup(options);
            if (options.value === 0x0307) dumpDevice.feed(dumpPacket(0, [57, 57, 1, 0x80, Number(includeBoot)]));
            if (options.value === 0x0309) {
                assert.equal(stage, 'switch'); stage = 'system';
                dumpDevice.feed(Uint8Array.from([0x18, 0x1C, 0x10, 0xFF, ...system.subarray(6)]));
            }
            return result;
        };
        dumpDevice.respond = data => {
            assert.equal(Buffer.from(data).toString(), 'OK');
            if (stage === 'header' && includeBoot) {
                stage = 'boot'; dumpDevice.feed(dumpPacket(0xFFE000, new Uint8Array(0x2000).fill(7)));
            } else if (stage === 'header' || stage === 'boot') stage = 'switch';
            else if (stage === 'system') { stage = 'end'; dumpDevice.feed(dumpPacket(0xFFFFFFFF, [])); }
            else { assert.equal(stage, 'end'); stage = 'done'; }
        };
        const backend = new SharpBackend({serialPort: dumpPort, timeoutMs: 200});
        await backend.connect(); const result = await backend.receiveDump({includeBoot});
        assert.deepEqual(result.data.subarray(0, payload.length), payload);
        assert.deepEqual(result.manifest.recoveredFirstHeader.rawPrefix, [0x18, 0x1C, 0x10, 0xFF]);
        assert.equal(stage, 'done');
        assert.deepEqual(dumpDevice.calls.filter(c => c[0] === 'control').map(c => c[1].value), [0x0709, 0x0307, 0x0309, 0x0709]);
        assert.equal(dumpDevice.calls.filter(c => c[0] === 'open').length, 1);
        assert.equal(dumpDevice.calls.filter(c => c[0] === 'close').length, 0);
        assert.equal(dumpDevice.pending.length, 64, 'input pipeline retained across UART changes');
        await backend.close(); assert.equal(dumpDevice.pending.length, 0);
        await assert.rejects(dumpPort.setOptions({baudRate: 38400, stopBits: 1}), /closed/);
    }
    const partial=new Device(), p=new SharpUsbPort(partial);partial.partial=true;
    await p.open({baudRate:19200,stopBits:1});
    assert.equal(partial.calls.find(c=>c[0]==='control')[1].value,0x0307);
    const writer=p.writable.getWriter();await assert.rejects(writer.write(Uint8Array.of(1,2)),/Incomplete/);
    assert.equal(partial.calls.filter(c=>c[0]==='write').length,1,'partial writes must never replay');
    writer.releaseLock();await p.close();
    // Emergency reset must close the USB device before waiting for a writer
    // whose transferOut cannot otherwise be cancelled.
    const stalled = new Device();
    let enteredWrite, rejectWrite;
    const writing = new Promise(resolve => { enteredWrite = resolve; });
    stalled.transferOut = () => new Promise((_resolve, reject) => { rejectWrite = reject; enteredWrite(); });
    const closeDevice = stalled.close.bind(stalled);
    stalled.close = async () => { rejectWrite?.(new Error('USB write cancelled')); await closeDevice(); };
    const stuck = new SharpBackend({serialPort:new SharpUsbPort(stalled),model:'sharp-el9950',timeoutMs:1000});
    await stuck.connect();
    const operation = stuck.operation(async () => 1);
    const rejected = assert.rejects(operation, /cancelled/);
    await writing;
    let watchdog;
    try { await Promise.race([stuck.close(), new Promise((_resolve,reject) => {
        watchdog = setTimeout(() => reject(new Error('USB cancellation hung')), 500);
    })]); } finally { clearTimeout(watchdog); }
    await rejected; assert.equal(stalled.opened,false);
    console.log('Sharp WebUSB routing, UART setup, screenshot, buffered backup, partial-write failure and pending-read teardown passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
