import * as THREE from 'three';
import GUI from 'lil-gui';
import { Renderer } from '../core/Renderer';
import { Loop } from '../core/Loop';
import { RenderDistanceController } from '../core/RenderDistanceController';
import { FULL_WORLD_VIEW_DISTANCE,MAX_REVIEW_VIEW_DISTANCE,worldViewPolicy } from '../core/WorldViewPolicy';
import { AirplaneModel } from '../assets/AirplaneModel';
import { FourBiomeWorld } from '../world/FourBiomeWorld';
import { ManualFlightController } from '../systems/ManualFlightController';
import { PilotInput } from '../systems/PilotInput';
import { FlightSequence } from '../systems/FlightSequence';
import { InspectionCamera } from '../systems/InspectionCamera';
import { PilotCamera } from '../systems/PilotCamera';
import { CinematicCamera } from '../systems/CinematicCamera';
import { FlightHud } from '../systems/FlightHud';
import { Atmosphere } from '../systems/Atmosphere';
import { landscapeVisibility } from '../systems/LandscapeVisibility';
import { FlightVfx } from '../systems/FlightVfx';
import { AudioSystem } from '../systems/AudioSystem';
import { QualityDiagnostics } from '../systems/QualityDiagnostics';
import { installFragmentShadowCoordinates } from '../systems/FragmentShadowCoordinates';
import { clamp, type Controls, type FlightState, type GameMode } from './types';

export class Game {
  private static readonly DEFAULT_VIEW_DISTANCE=FULL_WORLD_VIEW_DISTANCE;
  readonly rendering:Renderer;
  readonly aircraft:AirplaneModel;
  readonly manual:ManualFlightController;
  readonly autopilot:FlightSequence;
  readonly input:PilotInput;
  readonly hud:FlightHud;
  readonly audio=new AudioSystem();
  readonly quality=new QualityDiagnostics();
  readonly loop:Loop;
  private readonly inspection:InspectionCamera;
  private readonly chase:PilotCamera;
  private readonly cinematic:CinematicCamera;
  private readonly atmosphere:Atmosphere;
  private readonly vfx:FlightVfx;
  private readonly pose=new THREE.Euler(0,0,0,'YXZ');
  private readonly automatedControls:Controls={throttle:0,pitch:0,roll:0,rudder:0,brake:false};
  private mode:GameMode='inspection';
  private timeScale=1;
  private review=false;
  private reviewPose=false;
  private disposed=false;
  private startupReady=false;
  private readonly startupPreparation={requestedPercent:0,durationMs:0,complete:false};
  private gui:GUI|null=null;
  private previousPhase='';
  private viewDistance=Game.DEFAULT_VIEW_DISTANCE;
  private readonly distanceController=new RenderDistanceController({initialDistance:Game.DEFAULT_VIEW_DISTANCE,maximumDistance:Game.DEFAULT_VIEW_DISTANCE});
  private previousFrameDrew=false;
  private renderedFrames=0;
  private readonly previousViewPosition=new THREE.Vector3();
  private readonly streamingVelocity=new THREE.Vector3();
  private readonly streamingForward=new THREE.Vector3();
  private readonly streamingProjection=new THREE.Matrix4();
  private readonly streamingFrustum=new THREE.Frustum();
  private hasPreviousView=false;
  private streamingWaitStarted=0;
  private streamingStatus:HTMLDivElement|null=null;
  private pendingStreamingReady:Promise<void>|null=null;
  private readonly reviewAllowed:boolean;
  private readonly sampleGround=(x:number,z:number):number=>this.world.sampleGroundHeight(x,z);

  static async create(app:HTMLElement,signal?:AbortSignal):Promise<Game>{
    const label=app.querySelector('#loading p');
    const world=await FourBiomeWorld.load(message=>{if(label)label.textContent=message;},signal);
    let game:Game|undefined;
    const cancel=():void=>game?.dispose();
    try{
      signal?.throwIfAborted();game=new Game(app,world);
      signal?.addEventListener('abort',cancel,{once:true});
      await game.prepareStartup(message=>{if(label)label.textContent=message;},signal);
      signal?.throwIfAborted();
      game.finishStartup();return game;
    }catch(error){if(game)game.dispose();else world.dispose();throw error;}
    finally{signal?.removeEventListener('abort',cancel);}
  }

