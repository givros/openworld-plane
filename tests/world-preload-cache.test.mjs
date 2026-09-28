import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldPreloadCache } from '../src/world/WorldPreloadCache.ts';

const hash='a'.repeat(64),otherHash='b'.repeat(64);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const abortError=error=>error?.name==='AbortError';

test('equal manifest content aliases share one immutable raw buffer and one fetch',async()=>{
  const binary=new ArrayBuffer(16),reads=[];
  const cache=new WorldPreloadCache({readBinary:async path=>{reads.push(path);return binary;},readJSON:async()=>({})});
  cache.addBinary('/original.bin',16,hash);cache.addBinary('/alias.bin',16,hash.toUpperCase());
  cache.addBinary('/alias.bin',16,hash);
  const progress=[];await cache.preload(stats=>progress.push(stats));
  assert.deepEqual(reads,['/original.bin']);assert.equal(await cache.readBinary('/original.bin'),binary);
  assert.equal(await cache.readBinary('/alias.bin'),binary);
  assert.deepEqual(cache.stats,{completed:1,total:1,bytes:16,jsonEntries:0,binaryEntries:1,dedupAliases:1,cacheHits:2,networkReads:1,pending:0,complete:true});
  assert.equal(progress[0].completed,0);assert.equal(progress.at(-1).complete,true);
  cache.dispose();assert.equal(binary.byteLength,16,'world release does not detach buffers borrowed by existing consumers');
});

test('equal lengths without manifest hashes do not alias different assets',async()=>{
  let reads=0;
  const cache=new WorldPreloadCache({readBinary:async()=>{reads++;return new ArrayBuffer(2);},readJSON:async()=>({})});
  cache.addBinary('/a',2);cache.addBinary('/b',2);await cache.preload();
  assert.equal(reads,2);assert.notEqual(await cache.readBinary('/a'),await cache.readBinary('/b'));cache.dispose();
});

test('manifest definitions reject malformed identities, type conflicts, and conflicting aliases',()=>{
  const cache=new WorldPreloadCache({readBinary:async()=>new ArrayBuffer(2),readJSON:async()=>({})});
  assert.throws(()=>cache.addBinary('/a',-1),/byte length/);
  assert.throws(()=>cache.addBinary('/a',2.5),/byte length/);
  assert.throws(()=>cache.addBinary('/a',2,'invalid'),/SHA-256/);
  assert.throws(()=>cache.addBinary('/a',undefined,hash),/SHA-256/);
  assert.throws(()=>cache.addBinary('',2),/path/);
  cache.addBinary('/a',2,hash);
  assert.throws(()=>cache.addBinary('/a',3,hash),/Conflicting/);
  assert.throws(()=>cache.addBinary('/a',2,otherHash),/Conflicting/);
  assert.throws(()=>cache.addBinary('/alias',3,hash),/Conflicting/);
  assert.throws(()=>cache.addJSON('/a'),/Conflicting/);
  cache.addJSON('/json');assert.throws(()=>cache.addBinary('/json'),/Conflicting/);
  assert.equal(cache.stats.total,2);cache.dispose();
});

test('binary and JSON work share the bounded concurrency queue including cache misses',async()=>{
  const calls=[],gates=new Map();let active=0,peak=0;
  const load=async(path,json=false)=>{calls.push(path);active++;peak=Math.max(peak,active);const gate=deferred();gates.set(path,gate);await gate.promise;active--;return json?{path}:new ArrayBuffer(4);};
  const cache=new WorldPreloadCache({concurrency:2,readBinary:path=>load(path),readJSON:path=>load(path,true)});
  cache.addBinary('/one');cache.addJSON('/two');cache.addBinary('/three');
  const preloading=cache.preload(),miss=cache.readBinary('/four');await tick();
  assert.equal(calls.length,2);assert.equal(cache.stats.pending,4);
  gates.get('/one').resolve();await tick();assert.equal(calls.length,3);
  gates.get('/two').resolve();await tick();assert.equal(calls.length,4);
  gates.get('/three').resolve();gates.get('/four').resolve();await Promise.all([preloading,miss]);
  assert.equal(peak,2);assert.equal(cache.stats.completed,4);assert.equal(cache.stats.complete,true);cache.dispose();
});

