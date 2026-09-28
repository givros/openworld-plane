import { defineConfig } from 'vite';
import { copyFile,mkdir,readFile,readdir,stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot=fileURLToPath(new URL('.',import.meta.url));

interface RuntimeAssetEntry {path:string;bytes:number;sha256:string;gzipBytes:number;gzipSha256:string;packedPath:string}
const safePath=(value:unknown,prefix:string):value is string=>typeof value==='string'&&value.startsWith(prefix)&&
  /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
const byteCount=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hashFile=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
async function directoryBytes(directory:string):Promise<number>{
  let bytes=0;
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Error(`Build output cannot contain symbolic links: ${entry.name}`);
    bytes+=entry.isDirectory()?await directoryBytes(file):(await stat(file)).size;
  }
  return bytes;
}

/** Only assets reachable from the published world are build inputs. Derived
 * research buffers and editable Blender sources stay outside the runtime. */
export async function copyRuntimeAssets(root:string,destination:string,pages:boolean):Promise<void>{
  const packRoot=path.join(root,'repository-assets','runtime');
  const manifest=JSON.parse(await readFile(path.join(packRoot,'manifest.json'),'utf8')) as {entries?:RuntimeAssetEntry[]};
  if(!Array.isArray(manifest.entries)||manifest.entries.length===0)throw new Error('Runtime asset manifest has no entries');
  const seen=new Set<string>();let payloadBytes=0;
  for(const entry of manifest.entries){
    if(!entry||!safePath(entry.path,'environments/')||!safePath(entry.packedPath,'files/')||!entry.packedPath.endsWith('.gz')||
      !byteCount(entry.bytes)||!byteCount(entry.gzipBytes)||!digest(entry.sha256)||!digest(entry.gzipSha256)||seen.has(entry.path))
      throw new Error('Invalid or duplicate runtime asset manifest entry');
    seen.add(entry.path);payloadBytes+=pages?entry.gzipBytes:entry.bytes;
  }
  if(pages&&payloadBytes>1_000_000_000)throw new Error('Compressed runtime assets exceed the GitHub Pages 1 GB site limit');
  for(const entry of manifest.entries){
    const source=pages?path.join(packRoot,entry.packedPath):path.join(root,'public',entry.path);
    const target=path.join(destination,entry.path+(pages?'.gz':''));
    await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);
    const expectedBytes=pages?entry.gzipBytes:entry.bytes,expectedHash=pages?entry.gzipSha256:entry.sha256;
    if((await stat(target)).size!==expectedBytes||await hashFile(target)!==expectedHash)
      throw new Error(`Runtime asset checksum mismatch: ${entry.path}`);
  }
  if(pages&&await directoryBytes(destination)>1_000_000_000)throw new Error('Build output exceeds the GitHub Pages 1 GB site limit');
}

let outputDirectory=path.join(projectRoot,'dist');
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  plugins:[{name:'runtime-public-assets',apply:'build',configResolved(config){
    outputDirectory=path.resolve(config.root,config.build.outDir);
  },async writeBundle(){await copyRuntimeAssets(projectRoot,outputDirectory,process.env.PAGES_BUILD==='1');}}],
  build: { copyPublicDir:false,rollupOptions: { output: { manualChunks: (id: string) => id.includes('/node_modules/three/') ? 'three' : undefined } }, chunkSizeWarningLimit: 650 },
});