  private constructor(private readonly app:HTMLElement,readonly world:FourBiomeWorld){
    // Preserve the chosen landscape coverage. Performance optimizations must
    // not silently replace the world with a shorter view and denser fog.
    const policy=worldViewPolicy(location.search);
    this.viewDistance=policy.viewDistance;
    this.distanceController.setOverride(this.viewDistance);
    this.reviewAllowed=policy.review;
    this.rendering=new Renderer(app);
    this.aircraft=new AirplaneModel();
    this.rendering.scene.add(this.world.root,this.aircraft.root);
    this.manual=new ManualFlightController(this.sampleGround);this.autopilot=new FlightSequence(this.sampleGround);
    this.manual.state.phase='inspection';
    this.input=new PilotInput(this.rendering.renderer.domElement);this.input.enabled=false;
    this.inspection=new InspectionCamera(this.rendering.camera,this.rendering.renderer.domElement);
    this.chase=new PilotCamera(this.rendering.camera);this.cinematic=new CinematicCamera(this.rendering.camera);
    this.atmosphere=new Atmosphere(this.rendering.scene,this.rendering.renderer,this.rendering.camera);this.vfx=new FlightVfx(this.sampleGround);this.rendering.scene.add(this.vfx.root);
    if(new URLSearchParams(location.search).get('fragmentShadows')!=='0')installFragmentShadowCoordinates();
    this.rendering.enableWorldCulling(this.world.root,this.atmosphere.instanceShadowPasses,this.atmosphere.canCullInstanceMaterial);
    this.atmosphere.setStaticWorld(this.world.root,()=>this.world.renderRevision);
    this.rendering.configureStaticShadowCache(this.atmosphere.canCacheShadowPass,this.atmosphere.cacheableShadowPassIndices);
    this.world.onResidencyChange=({added,removed,materials})=>{
      this.atmosphere.registerMaterials(materials);
      if(removed.length)this.rendering.instanceCulling?.removeSources(removed);
      if(added.length)this.rendering.instanceCulling?.addSources(added);
      this.rendering.updateStaticShadowCoverage(added,removed);
    };
    this.world.prepareChunkForRender=(group,signal)=>this.rendering.prepareChunkPrograms(group,signal);
    this.hud=new FlightHud(app,{manual:()=>this.startManual(),autopilot:()=>this.startAutopilot(),biome:id=>this.visitBiome(id),reset:()=>this.reset(),sound:()=>this.audio.toggle(),fullscreen:()=>{void this.fullscreen();},paint:hex=>this.setPaintColor(hex),camera:index=>this.setCamera(index)},this.aircraft.materials.paintColor);
    this.loop=new Loop(this.frame);
    window.addEventListener('keydown',this.keydown);document.addEventListener('fullscreenchange',this.fullscreenChanged);
    this.rendering.renderer.domElement.addEventListener('pointerdown',this.unlockAudio);
    this.syncPresentation(0,true);
  }
  private finishStartup():void{
    this.startupReady=true;this.syncPresentation(0,true);this.drawPreparedFrame();
    this.expose();this.app.querySelector('#loading')?.remove();
    if(new URLSearchParams(location.search).has('debug'))this.debugGui();
    this.loop.start();
  }
  private async prepareStartup(onProgress:(message:string)=>void,signal?:AbortSignal):Promise<void>{
    const started=performance.now(),percent=worldViewPolicy(location.search).residentPercent;
    this.startupPreparation.requestedPercent=percent;
    if(percent){
      const report=():void=>{
        const stats=this.world.streamingStats;
        if('preparedTargetChunks' in stats)onProgress(`PREPARING ${percent}% OF THE MAP · ${stats.preparedResidentChunks} / ${stats.preparedTargetChunks} SECTORS`);
      };
      const preparation=this.world.prepareFraction(percent/100,this.rendering.camera.position);
      report();const timer=setInterval(report,200);
      try{await preparation;}finally{clearInterval(timer);}
      signal?.throwIfAborted();
      onProgress('PREPARING GRAPHICS');
      await this.rendering.prepareChunkPrograms(this.world.root,signal??new AbortController().signal);
      // All selected source meshes and culling proxies now exist. Upload their
      // unchanged buffers before opening the flight controls.
      this.syncPresentation(0,true);this.rendering.prepareWorldCulling();
      await this.rendering.prepareResidentBuffers(this.world.root,signal??new AbortController().signal,
        (completed,total)=>onProgress(`PREPARING GRAPHICS · ${Math.floor(completed/Math.max(1,total)*100)}%`));
    }
    await this.world.whenReady();
    this.startupPreparation.durationMs=performance.now()-started;this.startupPreparation.complete=true;
  }
  private get flight():FlightState{return this.mode==='autopilot'?this.autopilot.state:this.manual.state;}
  private get controls():Controls{return this.mode==='autopilot'?this.automatedControls:this.input.controls;}
  private readonly unlockAudio=():void=>this.audio.unlock();
  private readonly keydown=(e:KeyboardEvent):void=>{
    if(!this.startupReady)return;
    const target=e.target as HTMLElement|null;if(target&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))return;
    if(e.repeat||e.ctrlKey||e.metaKey||e.altKey)return;
    if(e.code==='Enter'){e.preventDefault();if(this.mode!=='manual')this.startManual();}
    else if(e.code==='KeyR'){e.preventDefault();this.reset();}
    else if(e.code==='KeyF'){e.preventDefault();void this.fullscreen();}
    else if(this.mode==='inspection'&&/^Digit[1-4]$/.test(e.code)){e.preventDefault();this.setCamera(Number(e.code.slice(-1))-1);}
  };
  private readonly fullscreenChanged=():void=>{this.hud.setFullscreen(document.fullscreenElement===this.app);this.rendering.resize();this.rendering.renderer.domElement.focus({preventScroll:true});};
  private async fullscreen():Promise<void>{
    if(!document.fullscreenEnabled)return;
    try{if(document.fullscreenElement)await document.exitFullscreen();else await this.app.requestFullscreen();}catch(error){this.app.dataset.fullscreenError=error instanceof Error?error.message:String(error);}
  }
  startManual():void{
    this.mode='manual';this.reviewPose=false;this.manual.start();this.input.enabled=true;this.input.reset();this.inspection.enabled=false;this.chase.reset();this.vfx.reset();this.previousPhase='';this.audio.unlock();this.audio.cue('start');this.rendering.renderer.domElement.focus({preventScroll:true});this.syncPresentation(0,true);
  }
  startAutopilot():void{
    this.mode='autopilot';this.reviewPose=false;this.autopilot.start();this.input.enabled=false;this.inspection.enabled=false;this.cinematic.reset();this.vfx.reset();this.previousPhase='';this.audio.unlock();this.audio.cue('start');this.rendering.renderer.domElement.focus({preventScroll:true});this.syncPresentation(0,true);
  }
  visitBiome(id:string):void{
    const location=this.world.findBiome(id),s=this.manual.state;
    this.startManual();
    const altitude=Math.max(80,location.biome.review.aircraft[1]-this.sampleGround(location.x,location.z));
    s.position.set(location.x,this.sampleGround(location.x,location.z)+altitude,location.z);
    s.yaw=Math.atan2(location.biome.review.target[0]-location.x,location.biome.review.target[2]-location.z);
    s.altitude=altitude;s.grounded=false;s.speed=45;s.throttle=.72;s.rpm=2002;s.phase='flight';
    this.world.update(location.x,location.z);this.chase.reset();this.syncPresentation(0,true);
  }
  reset():void{
    this.hud.root.classList.remove('focused-inspection');
    this.mode='inspection';this.reviewPose=false;this.timeScale=1;this.manual.reset();this.manual.state.phase='inspection';this.autopilot.reset();this.input.enabled=false;this.inspection.enabled=true;this.inspection.reset();this.vfx.reset();this.world.update(0,0);this.previousPhase='';this.audio.unlock();this.audio.cue('reset');this.rendering.renderer.domElement.focus({preventScroll:true});this.syncPresentation(0,true);
  }
  setPaintColor(hex:string):void{this.aircraft.materials.setPaintColor(hex);this.hud?.setPaint(this.aircraft.materials.paintColor);}
  private setCamera(index:number):void{if(this.mode!=='inspection')return;this.inspection.setPreset(index);this.hud.setCamera(index);}
  private simulate(dt:number):void{
    if(this.mode==='manual')this.manual.update(dt,this.input.controls);else if(this.mode==='autopilot')this.autopilot.update(dt);
    this.world.update(this.flight.position.x,this.flight.position.z);
  }
  private readonly frame=(dt:number,simulationDt:number,raw:number):void=>{
    if(this.disposed)return;this.quality.update(raw);
    const ready=this.world.isViewReady,before=this.renderedFrames;
    this.viewDistance=this.distanceController.update({nowMs:performance.now(),frameDurationMs:raw*1000,rendered:this.previousFrameDrew,ready,pendingLoads:ready?0:1});
    if(!this.review&&this.world.isViewReady){let remaining=simulationDt*this.timeScale;while(remaining>1e-9){const step=Math.min(remaining,.12);this.simulate(step);remaining-=step;}}
    this.syncPresentation(dt);this.drawPreparedFrame();
    this.previousFrameDrew=this.renderedFrames>before;
  };
  private drawPreparedFrame():void {
    if(!this.world.isViewReady){
      this.streamingWaitStarted||=performance.now();
      if(performance.now()-this.streamingWaitStarted>200){
        if(!this.streamingStatus){
          this.streamingStatus=document.createElement('div');this.streamingStatus.className='landscape-status';
          this.streamingStatus.setAttribute('role','status');this.streamingStatus.textContent='Preparing landscape…';this.app.append(this.streamingStatus);
        }
        this.streamingStatus.hidden=false;
      }
      if(!this.pendingStreamingReady){
        this.pendingStreamingReady=this.world.whenReady().catch((error:unknown)=>{
          if(this.disposed)return;
          if(this.streamingStatus)this.streamingStatus.textContent='The landscape could not load. Reload to try again.';
          console.error(error);
        }).finally(()=>{this.pendingStreamingReady=null;});
      }
      return;
    }
    this.streamingWaitStarted=0;
    if(this.streamingStatus){this.streamingStatus.hidden=true;this.streamingStatus.textContent='Preparing landscape…';}
    this.rendering.render(true);this.renderedFrames++;
  }
  private prepareStreamingView(dt:number,instant:boolean):void {
    const camera=this.rendering.camera;
    const altitude=Math.max(0,camera.position.y-this.sampleGround(camera.position.x,camera.position.z));
    // A high camera retains a useful patch of ground. Eight-meter steps avoid
    // rebuilding cascade projections for imperceptible altitude fluctuations.
    const far=landscapeVisibility(this.viewDistance,altitude).cameraFar;
    if(camera.far!==far){camera.far=far;camera.updateProjectionMatrix();}
    this.atmosphere.setViewDistance(far,this.viewDistance,altitude);this.rendering.instanceCulling?.setViewDistance(far);
    this.streamingVelocity.set(0,0,0);
    if(this.hasPreviousView&&!instant&&dt>0){
      this.streamingVelocity.subVectors(camera.position,this.previousViewPosition).divideScalar(dt);
      if(this.streamingVelocity.length()>250)this.streamingVelocity.set(0,0,0);
    }
    this.previousViewPosition.copy(camera.position);this.hasPreviousView=true;
    camera.updateMatrixWorld();
    this.streamingProjection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    this.streamingFrustum.setFromProjectionMatrix(this.streamingProjection,camera.coordinateSystem,camera.reversedDepth);
    camera.getWorldDirection(this.streamingForward);
    this.world.updateStreaming({position:camera.position,velocity:this.streamingVelocity,forward:this.streamingForward,altitude,viewDistance:far,baseDistance:this.viewDistance,frustum:this.streamingFrustum});
  }
  private syncPresentation(dt:number,instant=false,prepareForRender=true):void{
    const s=this.flight;this.aircraft.root.position.copy(s.position);this.pose.set(-s.pitch,s.yaw,s.bank,'YXZ');this.aircraft.root.quaternion.setFromEuler(this.pose);
    if(this.mode==='autopilot'){this.automatedControls.pitch=clamp(s.pitchRate*2,-1,1);this.automatedControls.roll=clamp(s.bank,-1,1);this.automatedControls.rudder=clamp(-s.yawRate,-1,1);}
    this.aircraft.update(dt,s,this.controls);this.aircraft.root.updateMatrixWorld(true);
    if(!this.reviewPose){if(this.mode==='inspection')this.inspection.update(dt,s.position,instant);else if(this.mode==='manual')this.chase.update(dt,s);else this.cinematic.update(dt,s);}
    this.prepareStreamingView(dt,instant);
    this.atmosphere.update(dt,s.position,s.altitude,false);this.vfx.update(dt,s,this.aircraft.root);this.audio.update(s);
    const biome=this.world.getBiomeAt(s.position.x,s.position.z);this.hud.update(instant?.2:dt,this.mode,s,biome.label);
    if(s.phase!==this.previousPhase){
      if(s.phase==='liftoff')this.audio.cue('liftoff');else if(s.phase==='touchdown')this.audio.cue('touchdown');else if(s.phase==='final-approach')this.audio.cue('approach');else if(s.phase==='complete')this.audio.cue('complete');
      this.previousPhase=s.phase;
    }
    if(prepareForRender&&this.world.isViewReady)this.atmosphere.prepareRender();
  }
  private serializeState(){const s=this.flight;return{...s,position:{x:s.position.x,y:s.position.y,z:s.position.z},mode:this.mode};}
  get diagnostics(){const camera=this.rendering.camera,renderer=this.quality.inspect(this.rendering.scene,this.rendering.renderer,this.rendering.passes);return{
    frame:this.quality.frame,mode:this.mode,state:this.serializeState(),controls:{...this.controls},camera:{position:{x:camera.position.x,y:camera.position.y,z:camera.position.z},fov:camera.fov,preset:this.inspection.preset,shot:this.cinematic.shot},
    renderer:{...renderer,dpr:renderer.canvas.dpr,instanceCulling:this.rendering.instanceCulling?.diagnostics,shadowCache:this.rendering.shadowCacheDiagnostics,
      shadowMapSizes:this.atmosphere.instanceShadowPasses().map(pass=>pass.light.shadow.mapSize.toArray()),distanceDetail:this.rendering.distanceDetail?.statistics},aircraft:{...this.aircraft.diagnostics,paintColor:this.aircraft.materials.paintColor},world:this.world.diagnostics,
    fog:{enabled:this.rendering.scene.fog!==null},performance:this.quality.performance,audio:this.audio.diagnostics,
    physics:{engine:'Fixed-step authored aerodynamics',timestep:1/120,contactGuard:this.manual.contactGuard,liftoffGuard:this.manual.liftoffGuard,propellerClearance:this.manual.propellerClearance()},review:this.review,
  };}
  private expose():void{
    const game=this;
    const api:ExperienceAPI={start:()=>this.startManual(),startManual:()=>this.startManual(),startAutopilot:()=>this.startAutopilot(),visitBiome:id=>this.visitBiome(id),reset:()=>this.reset(),setTimeScale:value=>{this.timeScale=Number.isFinite(value)?clamp(value,0,20):1;},setReviewMode:enabled=>{this.review=!!enabled;},setPaintColor:hex=>this.setPaintColor(hex),get state(){return game.serializeState();},get diagnostics(){return game.diagnostics;}};
    if(this.reviewAllowed){
      api.setTightShadowCulling=(enabled:boolean):void=>{this.atmosphere.tightShadowCulling=enabled;this.syncPresentation(0);this.drawPreparedFrame();};
      api.setRenderDistance=(distance:number|null):void=>{
        if(distance!==null&&!Number.isFinite(distance))return;
        this.viewDistance=this.distanceController.setOverride(distance===null?Game.DEFAULT_VIEW_DISTANCE:clamp(distance,100,MAX_REVIEW_VIEW_DISTANCE));this.syncPresentation(0,true);
      };
      api.getStreamingStats=()=>({frame:this.quality.frame,renderedFrames:this.renderedFrames,viewDistance:this.viewDistance,cameraFar:this.rendering.camera.far,
      ready:this.startupReady&&this.world.isViewReady,streaming:this.world.streamingStats,startup:{...this.startupPreparation,gpu:this.rendering.residentPreparation},distanceControl:this.distanceController.diagnostics,shadowMapSize:4096,shadowCascades:4,antialias:true,dpr:this.rendering.renderer.getPixelRatio()});
      api.advance=(seconds:number):void=>{
        let remaining=clamp(seconds,0,300);
        while(remaining>1e-9){
          const dt=Math.min(remaining,1/120);this.simulate(dt);this.syncPresentation(dt,false,false);remaining-=dt;
        }
        // Intermediate review steps are not drawn. Preserve every simulation
        // and presentation step, then prepare the final shadow coverage once.
        this.atmosphere.prepareRender();this.drawPreparedFrame();
      };
      api.setControls=(controls:Partial<Controls>):void=>{Object.assign(this.input.controls,controls);};
      api.setFlightState=(partial:Record<string,unknown>):void=>{
        if(this.mode!=='manual')this.startManual();this.reviewPose=false;const {position,...fields}=partial;Object.assign(this.manual.state,fields);
        if(position){const p=position as {x?:number;y?:number;z?:number};this.manual.state.position.set(p.x??this.manual.state.position.x,p.y??this.manual.state.position.y,p.z??this.manual.state.position.z);}
        this.manual.state.altitude=Math.max(0,this.manual.state.position.y-this.sampleGround(this.manual.state.position.x,this.manual.state.position.z));this.world.update(this.manual.state.position.x,this.manual.state.position.z);this.chase.reset();this.syncPresentation(0,true);this.drawPreparedFrame();
      };
      api.reviewBiome=(id:string,altitude=80):void=>{
        this.review=true;this.startManual();const location=this.world.findBiome(id);this.world.update(location.x,location.z);
        const x=location.x,z=location.z;
        const s=this.manual.state;s.position.set(x,this.sampleGround(x,z)+altitude,z);s.altitude=altitude;s.grounded=false;s.speed=45;s.throttle=.72;s.rpm=2002;s.phase='flight';
        this.reviewPose=true;
        const view=this.world.getReviewView(id,altitude,this.viewDistance);
        this.rendering.camera.position.fromArray(view.camera);this.rendering.camera.lookAt(new THREE.Vector3().fromArray(view.target));
        this.rendering.camera.fov=48;this.rendering.camera.updateProjectionMatrix();this.syncPresentation(.2);this.drawPreparedFrame();
      };
      api.reviewCamera=(position:[number,number,number],target:[number,number,number],fov=48):void=>{
        if(![...position,...target,fov].every(Number.isFinite))return;
        this.review=true;this.reviewPose=true;
        this.rendering.camera.position.fromArray(position);this.rendering.camera.lookAt(new THREE.Vector3().fromArray(target));
        this.rendering.camera.fov=clamp(fov,20,85);this.rendering.camera.updateProjectionMatrix();
        this.syncPresentation(0);this.drawPreparedFrame();
      };
      api.streamTo=(x:number,z:number):void=>{this.world.update(x,z);};
      api.dispose=():void=>this.dispose();
    }
    window.__AIRPLANE_EXPERIENCE__=api;
    Object.defineProperty(window,'__THREE_GAME_DIAGNOSTICS__',{configurable:true,get:()=>this.diagnostics});
  }
  private debugGui():void{const settings={timeScale:this.timeScale,review:this.review};this.gui=new GUI({title:'Flight diagnostics'});this.gui.add(settings,'timeScale',0,10,.1).onChange((v:number)=>{this.timeScale=v;});this.gui.add(settings,'review').onChange((v:boolean)=>{this.review=v;});this.gui.close();}
  dispose():void{if(this.disposed)return;this.disposed=true;this.loop.dispose();this.input.dispose();this.inspection.dispose();this.rendering.disposeWorldCulling();this.world.dispose();this.aircraft.dispose();this.atmosphere.dispose();this.vfx.dispose();this.audio.dispose();this.hud.dispose();this.rendering.dispose();this.gui?.destroy();this.streamingStatus?.remove();window.removeEventListener('keydown',this.keydown);document.removeEventListener('fullscreenchange',this.fullscreenChanged);}
}

export interface ExperienceAPI {
  start():void;startManual():void;startAutopilot():void;visitBiome(id:string):void;reset():void;setTimeScale(value:number):void;setReviewMode(enabled:boolean):void;setPaintColor(hex:string):void;
  readonly state:Game['diagnostics']['state'];
  readonly diagnostics:Game['diagnostics'];
  setRenderDistance?(distance:number|null):void;
  setTightShadowCulling?(enabled:boolean):void;
  getStreamingStats?():{frame:number;renderedFrames:number;viewDistance:number;cameraFar:number;ready:boolean;streaming:unknown;startup:unknown;distanceControl:unknown;shadowMapSize:number;shadowCascades:number;antialias:boolean;dpr:number};
  advance?(seconds:number):void;setControls?(controls:Partial<Controls>):void;setFlightState?(state:Record<string,unknown>):void;reviewBiome?(id:string,altitude?:number):void;reviewCamera?(position:[number,number,number],target:[number,number,number],fov?:number):void;streamTo?(x:number,z:number):void;dispose?():void;
}
