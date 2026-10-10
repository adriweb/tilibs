const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const {SharpBackend} = require('../sharp_backend.js');
// Usage: node webtilp/tools/sharp_native.cjs version list screen backup receive system rom
// 'listen' passively records 45 seconds; it sends no calculator commands.
// SHARP_OUTPUT_DIR selects a private capture directory; no ROM/RAM is committed.
// SHARP_MODEL selects an exact model when the default Auto mode is ambiguous.
const output = process.env.SHARP_OUTPUT_DIR || path.join(require('node:os').tmpdir(), 'sharp-celk4-' + Date.now());
fs.mkdirSync(output, {recursive:true});
console.log('CAPTURE DIRECTORY', output);
const child = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, 'sharp_usb_bridge.py')], {stdio:['pipe','pipe','inherit']});
const pending = new Map(); let seq = 0, controller;
const trace = fs.createWriteStream(path.join(output, 'trace.jsonl'));
const log = data => trace.write(JSON.stringify({time:new Date().toISOString(), ...data})+'\n');
createInterface({input:child.stdout}).on('line', line => {
 const msg=JSON.parse(line);
 if(msg.rx) { log({rx:msg.rx}); controller?.enqueue(Buffer.from(msg.rx,'hex')); }
 else if(msg.id) { const p=pending.get(msg.id); pending.delete(msg.id); msg.error?p.reject(new Error(msg.error)):p.resolve(); }
 else if(msg.error) controller?.error(new Error(msg.error));
});
const call = data => new Promise((resolve,reject) => { const id=++seq; pending.set(id,{resolve,reject}); child.stdin.write(JSON.stringify({id,...data})+'\n'); });
child.on('exit', code => {
 for (const p of pending.values()) p.reject(new Error('Native USB bridge exited (' + code + ')'));
 pending.clear();
});
child.on('error', error => {
 for (const p of pending.values()) p.reject(error);
 pending.clear();
});
const port = {
 async open(options) {
   await call({op:'open',baud:options.baudRate,stop:options.stopBits});
   this.readable=new ReadableStream({start(c){controller=c;},cancel(){controller=null;}});
   this.writable=new WritableStream({async write(data){log({tx:Buffer.from(data).toString('hex')});await call({op:'write',hex:Buffer.from(data).toString('hex')});}});
 },
 async close(){await call({op:'close'});this.readable=null;this.writable=null;},
 async setOptions({baudRate,stopBits}){await call({op:'configure',baud:baudRate,stop:stopBits});log({configure:{baudRate,stopBits}});}
};
(async()=>{
 // The timeout is for inactivity; a progressing large frame may take longer.
 let lastPercent = null;
 const backend=new SharpBackend({serialPort:port,model:process.env.SHARP_MODEL || 'sharp-auto',timeoutMs:Number(process.env.SHARP_TIMEOUT_MS || 30000),
  onProgress(progress) {
   log({progress});
   const percent=progress.total ? Math.floor(progress.completed/progress.total*100) : null;
   if(percent!==null && percent!==lastPercent) console.log('PROGRESS',percent+'%',progress.completed+'/'+progress.total);
   lastPercent=percent;
  }});
 try {
  await backend.connect();
  for(const op of process.argv.slice(2)) {
   console.log('START',op);
   if(op==='listen') {
    console.log('LISTENING for 45 seconds; start the calculator transfer now.');
    await new Promise(resolve=>setTimeout(resolve,45000));
    console.log('PASSIVE BYTES',backend.queue.length,Buffer.from(backend.queue).toString('hex'));
   }
   else if(op==='version') console.log('VERSION',await backend.readVersion());
   else if(op==='list') {const entries=await backend.listVariables();console.log('DIRECTORY',JSON.stringify(entries));fs.writeFileSync(path.join(output,'directory.json'),JSON.stringify(entries,null,2));}
   else if(op==='screen') {const result=await backend.captureScreenshot();console.log('SCREEN',Object.keys(result));fs.writeFileSync(path.join(output,'screen.json'),JSON.stringify(result));}
   else if(op==='backup') {const result=await backend.receiveBackup();fs.writeFileSync(path.join(output,result.filename),result.data);console.log('BACKUP',result.filename,result.data.length);}
   else if(op==='system'||op==='rom') {
    console.log('LISTENING for REPROGRAM '+(op==='rom'?'3:Send(with Boot Page)':'2:Send')+' at 19200 then 38400 baud.');
    const result=await backend.receiveDump({includeBoot:op==='rom'});
    fs.writeFileSync(path.join(output,result.filename),result.data);
    fs.writeFileSync(path.join(output,result.filename+'.json'),JSON.stringify(result.manifest,null,2));
    console.log('DUMP',result.filename,result.data.length,JSON.stringify(result.manifest));
   }
   else if(op==='receive') {
    const entries=await backend.listVariables();
    for(const entry of entries) {
     const result=await backend.receiveVariable(entry);
     const filename=path.basename(result.filename);
     fs.writeFileSync(path.join(output,filename),result.data);
     console.log('RECEIVED',filename,result.data.length);
    }
   }
   else throw new Error('Unknown operation');
  }
 } finally {await backend.close().catch(console.error);child.stdin.end();trace.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
