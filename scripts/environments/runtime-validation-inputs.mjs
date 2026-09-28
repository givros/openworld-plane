import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

/** Fail closed when a final measurement would accidentally use an older export. */
export async function finalWorldInputs(manifest,{requireQuiet=false}={}){
 if(process.env.FINAL_WORLD_READY!=='1')throw new Error('Final validation waits for FINAL_WORLD_READY=1 after all four exports.');
 if(requireQuiet&&process.env.GPU_QUIET!=='1')throw new Error('Final performance waits for GPU_QUIET=1 after Blender rendering finishes.');
 const expected=JSON.parse(execFileSync('python',['-c',
  "import sys,json,hashlib; sys.path.insert(0,'scripts/environments'); from regional_network_plan import PLAN; print(json.dumps({k:hashlib.sha256(json.dumps(v,sort_keys=True).encode()).hexdigest() for k,v in PLAN.items()}))"
 ],{encoding:'utf8'}));
 const inputs=[];
 for(const biome of manifest.biomes){
  const directory=path.resolve('artifacts/four-horizons',biome.id);
  const humanBytes=await readFile(path.join(directory,'human_landuse_validation.json'));
  const registryBytes=await readFile(path.join(directory,'asset_registry.json'));
  const human=JSON.parse(humanBytes),registry=JSON.parse(registryBytes);
  if(human.sourceApplied!==true||human.exportIntegrated!==true||human.planSha256!==expected[biome.id])
   throw new Error(`${biome.id}: current human source/export is not committed.`);
  if(biome.source.triangles!==registry.source.triangles||human.source.triangles!==registry.source.triangles)
   throw new Error(`${biome.id}: manifest/source counts disagree; refresh the manifest before validation.`);
  const glb=path.resolve('public',biome.url.replace(/^\//,'')),file=await stat(glb);
  inputs.push({id:biome.id,source:registry.source,planSha256:human.planSha256,
   registrySha256:createHash('sha256').update(registryBytes).digest('hex'),
   humanReportSha256:createHash('sha256').update(humanBytes).digest('hex'),
   asset:glb,assetBytes:file.size,assetModifiedAt:file.mtime.toISOString()});
 }
 return{capturedAt:new Date().toISOString(),allCurrentSourcesAndExports:true,gpuQuietDeclared:process.env.GPU_QUIET==='1',inputs};
}