test('aborting an individual binary waiter never cancels shared world preload',async()=>{
  const gate=deferred(),consumer=new AbortController();let sharedSignal,reads=0;
  const cache=new WorldPreloadCache({readBinary:async(_path,signal)=>{reads++;sharedSignal=signal;return gate.promise;},readJSON:async()=>({})});
  cache.addBinary('/asset');const preloading=cache.preload();
  const cancelled=cache.readBinary('/asset',consumer.signal),other=cache.readBinary('/asset');await tick();
  consumer.abort();await assert.rejects(cancelled,abortError);assert.equal(sharedSignal.aborted,false);
  const binary=new ArrayBuffer(3);gate.resolve(binary);await preloading;assert.equal(await other,binary);assert.equal(reads,1);
  assert.equal(cache.stats.complete,true);cache.dispose();
});

test('aborting a JSON waiter leaves the decoded JSON cached for the other consumer',async()=>{
  const gate=deferred(),consumer=new AbortController();let sharedSignal;
  const cache=new WorldPreloadCache({readBinary:async()=>new ArrayBuffer(0),readJSON:async(_path,signal)=>{sharedSignal=signal;return gate.promise;}});
  const cancelled=cache.readJSON('/cell',consumer.signal),other=cache.readJSON('/cell');await tick();
  consumer.abort();await assert.rejects(cancelled,abortError);assert.equal(sharedSignal.aborted,false);
  const data={matrices:{url:'/matrix',bytes:64}};gate.resolve(data);assert.equal(await other,data);
  assert.equal(await cache.readJSON('/cell'),data);assert.equal(cache.stats.jsonEntries,1);cache.dispose();
});

test('already cancelled reads cannot enqueue or start a request',async()=>{
  const controller=new AbortController();controller.abort();let reads=0;
  const cache=new WorldPreloadCache({readBinary:async()=>{reads++;return new ArrayBuffer(0);},readJSON:async()=>{reads++;return{};}});
  await assert.rejects(cache.readBinary('/asset',controller.signal),abortError);
  await assert.rejects(cache.readJSON('/cell',controller.signal),abortError);
  assert.equal(reads,0);assert.equal(cache.stats.total,0);cache.dispose();
});

test('dispose promptly rejects shared loads, clears ownership, and ignores late loader results',async()=>{
  const gate=deferred();let sharedSignal;
  const cache=new WorldPreloadCache({readBinary:async(path,signal)=>{sharedSignal=signal;return path==='/ready'?new ArrayBuffer(8):gate.promise;},readJSON:async()=>({})});
  await cache.readBinary('/ready');cache.addBinary('/pending');const preloading=cache.preload();
  const reader=cache.readBinary('/pending');await tick();cache.dispose();
  await assert.rejects(preloading,abortError);await assert.rejects(reader,abortError);
  assert.equal(sharedSignal.aborted,true);assert.equal(cache.stats.bytes,0);assert.equal(cache.stats.total,0);assert.equal(cache.stats.pending,0);
  gate.resolve(new ArrayBuffer(12));await tick();assert.equal(cache.stats.bytes,0);assert.equal(cache.stats.binaryEntries,0);
  await assert.rejects(cache.readBinary('/new'),abortError);await assert.rejects(cache.preload(),abortError);
  assert.throws(()=>cache.addJSON('/new'),abortError);cache.dispose();
});

test('lifetime cancellation works both before construction and during loads',async()=>{
  for(const alreadyAborted of [true,false]){
    const lifetime=new AbortController();let reads=0,sharedSignal;
    if(alreadyAborted)lifetime.abort();
    const cache=new WorldPreloadCache({signal:lifetime.signal,readBinary:async(_path,signal)=>{reads++;sharedSignal=signal;return new Promise(()=>{});},readJSON:async()=>({})});
    const reading=cache.readBinary('/asset');if(!alreadyAborted){await tick();lifetime.abort();}
    await assert.rejects(reading,abortError);assert.equal(reads,alreadyAborted?0:1);
    if(sharedSignal)assert.equal(sharedSignal.aborted,true);assert.equal(cache.stats.complete,false);cache.dispose();
  }
});

