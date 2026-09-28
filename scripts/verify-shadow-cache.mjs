// Isolated desktop verification; never attaches to an interactive user browser.
import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const output=path.resolve(process.env.CACHE_QA_DIR??'artifacts/render-architecture-20260926/cache-visual');
const biomes=(process.env.CACHE_QA_BIOMES??'verdant-airfield,azure-port,alpine-lake,sunstone-oasis').split(',').filter(Boolean);
const movementSteps=[
  {name:'initial',offset:[0,0,0],yaw:0},
  {name:'small-translation',offset:[2,0,3],yaw:0},
  {name:'diagonal-scroll',offset:[13,0,18],yaw:0},
  {name:'turn',offset:[13,0,18],yaw:.32},
  {name:'sector-arrival',offset:[180,0,130],yaw:.32},
  {name:'return',offset:[0,0,0],yaw:0},
];
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--use-gl=angle','--use-angle=d3d11','--ignore-gpu-blocklist','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const report={complete:false,biomes,tolerance:{channelDelta:16,maxChangedPixelFraction:.001},errors:[],warmups:[],checks:[]};
page.on('pageerror',error=>report.errors.push(String(error)));
page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
await page.route('**/assets/index-*.js',async route=>{
  const response=await route.fetch(),source=await response.text();
  if(!source.includes('this.expose();'))throw Error('Use the isolated unminified performance build');
  await route.fulfill({response,body:source.replace('this.expose();','window.__benchmarkGame=this;this.expose();')});
});

async function settle(){
  await page.evaluate(async()=>{
    const g=window.__benchmarkGame;
    // Presentation prepares camera, aircraft, world and CSM matrices before render(true).
    g.syncPresentation(0,true);await g.world.whenReady();
    g.syncPresentation(0,true);await g.world.whenReady();
  });
  await page.waitForFunction(()=>window.__benchmarkGame.world.streamingStats.loadingChunks===0,null,{timeout:180000});
}

async function warmup(biome){
  const result=await page.evaluate(()=>{
    const g=window.__benchmarkGame,history=[];
    if(!g.rendering.shadowCache)throw Error('Static shadow cache is inactive');
    g.syncPresentation(0,true);
    // Initial native maps may be absent. Require actual reuse of BOTH cascades,
    // rather than allowing fallback/native images to pass the visual comparison.
    for(let attempt=0;attempt<8;attempt++){
      g.rendering.render(true);
      const diagnostics=structuredClone(g.rendering.shadowCacheDiagnostics);history.push(diagnostics);
      if([2,3].every(index=>{
        const cascade=diagnostics?.cascades[index];
        return cascade?.cached===true&&cascade.fallback===false&&cascade.reusedTexels>0;
      }))return{ready:true,attempts:attempt+1,history};
    }
    return{ready:false,attempts:history.length,history};
  });
  report.warmups.push({biome,...result});
  if(!result.ready)throw Error(`Both shadow cascades did not enter the cache at ${biome}: ${JSON.stringify(result.history.at(-1))}`);
}

async function check(biome,step,{requireReuse=false,expectFixedCamera=false}={}){
  await settle();
  const result=await page.evaluate(({requireReuse,expectFixedCamera})=>{
    const g=window.__benchmarkGame,renderer=g.rendering.renderer,gl=renderer.getContext(),cache=g.rendering.shadowCache;
    if(!cache)throw Error('Static shadow cache is inactive');
    const assertCached=(diagnostics,label)=>{
      for(const index of [2,3]){
        const cascade=diagnostics?.cascades[index];
        if(cascade?.cached!==true||cascade.fallback!==false)throw Error(`${label}: cascade ${index} used no cache: ${JSON.stringify(diagnostics)}`);
        if(label==='cached'&&requireReuse&&!(cascade.reusedTexels>0))throw Error(`${label}: cascade ${index} did not reuse cached texels`);
      }
    };
    const read=()=>{
      const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      return pixels;
    };
    g.syncPresentation(0,true);
    const cameraMatrix=g.rendering.camera.matrixWorld.toArray(),projection=g.rendering.camera.projectionMatrix.toArray();
    if(expectFixedCamera&&(!cameraMatrix.every((value,index)=>value===window.__cacheGhostCamera[index])||!projection.every((value,index)=>value===window.__cacheGhostProjection[index])))throw Error('Aircraft ghost test changed the camera');
    g.rendering.render(true);
    const diagnostics=structuredClone(g.rendering.shadowCacheDiagnostics);
    assertCached(diagnostics,'cached');
    const cached=read();
    // Identical pose, matrices, animation time and resources; invalidate only static cache.
    cache.invalidate();g.rendering.render(true);
    const freshDiagnostics=structuredClone(g.rendering.shadowCacheDiagnostics);
    assertCached(freshDiagnostics,'fresh');
    const fresh=read();
    let changed=0,over4=0,over16=0,max=0,total=0;
    for(let i=0;i<cached.length;i+=4){
      let delta=0;
      for(let c=0;c<3;c++){const d=Math.abs(cached[i+c]-fresh[i+c]);delta=Math.max(delta,d);total+=d;}
      changed+=delta>0;over4+=delta>4;over16+=delta>16;max=Math.max(max,delta);
    }
    const pixels=cached.length/4,failed=over16>pixels*.001,images={};
    if(failed){
      const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d'),image=context.createImageData(width,height);
      for(const [name,source] of [['cached',cached],['fresh',fresh],['difference',null]]){
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const input=(y*width+x)*4,output=((height-1-y)*width+x)*4;
          for(let c=0;c<3;c++)image.data[output+c]=source?source[input+c]:Math.min(255,Math.abs(cached[input+c]-fresh[input+c])*8);
          image.data[output+3]=255;
        }
        context.putImageData(image,0,0);images[name]=canvas.toDataURL('image/png').split(',')[1];
      }
    }
    return{pixels,width:gl.drawingBufferWidth,height:gl.drawingBufferHeight,changed,over4,over16,max,meanAbsoluteChannelError:total/(cached.length*.75),diagnostics,freshDiagnostics,cameraMatrix,projection,aircraftPosition:g.aircraft.root.position.toArray(),failed,images};
  },{requireReuse,expectFixedCamera});
  const {images,...metrics}=result;
  for(const [name,data] of Object.entries(images))await writeFile(path.join(output,`${biome}-${step.name}-${name}.png`),Buffer.from(data,'base64'));
  report.checks.push({biome,step,...metrics});console.log(JSON.stringify({biome,step:step.name,...metrics}));
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  if(result.failed)throw Error(`Cache visibility mismatch at ${biome}/${step.name}`);
}

