// Recompile code against the already-built, unchanged local environment pack.
// A changed asset manifest requires the normal full `npm run build` instead.
import {readFile,stat,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {build,loadConfigFromFile} from 'vite';

for(const file of ['environments/world-manifest.json','environments/stream/manifest.json','environments/shadow-indices/manifest.json']){
  const [source,built]=await Promise.all([readFile(`public/${file}`),readFile(`dist/${file}`)]);
  if(!isDeepStrictEqual(source,built))throw Error(`Changed assets: run npm run build (${file})`);
}
const manifest=JSON.parse(await readFile('public/environments/world-manifest.json','utf8'));
const [sourceGround,builtGround]=await Promise.all([readFile(`public${manifest.terrain.url}`),readFile(`dist${manifest.terrain.url}`)]);
if(!isDeepStrictEqual(sourceGround,builtGround))throw Error('Changed terrain: run npm run build');
const streams=JSON.parse(await readFile('dist/environments/stream/manifest.json','utf8'));
const shadows=JSON.parse(await readFile('dist/environments/shadow-indices/manifest.json','utf8'));
const files=new Map([...streams.geometries,...shadows.geometries].map(item=>[item.url,item.bytes]));
for(const [url,bytes]of files)if((await stat(`dist${url}`)).size!==bytes)throw Error(`Incomplete assets: run npm run build (${url})`);
// Derived distance indices are independently versioned; original world data
// must still match the existing build before this targeted refresh is allowed.
const detailText=await readFile('public/environments/lod/manifest.json','utf8');
const detail=JSON.parse(detailText),detailBuffer=detail.buffer??detail.indices;
const hash=data=>createHash('sha256').update(data).digest('hex');
if(detail.version!==1||!detail.complete||detail.sourceManifestSha256!==hash(await readFile('public/environments/stream/manifest.json')))
  throw Error('Distance detail pack does not match the source world');
const relative=detailBuffer?.url?.replace(/^\//,'');
if(!relative||!relative.startsWith('environments/')||relative.split(/[\\/]/).includes('..'))throw Error('Invalid distance detail buffer path');
const detailBytes=await readFile(path.join('public',relative));
if(detailBytes.length!==detailBuffer.bytes||hash(detailBytes)!==detailBuffer.sha256)throw Error('Incomplete distance detail buffer');
await mkdir(path.dirname(path.join('dist',relative)),{recursive:true});
await copyFile(path.join('public',relative),path.join('dist',relative));
await mkdir('dist/environments/lod',{recursive:true});
await copyFile('public/environments/lod/manifest.json','dist/environments/lod/manifest.json');
const loaded=await loadConfigFromFile({command:'build',mode:'production'});
if(!loaded)throw Error('Missing Vite configuration');
await build({...loaded.config,configFile:false,plugins:loaded.config.plugins.filter(plugin=>plugin?.name!=='runtime-public-assets'),
  build:{...loaded.config.build,emptyOutDir:false}});
