import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

/** Isolated headless test session. Deliberately does not enable CDP Network,
 * whose WebSocket-frame payload reporting duplicates the measured transport. */
export async function rawHeadlessPage(url) {
 const profile=await mkdtemp(path.join(tmpdir(),'givros-transport-'));
 const process=spawn(chromium.executablePath(),['--headless=new','--disable-gpu',
  '--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
  `--user-data-dir=${profile}`,'--disable-background-timer-throttling',
  '--disable-renderer-backgrounding','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((resolve,reject)=>{
  let output='';const timeout=setTimeout(()=>reject(new Error('Headless browser startup timed out')),20000);
  process.stderr.on('data',chunk=>{output+=chunk.toString();const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
  process.once('error',reject);process.once('exit',code=>reject(new Error(`Headless process ended: ${code}`)));
 });
 const socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let sequence=0;const pending=new Map();
 socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const waiter=pending.get(message.id);pending.delete(message.id);if(message.error)waiter.reject(new Error(JSON.stringify(message.error)));else waiter.resolve(message.result);}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
 const {targetId}=await call('Target.createTarget',{url});
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 const evaluate=async(expression)=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 for(let i=0;i<100;i++){if(await evaluate('document.readyState === "complete" && location.href !== "about:blank"'))break;await new Promise(resolve=>setTimeout(resolve,50));}
 return {evaluate:async(fn,argument)=>evaluate(`(${fn.toString()})(${JSON.stringify(argument)})`),
  close:async()=>{try{await call('Browser.close');}catch{}socket.close();if(process.exitCode===null)await new Promise(resolve=>{const timeout=setTimeout(()=>{process.kill();resolve();},3000);process.once('exit',()=>{clearTimeout(timeout);resolve();});});},profile};
}