try{
  await page.goto(`${process.env.GAME_URL??'http://127.0.0.1:4180'}/?review=1&preload=1&fragmentShadows=1&cacheShadows=1&pruneTraversal=1&immutableWorld=1`,{timeout:120000});
  await page.waitForFunction(()=>window.__benchmarkGame?.world.isViewReady,null,{timeout:300000});
  await page.evaluate(()=>{
    const g=window.__benchmarkGame,api=window.__AIRPLANE_EXPERIENCE__;
    g.loop.stop();api.setReviewMode(true);api.setRenderDistance(600);
    const fog=g.rendering.scene.fog;
    if(fog){
      Object.defineProperty(fog,'near',{configurable:true,get:()=>1e6,set:()=>{}});
      Object.defineProperty(fog,'far',{configurable:true,get:()=>2e6,set:()=>{}});
    }
  });
  for(const biome of biomes){
    await page.evaluate(biome=>{
      const g=window.__benchmarkGame;
      window.__AIRPLANE_EXPERIENCE__.visitBiome(biome);g.reviewPose=true;
      window.__cacheCamera=g.rendering.camera.position.clone();
      window.__cacheForward=g.rendering.camera.getWorldDirection(g.rendering.camera.position.clone());
    },biome);
    await settle();await warmup(biome);
    for(const step of movementSteps){
      await page.evaluate(step=>{
        const g=window.__benchmarkGame,p=window.__cacheCamera.clone().add({x:step.offset[0],y:step.offset[1],z:step.offset[2]}),d=window.__cacheForward.clone();
        const x=d.x,z=d.z;d.x=x*Math.cos(step.yaw)+z*Math.sin(step.yaw);d.z=z*Math.cos(step.yaw)-x*Math.sin(step.yaw);
        // reviewCamera() renders before returning, hiding the first scrolled frame.
        g.rendering.camera.position.copy(p);g.rendering.camera.lookAt(p.clone().addScaledVector(d,100));
        g.rendering.camera.fov=48;g.rendering.camera.updateProjectionMatrix();
      },step);
      await check(biome,step);
    }
    if(biome==='azure-port'){
      for(const width of [1600,1440]){
        await page.setViewportSize({width,height:900});
        await page.evaluate(()=>window.__benchmarkGame.rendering.resize());
        await check(biome,{name:`resize-${width}`,viewport:[width,900]});
      }
      await page.evaluate(()=>{
        const g=window.__benchmarkGame;
        window.__cacheGhostPosition=g.manual.state.position.clone();window.__cacheGhostYaw=g.manual.state.yaw;
        window.__cacheGhostCamera=g.rendering.camera.matrixWorld.toArray();
        window.__cacheGhostProjection=g.rendering.camera.projectionMatrix.toArray();
      });
      // Fix the camera while moving the aircraft. Reuse is mandatory: a full
      // static redraw would conceal an incorrectly baked dynamic shadow ghost.
      for(const moved of [true,false]){
        await page.evaluate(moved=>{
          const g=window.__benchmarkGame,s=g.manual.state;s.position.copy(window.__cacheGhostPosition);s.yaw=window.__cacheGhostYaw;
          if(moved){s.position.x+=14;s.position.z-=8;s.yaw+=.35;}
        },moved);
        await check(biome,{name:moved?'aircraft-moved-fixed-camera':'aircraft-return-fixed-camera'},{requireReuse:true,expectFixedCamera:true});
      }
    }
  }
  if(report.errors.length)throw Error(report.errors[0]);
  report.complete=true;
}catch(error){
  report.failure=String(error);throw error;
}finally{
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();
}
