import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const env={...process.env,PAGES_BUILD:'1',VITE_WORLD_ASSET_COMPRESSION:'gzip'};
async function run(relative,args){
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,relative),...args],{cwd:root,env,stdio:'inherit',windowsHide:true});
    child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  if(result.code!==0)throw new Error(`Pages build failed (${result.signal??result.code}): ${relative}`);
}

// Invoke the local tools directly: the ordinary build restores raw local assets,
// whereas Pages publishes only their byte-identical gzip representations.
await run('node_modules/typescript/bin/tsc',['--noEmit']);
await run('node_modules/vite/bin/vite.js',['build']);
