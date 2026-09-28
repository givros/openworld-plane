import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createWorldAssetFetcher } from '../src/world/fetchWorldAsset.ts';

test('local world fetching preserves the exact request and response',async()=>{
  const original=new Response('original'),controller=new AbortController(),init={signal:controller.signal,cache:'no-cache'};
  const url='http://localhost:4173/environments/world-manifest.json';
  const read=createWorldAssetFetcher({compression:'none',fetcher:async(actual,options)=>{
    assert.equal(actual,url);assert.equal(options,init);return original;
  }});
  assert.equal(await read(url,init),original);
});

test('gzip assets preserve the repository path and query and decode identical bytes',async()=>{
  const bytes=Uint8Array.from({length:32769},(_,index)=>(index*71)%256),compressed=gzipSync(bytes);
  const controller=new AbortController(),init={signal:controller.signal};
  const read=createWorldAssetFetcher({compression:'gzip',fetcher:async(url,options)=>{
    assert.equal(url,'https://givros.github.io/openworld-plane/environments/stream/geometry.bin.gz?v=7');
    assert.equal(options,init);
    return new Response(compressed,{status:200,statusText:'OK',headers:{'content-length':String(compressed.length),'content-type':'application/gzip','x-fixture':'preserved'}});
  }});
  const response=await read('https://givros.github.io/openworld-plane/environments/stream/geometry.bin?v=7',init);
  assert.equal(response.status,200);assert.equal(response.statusText,'OK');
  assert.equal(response.headers.get('content-length'),null);assert.equal(response.headers.get('x-fixture'),'preserved');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
});

test('gzip JSON is decoded before original manifest parsing',async()=>{
  const value={version:1,name:'Four Horizons',url:'/environments/stream/chunk.bin'};
  const read=createWorldAssetFetcher({compression:'gzip',fetcher:async()=>new Response(gzipSync(JSON.stringify(value)))});
  assert.deepEqual(await(await read('https://example.test/project/manifest.json')).json(),value);
});

test('failed HTTP responses pass through without attempting decompression',async()=>{
  const original=new Response('Not found',{status:404,statusText:'Not Found'});
  const read=createWorldAssetFetcher({compression:'gzip',fetcher:async()=>original});
  const response=await read('https://example.test/project/missing.bin');
  assert.equal(response,original);assert.equal(response.ok,false);assert.equal(await response.text(),'Not found');
});

test('network failures and damaged gzip files surface to the existing load policy',async()=>{
  const networkError=new TypeError('Network unavailable');
  const failed=createWorldAssetFetcher({compression:'gzip',fetcher:async()=>{throw networkError;}});
  await assert.rejects(failed('https://example.test/project/world.bin'),error=>error===networkError);
  const corrupt=createWorldAssetFetcher({compression:'gzip',fetcher:async()=>new Response('invalid compressed data')});
  await assert.rejects((await corrupt('https://example.test/project/world.bin')).arrayBuffer());
});

test('an already aborted world load does not initiate another request',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const read=createWorldAssetFetcher({compression:'gzip',fetcher:async()=>{calls++;return new Response();}});
  await assert.rejects(read('https://example.test/world.bin',{signal:controller.signal}),error=>error?.name==='AbortError');
  assert.equal(calls,0);
});

test('abort cancels the compressed stream and rejects an active decoded read',async()=>{
  const controller=new AbortController();let cancelled;
  const compressed=gzipSync(new Uint8Array(4096));
  const source=new ReadableStream({start(sink){sink.enqueue(compressed.subarray(0,12));},cancel(reason){cancelled=reason;}});
  const read=createWorldAssetFetcher({compression:'gzip',fetcher:async()=>new Response(source)});
  const response=await read('https://example.test/world.bin',{signal:controller.signal});
  const reading=response.arrayBuffer();controller.abort();
  await assert.rejects(reading,error=>error?.name==='AbortError');
  assert.equal(cancelled?.name,'AbortError');
});
