import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('artifacts/performance-20260926');
const read=async tag=>JSON.parse(await readFile(path.join(root,tag,'report.json'),'utf8'));
const baseline=await read('baseline-all-biomes');
const parity=[],paired=[];
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
for(const tag of ['optimized','final','paired-validation','cascade-selection-experiment','cascade-selection-gradient-experiment']){
  const report=await read(tag);
  for(const row of report.rows){
    const original=baseline.rows.find(r=>r.biome===row.biome&&r.distance===row.distance);
    if(!original)continue;
    const name=`${row.biome}-${row.distance}.rgba`;
    const [before,after]=await Promise.all([readFile(path.join(root,'baseline-all-biomes',name)),readFile(path.join(root,tag,name))]);
    if(before.length!==after.length)throw Error('Image dimensions differ');
    let changedPixels=0,maxChannelDelta=0,totalDelta=0;
    for(let i=0;i<before.length;i+=4){let changed=false;for(let c=0;c<4;c++){
      const delta=Math.abs(before[i+c]-after[i+c]);changed ||=delta>0;maxChannelDelta=Math.max(maxChannelDelta,delta);totalDelta+=delta;
    }changedPixels+=Number(changed);}
    parity.push({experiment:tag,validBrowserRun:report.errors.length===0,biome:row.biome,changedPixels,maxChannelDelta,meanAbsoluteChannelDelta:totalDelta/before.length,pixels:before.length/4,
      identicalCamera:JSON.stringify(original.pixelCamera)===JSON.stringify(row.pixelCamera),
      identicalPassCounts:JSON.stringify(original.diagnostics.renderer.passes)===JSON.stringify(row.diagnostics.renderer.passes)});
    if(row.paired)paired.push({biome:row.biome,cycles:row.paired.map(p=>({enabled:p.enabled,fps:p.cadence.fps,medianFrameMs:p.cadence.frameMs.median,
      p95FrameMs:p.cadence.frameMs.p95,shadowGpuMs:median(p.gpu.timings.map(t=>t.shadowGpuMs)),beautyGpuMs:median(p.gpu.timings.map(t=>t.beautyGpuMs)),passes:p.gpu.passes}))});
  }
}
await writeFile(path.join(root,'pixel-parity.json'),JSON.stringify(parity,null,2)+'\n');
await writeFile(path.join(root,'paired-summary.json'),JSON.stringify(paired,null,2)+'\n');
console.log(JSON.stringify({parity,paired},null,2));