test('a loader failure aborts other workers, clears completed assets, and rejects all callers',async()=>{
  const broken=deferred(),ignored=deferred();let slowSignal;
  const cache=new WorldPreloadCache({concurrency:2,readBinary:async(path,signal)=>{
    if(path==='/ready')return new ArrayBuffer(4);
    if(path==='/broken')return broken.promise;slowSignal=signal;return ignored.promise;
  },readJSON:async()=>({})});
  await cache.readBinary('/ready');cache.addBinary('/broken');cache.addBinary('/slow');cache.addBinary('/queued');
  const preloading=cache.preload(),reading=cache.readBinary('/slow');await tick();
  broken.reject(new Error('Fixture fetch failed'));
  await assert.rejects(preloading,/Fixture fetch failed/);await assert.rejects(reading,/Fixture fetch failed/);
  assert.equal(slowSignal.aborted,true);assert.equal(cache.stats.networkReads,3);assert.equal(cache.stats.total,0);assert.equal(cache.stats.bytes,0);
  ignored.resolve(new ArrayBuffer(16));await tick();assert.equal(cache.stats.completed,0);cache.dispose();
});

test('wrong byte lengths and non-buffer binary loader output fail before entering the cache',async()=>{
  for(const value of [new ArrayBuffer(3),new Uint8Array(4)]){
    const cache=new WorldPreloadCache({readBinary:async()=>value,readJSON:async()=>({})});
    cache.addBinary('/asset',4,hash);await assert.rejects(cache.preload(),/byte length|ArrayBuffer/);
    assert.equal(cache.stats.bytes,0);assert.equal(cache.stats.binaryEntries,0);cache.dispose();
  }
});

test('metadata preloading can discover matrix binaries for a second phase without repeated reads',async()=>{
  const calls=[];
  const cache=new WorldPreloadCache({readJSON:async path=>{calls.push(path);return{matrices:{url:'/matrix',bytes:64,sha256:hash}};},
    readBinary:async path=>{calls.push(path);return new ArrayBuffer(64);}});
  cache.addJSON('/cell');await cache.preload();assert.equal(cache.stats.complete,true);
  const cell=await cache.readJSON('/cell');cache.addBinary(cell.matrices.url,cell.matrices.bytes,cell.matrices.sha256);
  assert.equal(cache.stats.complete,false);assert.equal(cache.stats.completed,1);await cache.preload();
  assert.deepEqual(calls,['/cell','/matrix']);assert.equal(cache.stats.complete,true);assert.equal(cache.stats.completed,2);
  assert.equal(cache.stats.bytes,64);await cache.preload();assert.deepEqual(calls,['/cell','/matrix']);cache.dispose();
});

test('a later exact size declaration checks an already cached unplanned binary',async()=>{
  const cache=new WorldPreloadCache({readBinary:async()=>new ArrayBuffer(4),readJSON:async()=>({})});
  const value=await cache.readBinary('/asset');assert.throws(()=>cache.addBinary('/asset',8),/byte length/);
  cache.addBinary('/asset',4,hash);cache.addBinary('/alias',4,hash);assert.equal(await cache.readBinary('/alias'),value);cache.dispose();
});

test('invalid concurrency is rejected and observer failures abort preload cleanly',async()=>{
  const options={readBinary:async()=>new ArrayBuffer(4),readJSON:async()=>({})};
  for(const concurrency of [0,-1,1.1,Infinity])assert.throws(()=>new WorldPreloadCache({...options,concurrency}),/concurrency/);
  const cache=new WorldPreloadCache(options);cache.addBinary('/asset');
  await assert.rejects(cache.preload(()=>{throw new Error('Fixture progress failure');}),/Fixture progress failure/);
  assert.equal(cache.stats.networkReads,0);assert.equal(cache.stats.total,0);cache.dispose();
});
