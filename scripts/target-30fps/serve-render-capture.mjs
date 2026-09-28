import http from 'node:http';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';

// Temporary project-local artifact sink for the isolated graphics capture.
const root=path.resolve('artifacts/four-horizons/target-30fps/native-render-capture');
await mkdir(path.join(root,'blobs'),{recursive:true});
const token=randomBytes(24).toString('hex');
const server=http.createServer(async(request,response)=>{
 const origin=request.headers.origin;
 if(origin&&origin!=='http://127.0.0.1:5173'){response.writeHead(403);response.end();return;}
 if(origin)response.setHeader('Access-Control-Allow-Origin',origin);
 response.setHeader('Access-Control-Allow-Methods','POST, PUT, OPTIONS');
 response.setHeader('Access-Control-Allow-Headers','Content-Type, X-Capture-Key');
 if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
 const reply=(code,value)=>{response.writeHead(code,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
 if(request.headers['x-capture-key']!==token){reply(403,{error:'Invalid capture session'});return;}
 try{
  const match=request.url.match(/^\/blob\/(b\d+)$/);
  if(request.method==='PUT'&&match){
   const name=match[1],destination=path.join(root,'blobs',`${name}.bin`),hash=createHash('sha256');let bytes=0;
   const measure=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>2147483648){callback(new Error('Capture blob exceeds limit'));return;}hash.update(chunk);callback(null,chunk);}});
   await pipeline(request,measure,createWriteStream(destination));
   reply(200,{file:`blobs/${name}.bin`,byteLength:bytes,sha256:hash.digest('hex')});return;
  }
  if(request.method==='POST'&&/^\/(capture|frame-\d+)\.json$/.test(request.url)){
   const chunks=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>67108864)throw new Error('Capture command log exceeds limit');chunks.push(chunk);}
   const contents=Buffer.concat(chunks),value=JSON.parse(contents.toString('utf8'));
   await writeFile(path.join(root,request.url.slice(1)),JSON.stringify(value));
   reply(200,{file:request.url.slice(1),bytes:contents.length});return;
  }
  reply(404,{error:'Unknown capture artifact'});
 }catch(error){if(!response.headersSent)reply(500,{error:error.message});else response.destroy(error);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const state={url:`http://127.0.0.1:${server.address().port}`,token,root,pid:process.pid};
await writeFile(path.join(root,'session.json'),JSON.stringify(state));
console.log(JSON.stringify({url:state.url,root,pid:process.pid}));
