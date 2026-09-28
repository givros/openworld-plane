// Local-only production benchmark build; reuse the exact public assets in place.
import {build} from 'vite';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {stat,readFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),baseline=process.env.SOURCE_BASELINE==='1',snapshot=process.env.SOURCE_SNAPSHOT??(baseline?'artifacts/performance-20260926/baseline-source':null);
const out=path.resolve(process.env.PROFILE_BUILD_DIR??`artifacts/performance-20260926/bundle${baseline?'-baseline':''}`);
await build({configFile:false,root,base:'./',plugins:[{name:'preserved-baseline',enforce:'pre',async load(id){
  if(!snapshot||!id.startsWith(path.join(root,'src').replaceAll('\\','/')+'/'))return;
  const relative=path.relative(path.join(root,'src'),id);
  try{return await readFile(path.join(root,snapshot,relative),'utf8');}catch{return;}
}},{name:'isolated-benchmark-access',transform(code,id){
  if(!id.replaceAll('\\','/').endsWith('/src/game/Game.ts'))return;
  return `import { reuseExactShadowVertices } from '../world/reuseExactVertices';\n`+code.replace('this.expose();','window.__reuseExactShadowVertices = reuseExactShadowVertices; this.expose();');
}}],build:{outDir:out,emptyOutDir:true,copyPublicDir:false,minify:process.env.PROFILE_MINIFY==='1',rollupOptions:{output:{manualChunks:id=>id.includes('/node_modules/three/')?'three':undefined}}}});
if(process.argv.includes('--build-only'))process.exit(0);
const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.wasm':'application/wasm'};
createServer(async(req,res)=>{
  try{
    const name=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname).replace(/^\/+/, '')||'index.html';
    const base=name.startsWith('assets/')||name==='index.html'?out:path.join(root,'public');
    const file=path.resolve(base,name);if(!file.startsWith(base+path.sep))throw Error('Path outside benchmark root');
    const info=await stat(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]??'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-store'});createReadStream(file).pipe(res);
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(Number(process.env.PROFILE_PORT??(baseline?4181:4180)),'127.0.0.1',()=>console.log(`Performance build: http://127.0.0.1:${process.env.PROFILE_PORT??(baseline?4181:4180)}`));
