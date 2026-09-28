import {readFile,writeFile} from 'node:fs/promises';
const root='artifacts/ram-preload-20260926';
const [before,after]=await Promise.all(['streamed','preloaded'].map(async tag=>JSON.parse(await readFile(`${root}/${tag}/report.json`,'utf8'))));
for(const report of [before,after])if(!report.complete||report.errors.length)throw Error('Invalid preload comparison run');
const a=before.rows[0],b=after.rows[0];
if(JSON.stringify(a.pixelCamera)!==JSON.stringify(b.pixelCamera))throw Error('Camera changed between preload runs');
const [ap,bp]=await Promise.all(['streamed','preloaded'].map(tag=>readFile(`${root}/${tag}/azure-port-300.rgba`)));
if(ap.length!==bp.length)throw Error('Pixel buffer size changed');
let changedPixels=0,maxChannelDifference=0;
for(let pixel=0;pixel<ap.length;pixel+=4){let changed=false;for(let c=0;c<4;c++){const d=Math.abs(ap[pixel+c]-bp[pixel+c]);if(d)changed=true;maxChannelDifference=Math.max(maxChannelDifference,d);}if(changed)changedPixels++;}
const summarize=(report,row)=>({startupMs:report.startupMs,stationaryFps:row.stationary.fps,flightFps:row.motion.fps,p95:row.motion.frameMs.p95,max:row.motion.frameMs.max,skippedFrames:row.motion.skippedFrames,assetRequests:row.motion.assetRequests,heap:row.motion.heap,residentChunks:row.motion.streaming.residentChunks,totalChunks:row.motion.streaming.totalChunks,evictions:row.motion.streaming.evictions,passes:row.diagnostics.renderer.passes});
const result={before:summarize(before,a),after:summarize(after,b),preload:after.startupPreload,pixels:{totalPixels:ap.length/4,changedPixels,maxChannelDifference},sameCamera:true,sameDrawCounts:JSON.stringify(a.diagnostics.renderer.passes)===JSON.stringify(b.diagnostics.renderer.passes)};
await writeFile(`${root}/comparison.json`,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
