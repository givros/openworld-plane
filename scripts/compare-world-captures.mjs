import {readFile,writeFile} from 'node:fs/promises';
import {PNG} from 'pngjs';
import assert from 'node:assert/strict';
import path from 'node:path';

const directory=path.resolve('artifacts/four-horizons/comparisons/roof-shadows');
const beforeTag=process.env.BEFORE_TAG??'merge-before',afterTag=process.env.AFTER_TAG??'merge-after';
const before=JSON.parse(await readFile(path.join(directory,`${beforeTag}.json`),'utf8'));
const after=JSON.parse(await readFile(path.join(directory,`${afterTag}.json`),'utf8'));
assert.equal(before.staticWorldComparison,true);assert.equal(after.staticWorldComparison,true);
assert.deepEqual(after.dynamicExclusions,before.dynamicExclusions);
assert.deepEqual(before.errors,[]);assert.deepEqual(after.errors,[]);
assert.equal(before.frames.length,4);assert.equal(after.frames.length,4);
const rows=[];
for(const a of before.frames){
 const b=after.frames.find(row=>row.biome===a.biome&&row.view===a.view&&row.mode===a.mode);
 assert.ok(b,`Missing matching ${a.biome}/${a.view}`);
 for(const key of ['camera','target','fov','depth','sourceTriangles'])assert.deepEqual(b[key],a[key],`${a.biome}: ${key} changed`);
 assert.equal(a.glError,0);assert.equal(b.glError,0);
 const left=PNG.sync.read(await readFile(path.join(directory,a.file)));
 const right=PNG.sync.read(await readFile(path.join(directory,b.file)));
 assert.equal(left.width,right.width);assert.equal(left.height,right.height);
 let changedPixels=0,maxRGBDelta=0,totalRGBDelta=0,minLuminance=255,maxLuminance=0;
 const difference=new PNG({width:left.width,height:left.height});
 for(let i=0;i<left.data.length;i+=4){
  let delta=0;for(let k=0;k<3;k++)delta+=Math.abs(left.data[i+k]-right.data[i+k]);
  if(delta)changedPixels++;maxRGBDelta=Math.max(maxRGBDelta,delta);totalRGBDelta+=delta;
  const luminance=(left.data[i]+left.data[i+1]+left.data[i+2])/3;minLuminance=Math.min(minLuminance,luminance);maxLuminance=Math.max(maxLuminance,luminance);
  difference.data[i]=delta?255:0;difference.data[i+1]=delta?Math.min(255,delta):0;difference.data[i+2]=0;difference.data[i+3]=255;
 }
 const diffFile=`${afterTag}-${a.biome}-difference.png`;
 if(changedPixels)await writeFile(path.join(directory,diffFile),PNG.sync.write(difference));
 rows.push({biome:a.biome,view:a.view,before:a.file,after:b.file,changedPixels,maxRGBDelta,totalRGBDelta,nonemptyBaseline:maxLuminance-minLuminance>30,difference:changedPixels?diffFile:null,sourceTriangles:a.sourceTriangles,depth:a.depth});
}
const report={timestamp:new Date().toISOString(),beforeTag,afterTag,scope:'Exact native-resolution authored-world RGB comparison. Only independently animated aircraft, flight VFX and clouds are hidden identically in both diagnostic captures; all authored geometry and shadows remain enabled.',rows,passed:rows.every(row=>row.changedPixels===0&&row.nonemptyBaseline)};
await writeFile(path.join(directory,`${afterTag}-comparison.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
if(!report.passed)process.exitCode=1;
