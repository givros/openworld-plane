/** Serialized into an isolated browser after the static GPU/CPU diagnostics. */
export async function profileMovingShadowRoute({replay=null,maxDurationMs=120000}={}){
 const game=window.__auditGame;game.loop.stop();
 const renderer=game.rendering.renderer,scene=game.rendering.scene,camera=game.rendering.camera;
 const gl=renderer.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
 const shadow=renderer.shadowMap,originalShadowRender=shadow.render,originalRender=game.rendering.render;
 const previousAutoReset=renderer.info.autoReset,started=performance.now(),regions=[],rows=[];
 let timeBoundReached=false;
 const snapshot=(root,includeGeometry=false)=>{const nodes=[];const visit=(object,path)=>{const node={path,position:object.position.toArray(),quaternion:object.quaternion.toArray(),scale:object.scale.toArray(),visible:object.visible};if(includeGeometry&&object.geometry){node.attributes=Object.fromEntries(Object.entries(object.geometry.attributes).map(([key,value])=>[key,Array.from(value.array)]));node.drawRange={...object.geometry.drawRange};node.opacity=object.material.opacity;}nodes.push(node);object.children.forEach((child,index)=>visit(child,[...path,index]));};visit(root,[]);return nodes;};
 const restore=(root,nodes)=>{for(const node of nodes){const object=node.path.reduce((parent,index)=>parent.children[index],root);object.position.fromArray(node.position);object.quaternion.fromArray(node.quaternion);object.scale.fromArray(node.scale);object.visible=node.visible;if(node.attributes){for(const [key,value]of Object.entries(node.attributes)){object.geometry.attributes[key].array.set(value);object.geometry.attributes[key].needsUpdate=true;}object.geometry.setDrawRange(node.drawRange.start,node.drawRange.count??Infinity);object.material.opacity=node.opacity;}}};
 try{
  renderer.info.autoReset=false;
  game.atmosphere.casterVolumes.forEach(volume=>volume.enabled=true);
  regionLoop:for(const biome of ['verdant-airfield','azure-port','alpine-lake','sunstone-oasis']){
   if(performance.now()-started>=maxDurationMs){timeBoundReached=true;break;}
   game.rendering.render=()=>{};
   window.__AIRPLANE_EXPERIENCE__.reviewBiome(biome,120);
   game.rendering.render=originalRender;
   // Freeze the existing presentation; retain all source geometry and shadows.
   game.atmosphere.drift=0;game.atmosphere.update(0,game.manual.state.position,120,false);
   const prior=replay?.regions.find(region=>region.biome===biome);
   if(prior){
    restore(game.aircraft.root,prior.presentation.aircraft);
    restore(game.vfx.root,prior.presentation.vfx);
    game.atmosphere.clouds.instanceMatrix.array.set(prior.presentation.cloudMatrices);
    game.atmosphere.clouds.instanceMatrix.needsUpdate=true;
   }
   const presentation={aircraft:snapshot(game.aircraft.root),vfx:snapshot(game.vfx.root,true),cloudMatrices:Array.from(game.atmosphere.clouds.instanceMatrix.array),cloudDrift:0};
   const basePosition=camera.position.clone(),baseQuaternion=camera.quaternion.clone(),up=camera.position.clone().set(0,1,0);
   const route=prior?.route??Array.from({length:12},(_,step)=>{
    const t=step/11,position=basePosition.clone().add(basePosition.clone().set(24*t,4*Math.sin(Math.PI*t),-40*t));
    const yaw=.11*Math.sin(Math.PI*t),quaternion=baseQuaternion.clone().premultiply(baseQuaternion.clone().setFromAxisAngle(up,yaw));
    return{step,position:position.toArray(),quaternion:quaternion.toArray(),fov:camera.fov,near:camera.near,far:camera.far};
   });
   regions.push({biome,presentation,route});
   for(const pose of route){
    if(performance.now()-started>=maxDurationMs){timeBoundReached=true;break regionLoop;}
    camera.position.fromArray(pose.position);camera.quaternion.fromArray(pose.quaternion);
    camera.fov=pose.fov;camera.near=pose.near;camera.far=pose.far;camera.updateProjectionMatrix();
    const preparationStarted=performance.now();game.atmosphere.prepareRender();
    const atmospherePreparationMs=performance.now()-preparationStarted;
    const cullingPreparationStarted=performance.now();game.rendering.prepareWorldCulling();
    const cullingPreparationMs=performance.now()-cullingPreparationStarted;
    const preparationMs=performance.now()-preparationStarted;
    renderer.info.reset();const shadowQuery=ext?gl.createQuery():null,beautyQuery=ext?gl.createQuery():null;let shadowStats;
    shadow.render=function(...args){
     if(shadowQuery)gl.beginQuery(ext.TIME_ELAPSED_EXT,shadowQuery);
     originalShadowRender.apply(this,args);
     if(shadowQuery)gl.endQuery(ext.TIME_ELAPSED_EXT);
     shadowStats={...renderer.info.render};
     if(beautyQuery)gl.beginQuery(ext.TIME_ELAPSED_EXT,beautyQuery);
    };
    const submissionStarted=performance.now();renderer.render(scene,camera);
    if(beautyQuery)gl.endQuery(ext.TIME_ELAPSED_EXT);
    const submissionMs=performance.now()-submissionStarted;gl.finish();
    const synchronizedDrawMs=performance.now()-submissionStarted;
    const queryStarted=performance.now();
    if(ext)while(!gl.getQueryParameter(beautyQuery,gl.QUERY_RESULT_AVAILABLE)&&performance.now()-queryStarted<1000)await new Promise(resolve=>setTimeout(resolve,2));
    const gpuValid=!!ext&&gl.getQueryParameter(beautyQuery,gl.QUERY_RESULT_AVAILABLE)&&!gl.getParameter(ext.GPU_DISJOINT_EXT);
    rows.push({biome,step:pose.step,pose,preparationMs,atmospherePreparationMs,cullingPreparationMs,submissionMs,synchronizedDrawMs,gpuValid,shadowGpuMs:gpuValid?gl.getQueryParameter(shadowQuery,gl.QUERY_RESULT)/1e6:null,beautyGpuMs:gpuValid?gl.getQueryParameter(beautyQuery,gl.QUERY_RESULT)/1e6:null,instanceCulling:game.rendering.instanceCulling?.diagnostics??null,passes:{shadow:shadowStats,total:{...renderer.info.render},beauty:{calls:renderer.info.render.calls-shadowStats.calls,triangles:renderer.info.render.triangles-shadowStats.triangles}}});
    if(shadowQuery)gl.deleteQuery(shadowQuery);if(beautyQuery)gl.deleteQuery(beautyQuery);
    shadow.render=originalShadowRender;
   }
   console.log('PASS moving-camera '+biome+' '+rows.filter(row=>row.biome===biome).length);
  }
 }finally{shadow.render=originalShadowRender;game.rendering.render=originalRender;renderer.info.autoReset=previousAutoReset;}
 const summary={};
 for(const biome of ['verdant-airfield','azure-port','alpine-lake','sunstone-oasis']){
  const subset=rows.filter(row=>row.biome===biome);summary[biome]={draws:subset.length};
  for(const key of ['preparationMs','atmospherePreparationMs','cullingPreparationMs','submissionMs','synchronizedDrawMs','shadowGpuMs','beautyGpuMs']){
   const values=subset.map(row=>row[key]).filter(value=>value!==null).sort((a,b)=>a-b);
   summary[biome][key]={samples:values.length,median:values[Math.floor(values.length*.5)]??null,p95:values[Math.floor(values.length*.95)]??null};
  }
 }
 return{status:rows.length===48&&!timeBoundReached?'passed':'incomplete',instrumentation:'Deterministic twelve-pose camera route per biome, after all static diagnostics. Frozen presentation and full source geometry; camera-dependent CSM and current per-pass instance selections are prepared before every direct draw. Atmosphere/culling CPU preparation is outside GPU queries. Synchronized draw duration includes gl.finish and is not FPS.',replayed:!!replay,regions,rows,summary,bounds:{maxDurationMs,elapsedMs:performance.now()-started,timeBoundReached,expectedDraws:48,actualDraws:rows.length},world:game.world.diagnostics,glError:gl.getError()};
}
