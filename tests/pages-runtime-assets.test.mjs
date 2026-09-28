import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { copyRuntimeAssets } from '../vite.config.ts';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'plane-pages-assets-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from('{"version":1,"name":"Four Horizons"}'),gzip=gzipSync(bytes);
  const entry={path:'environments/world-manifest.json',bytes:bytes.length,sha256:hash(bytes),gzipBytes:gzip.length,gzipSha256:hash(gzip),packedPath:'files/world-manifest.json.gz'};
  const pack=path.join(root,'repository-assets/runtime'),output=path.join(root,'output');
  await mkdir(path.join(root,'public/environments'),{recursive:true});await mkdir(path.join(pack,'files'),{recursive:true});
  await writeFile(path.join(root,'public',entry.path),bytes);await writeFile(path.join(pack,entry.packedPath),gzip);
  const setEntries=entries=>writeFile(path.join(pack,'manifest.json'),JSON.stringify({version:1,entries}));
  await setEntries([entry]);
  return{root,entry,bytes,gzip,pack,output,setEntries};
}

test('normal builds copy only manifested original assets',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'public/environments/unreferenced.bin'),'excluded');
  await copyRuntimeAssets(f.root,f.output,false);
  assert.deepEqual(await readFile(path.join(f.output,f.entry.path)),f.bytes);
  await assert.rejects(stat(path.join(f.output,'environments/unreferenced.bin')),{code:'ENOENT'});
  await assert.rejects(stat(path.join(f.output,f.entry.path+'.gz')),{code:'ENOENT'});
});

test('Pages builds work from the compressed repository pack without raw public assets',async t=>{
  const f=await fixture(t);await rm(path.join(f.root,'public'),{recursive:true});
  await copyRuntimeAssets(f.root,f.output,true);
  assert.deepEqual(await readFile(path.join(f.output,f.entry.path+'.gz')),f.gzip);
  await assert.rejects(stat(path.join(f.output,f.entry.path)),{code:'ENOENT'});
});

test('runtime build inputs reject paths escaping either asset root and duplicate destinations',async t=>{
  const f=await fixture(t);
  for(const mutation of [{path:'environments/../../outside'},{path:'/environments/absolute'},{path:'environments\\outside'},{packedPath:'files/../outside.gz'},{packedPath:'C:/outside.gz'}]){
    await f.setEntries([{...f.entry,...mutation}]);
    await assert.rejects(copyRuntimeAssets(f.root,f.output,true),/Invalid or duplicate/);
  }
  await f.setEntries([f.entry,f.entry]);await assert.rejects(copyRuntimeAssets(f.root,f.output,true),/Invalid or duplicate/);
});

test('both raw and compressed copy paths verify bytes and SHA-256',async t=>{
  const f=await fixture(t);
  await f.setEntries([{...f.entry,sha256:'0'.repeat(64)}]);
  await assert.rejects(copyRuntimeAssets(f.root,f.output,false),/checksum mismatch/);
  await f.setEntries([{...f.entry,gzipBytes:f.entry.gzipBytes+1}]);
  await assert.rejects(copyRuntimeAssets(f.root,f.output,true),/checksum mismatch/);
  await f.setEntries([{...f.entry,gzipSha256:'0'.repeat(64)}]);
  await assert.rejects(copyRuntimeAssets(f.root,f.output,true),/checksum mismatch/);
});

test('Pages rejects oversized compressed sites before starting file copies',async t=>{
  const f=await fixture(t);await f.setEntries([{...f.entry,gzipBytes:1_000_000_001}]);
  await assert.rejects(copyRuntimeAssets(f.root,f.output,true),/1 GB site limit/);
  await assert.rejects(stat(f.output),{code:'ENOENT'});
});
