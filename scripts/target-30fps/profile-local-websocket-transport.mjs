import http from 'node:http';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Isolated local-only transport measurement. No world, rendering or user browser.
const sizes = [0, 4, 8, 16, 32].map(mib => mib * 1024 * 1024);
const buffers = new Map(sizes.map(size => [size, Buffer.alloc(size, 173)]));
const server = http.createServer((request, response) => {
  const size = Number(new URL(request.url, 'http://localhost').searchParams.get('size'));
  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Local transport measurement</title>');
    return;
  }
  if (request.url.startsWith('/frame') && buffers.has(size)) {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'Content-Length': size, 'Cache-Control': 'no-store' });
      response.end(buffers.get(size));
    });
    return;
  }
  response.writeHead(404); response.end();
});
const sockets=new Set();
server.on('upgrade',(request,socket)=>{
 sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setNoDelay(true);
 const accept=createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 let pending=Buffer.alloc(0);
 socket.on('data',chunk=>{
  pending=Buffer.concat([pending,chunk]);
  while(pending.length>=2){
   const opcode=pending[0]&15,masked=(pending[1]&128)!==0,length=pending[1]&127;
   if(opcode===8){socket.end();return;}if(!masked||length>=126){socket.destroy();return;}
   if(pending.length<6+length)return;
   const payload=Buffer.alloc(length);for(let i=0;i<length;i++)payload[i]=pending[6+i]^pending[2+(i&3)];
   pending=pending.subarray(6+length);if(opcode!==2||length!==4){socket.destroy();return;}
   const size=payload.readUInt32LE(),body=buffers.get(size);if(!body){socket.destroy();return;}
   const header=Buffer.alloc(size<126?2:10);header[0]=130;if(size<126)header[1]=size;else{header[1]=127;header.writeBigUInt64BE(BigInt(size),2);}
   socket.cork();socket.write(header);socket.write(body);socket.uncork();
  }
 });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(),
  args: ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const results = await page.evaluate(async sizes => {
    const rows=[];
    const socket=new WebSocket(location.origin.replace('http:','ws:'));socket.binaryType='arraybuffer';
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    for (const bytes of sizes) {
      const times = [];
      for (let frame = 0; frame < 24; frame++) {
        const start = performance.now();
        const pending=new Promise(resolve=>{socket.onmessage=event=>resolve(event.data);});socket.send(new Uint32Array([bytes]));
        const frameData=await pending;
        const data = new Uint8Array(frameData);
        if (frameData.byteLength !== bytes || (bytes && (data[0] !== 173 || data[bytes-1] !== 173)))
          throw new Error('Frame transport lost data');
        if (frame >= 4) times.push(performance.now() - start);
      }
      times.sort((a,b) => a-b);
      rows.push({ bytes, medianMs: times[Math.floor(times.length/2)], p95Ms: times[Math.ceil(times.length*.95)-1], samples: times.length });
    }
    socket.close();return rows;
  }, sizes);
  const report = { timestamp: new Date().toISOString(), results,
    scope: 'Uncompressed local WebSocket request and browser ArrayBuffer delivery only. Excludes native readback, rendering and GPU upload.' };
  await writeFile('artifacts/four-horizons/target-30fps/local-websocket-transport.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); for(const socket of sockets)socket.destroy();await new Promise(resolve => server.close(resolve)); }
