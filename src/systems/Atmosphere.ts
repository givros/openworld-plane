import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { SKY_GLSL } from './AtmosphereShader';
import { ShadowCasterVolume,ShadowReceiverBounds } from './ShadowCasterVolume';
import { installReceiverPlaneShadows } from './ReceiverPlaneShadows';
import type { InstanceShadowPass } from '../world/PassInstanceCuller';
import { StableShadowProjection,computeCascadeExtents,computeStableShadowDistanceEnvelope } from '../experiments/StableShadowProjection';

export class Atmosphere {
  readonly root = new THREE.Group();
  private readonly middleShadowCache=typeof window!=='undefined'&&new URLSearchParams(window.location.search).get('middleShadowCache')!=='0';
  private readonly firstStableShadowPass=this.middleShadowCache?1:2;
  /** These cascades can become cacheable after the initial ground camera moves. */
  readonly cacheableShadowPassIndices:readonly number[]=this.middleShadowCache?[1,2,3]:[2,3];
  private readonly sunlight: CSM;
  private readonly projection = new THREE.Matrix4();
  private readonly shadowFrustumCamera = new THREE.PerspectiveCamera();
  private readonly stableShadows=typeof window!=='undefined'&&(new URLSearchParams(window.location.search).get('stableShadows')==='1'||new URLSearchParams(window.location.search).get('cacheShadows')!=='0');
  private readonly wideShadowDepth=typeof window!=='undefined'&&new URLSearchParams(window.location.search).get('wideShadowDepth')!=='0';
  private readonly nativeShadowDepths:Array<{near:number;far:number;bias:number}>=[];
  private readonly nativeShadowExtents:number[]=[];
  private readonly stablePasses:boolean[]=[];
  private stableReferenceKey='';
  private stableReferences:Array<StableShadowProjection|undefined>=[];
  private readonly casterVolumes:ShadowCasterVolume[]=[];
  private readonly receiverBounds=new ShadowReceiverBounds();
  private readonly staticReceiverBounds=new ShadowReceiverBounds();
  private readonly combinedReceiverBounds=new THREE.Box3();
  private staticWorld:THREE.Object3D|null=null;
  private staticRevision=():number=>0;
  private preparedStaticRevision=-1;
  private readonly staticWorldMatrix=new THREE.Matrix4();
  private viewDistance=6000;
  private groundDistance=6000;
  // Keep the full-resolution caster geometry, but reject instances that cannot
  // reach a visible receiver. The 32 m volume margin is deliberately broad:
  // it preserves the canonical shadow image while removing only provably
  // irrelevant work from the shadow passes.
  tightShadowCulling=true;
  private readonly instanceMaterialHooks=new WeakMap<THREE.Material,{compile:THREE.Material['onBeforeCompile'];key:THREE.Material['customProgramCacheKey']}>();
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly clouds: THREE.InstancedMesh;
  private readonly cloudData = new Float32Array(85 * 6);
  private readonly dummy = new THREE.Object3D();
  private drift = 0;
  constructor(private readonly scene: THREE.Scene, private readonly renderer: THREE.WebGLRenderer, private readonly camera: THREE.PerspectiveCamera) {
    // Landscape visibility never blends the authored world into the sky.
    scene.fog=null;
    this.root.name = 'Atmosphere';
    this.root.add(new THREE.HemisphereLight('#c6e6f8', '#657158', .72), new THREE.AmbientLight('#ffe9d0', .08));
    const fill = new THREE.DirectionalLight('#c5e4f7', .24); fill.position.set(65, 48, 74);
    const rim = new THREE.DirectionalLight('#ffd49a', .18); rim.position.set(34, 34, -92);
    this.root.add(fill, fill.target, rim, rim.target);
    // Cover the viewed landscape as well as the aircraft. The former 480 m
    // square left most settlements and forest canopies without any sun shadows.
    this.sunlight = new CSM({camera, parent:scene, cascades:4, maxFar:6000,
      mode:'custom', customSplitsCallback:(_count,_near,far,breaks)=>{
        if(this.viewDistance>=6000)breaks.push(100/far,450/far,1700/far,1);
        else breaks.push(.12,.32,.62,1);
      },
      shadowMapSize:4096, shadowBias:-.0000003,
      lightDirection:new THREE.Vector3(.48,-.58,.65).normalize(), lightIntensity:2.6,
      lightNear:1, lightFar:10000, lightMargin:1500});
    installReceiverPlaneShadows();
    this.sunlight.fade=true;
    this.sunlight.lights.forEach((light,index)=>{
      // The instance shadow culler runs before WebGLShadowMap sets this flag.
      (light.shadow.camera as THREE.OrthographicCamera&{_reversedDepth:boolean})._reversedDepth=renderer.capabilities?.reversedDepthBuffer??false;
      light.shadow.camera.updateProjectionMatrix();
      light.color.set('#fff0c8');
      light.shadow.bias=[-.000006,-.000018,-.00004,-.00012][index];
      light.shadow.normalBias=[.015,.05,.15,.45][index];
      this.nativeShadowDepths[index]={near:light.shadow.camera.near,far:light.shadow.camera.far,bias:light.shadow.bias};
      const volume=new ShadowCasterVolume(),frustum=light.shadow.getFrustum();
      const intersectsObject=frustum.intersectsObject.bind(frustum);
      frustum.intersectsObject=object=>intersectsObject(object)&&(this.stablePasses[index]||volume.intersectsObject(object));
      this.casterVolumes.push(volume);
    });
    const skyMat = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, toneMapped:false,
      uniforms: {
        zenith: { value: new THREE.Color('#3f86c3') }, upper: { value: new THREE.Color('#82bfe3') },
        horizon: { value: new THREE.Color('#c4d9df') }, lower: { value: new THREE.Color('#e6d6ba') },
        haze: { value: new THREE.Color('#f4c58e') }, sunDirection: { value: new THREE.Vector3(-.48, .58, -.65).normalize() },
      },
      vertexShader: `varying vec3 vDirection; void main(){ vDirection=normalize(position); vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position=p.xyww;
        #ifdef USE_REVERSED_DEPTH_BUFFER
          gl_Position.z=0.0;
        #endif
      }`,
      fragmentShader: `varying vec3 vDirection; ${SKY_GLSL}
        void main(){gl_FragColor=vec4(cropperSkyRadiance(normalize(vDirection)),1.0);\n#include <colorspace_fragment>\n}`,
    });
    // Shader chunks must begin at a new source line.
    skyMat.fragmentShader = skyMat.fragmentShader.replace(' #include', '\n#include').replace(/ #include/g, '\n#include');
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2400, 48, 24), skyMat);
    this.sky.name = 'Atmospheric sky dome'; this.sky.renderOrder = -1000; this.sky.frustumCulled = false; scene.add(this.sky);
    const cloudMat = new THREE.MeshLambertMaterial({ color: '#f5f5ec', emissive: '#b8cbcf', emissiveIntensity: .55, transparent: true, opacity: .76, depthWrite: false });
    this.clouds = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), cloudMat, 85);
    this.clouds.name = 'Twelve drifting cloud clusters'; this.clouds.frustumCulled = false;
    this.clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    let seed = 701;
    const random = (): number => { seed = Math.imul(seed ^ (seed >>> 15), 1 | seed); seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed); return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < 85; i++) {
      const cluster = i % 12, angle = cluster / 12 * Math.PI * 2;
      const radius = 380 + (cluster % 4) * 135;
      this.cloudData.set([Math.cos(angle) * radius + (random() - .5) * 170, 540 + (cluster % 5) * 51 + random() * 30, Math.sin(angle) * radius + (random() - .5) * 100, 18 + random() * 29, 5 + random() * 9, 11 + random() * 21], i * 6);
    }
    scene.add(this.root, this.clouds);
    const materials=new Set<THREE.Material>();
    scene.traverse(object=>{if(object instanceof THREE.Mesh){
      for(const material of Array.isArray(object.material)?object.material:[object.material])
        if(material instanceof THREE.MeshStandardMaterial||material instanceof THREE.MeshPhongMaterial||material instanceof THREE.MeshLambertMaterial)materials.add(material);
    }});
    this.registerMaterials(materials);
    this.updateShadowFrustums();this.projection.copy(camera.projectionMatrix);
  }
  /** Apply the same lighting and texture fidelity before a streamed chunk is shown. */
  registerMaterials(materials:Iterable<THREE.Material>):void {
    for(const material of materials){
      if(!(material instanceof THREE.MeshStandardMaterial||material instanceof THREE.MeshPhongMaterial||material instanceof THREE.MeshLambertMaterial)||this.instanceMaterialHooks.has(material))continue;
      const compatible=material.onBeforeCompile===THREE.Material.prototype.onBeforeCompile&&
        material.customProgramCacheKey===THREE.Material.prototype.customProgramCacheKey;
      const normalMap=(material as THREE.MeshStandardMaterial).normalMap;
      if(normalMap){normalMap.anisotropy=this.renderer.capabilities?.getMaxAnisotropy()??1;normalMap.needsUpdate=true;}
      this.sunlight.setupMaterial(material);
      material.addEventListener('dispose',()=>this.sunlight.shaders.delete(material));
      if(compatible)this.instanceMaterialHooks.set(material,{compile:material.onBeforeCompile,key:material.customProgramCacheKey});
    }
  }
  setStaticWorld(root:THREE.Object3D,revision:()=>number):void {
    this.staticWorld=root;this.staticRevision=revision;this.preparedStaticRevision=-1;
  }
  setViewDistance(distance:number,groundDistance=distance,cameraAltitude=0):void {
    if(!Number.isFinite(distance)||distance<=this.camera.near)throw new Error('Invalid landscape view distance');
    if(!Number.isFinite(groundDistance)||groundDistance<=0||!Number.isFinite(cameraAltitude)||cameraAltitude<0)
      throw new Error('Landscape visibility requires a positive range and nonnegative altitude');
    this.groundDistance=groundDistance;
    if(Math.abs(distance-this.viewDistance)<.5)return;
    this.viewDistance=distance;this.sunlight.maxFar=distance;
    this.updateShadowFrustums();this.projection.copy(this.camera.projectionMatrix);
  }
  readonly canCullInstanceMaterial=(material:THREE.Material):boolean=>{
    const hooks=this.instanceMaterialHooks.get(material);
    return !!hooks&&hooks.compile===material.onBeforeCompile&&hooks.key===material.customProgramCacheKey;
  };
  /** Preserve native whole-batch shadow coverage; compact only by the light frustum. */
  readonly instanceShadowPasses=():readonly InstanceShadowPass[]=>this.sunlight.lights.map((light,index)=>{
    light.shadow.updateMatrices(light);
    const frustum=light.shadow.getFrustum();
    // Receiver-plane PCF can retain edge samples beyond a tightly clipped
    // per-instance receiver volume. Keep the established canonical sphere gate
    // (including its receiver-volume predicate) before exact light clipping.
    return {light,frustum,sourceFilter:source=>!source.frustumCulled||frustum.intersectsObject(source),casterVolume:this.tightShadowCulling&&!this.stablePasses[index]?this.casterVolumes[index].clippingVolume:undefined};
  });
  readonly canCacheShadowPass=(index:number):boolean=>this.stablePasses[index]===true;
  private updateShadowFrustums():void {
    if(this.camera.reversedDepth){
      // r184 CSMFrustum reconstructs corners from conventional -1/+1 depth.
      // Supply an equivalent conventional projection for those bounds only;
      // the view camera and all actual shadow cameras keep reversed depth.
      this.shadowFrustumCamera.copy(this.camera);
      (this.shadowFrustumCamera as THREE.PerspectiveCamera&{_reversedDepth:boolean})._reversedDepth=false;
      this.shadowFrustumCamera.updateProjectionMatrix();
      this.sunlight.camera=this.shadowFrustumCamera;
      try{this.sunlight.updateFrustums();}finally{this.sunlight.camera=this.camera;}
    }else this.sunlight.updateFrustums();
    // Three r184 expands CSM fade bounds with max(camera.far,maxFar), while
    // its shader fades with min(...). With a longer scene far plane that
    // leaves transition-edge receivers outside their contributing shadow map.
    const shaderRange=Math.min(this.camera.far,this.sunlight.maxFar)-this.camera.near;
    const boundsRange=Math.max(this.camera.far,this.sunlight.maxFar)-this.camera.near;
    if(this.sunlight.fade&&shaderRange!==boundsRange)this.sunlight.frustums.forEach((frustum,index)=>{
      const depth=frustum.vertices.far[0].z;
      const extra=.25*depth*depth*(1/shaderRange-1/boundsRange);
      const camera=this.sunlight.lights[index].shadow.camera;
      camera.left-=extra/2;camera.right+=extra/2;
      camera.bottom-=extra/2;camera.top+=extra/2;
      camera.updateProjectionMatrix();
    });
    this.sunlight.lights.forEach((light,index)=>{this.nativeShadowExtents[index]=light.shadow.camera.right-light.shadow.camera.left;});
  }
  private prepareStableShadows():void {
    if(!this.stableShadows)return;
    // Reserve a climb envelope from the chosen ground radius at first allocation.
    // Crossing the next 64 m bin during normal flight then needs only scrolling,
    // while the base-distance reference retains at least native texel density.
    const {lowerFar,upperFar}=computeStableShadowDistanceEnvelope(this.groundDistance,Math.min(this.camera.far,this.sunlight.maxFar),this.camera.near);
    const key=[lowerFar,upperFar,this.camera.aspect,this.camera.near,...this.sunlight.breaks].join(':');
    if(key!==this.stableReferenceKey){
      const reference=this.camera.clone();reference.far=upperFar;
      const largest=computeCascadeExtents(reference,upperFar,this.sunlight.breaks,52,this.sunlight.fade);
      reference.far=lowerFar;
      const smallest=computeCascadeExtents(reference,lowerFar,this.sunlight.breaks,43,this.sunlight.fade);
      this.stableReferences=this.sunlight.lights.map((_light,index)=>index<this.firstStableShadowPass?undefined:new StableShadowProjection({
        lightDirection:this.sunlight.lightDirection,referenceWidth:largest[index],referenceHeight:largest[index],
        minimumNativeWidth:smallest[index],minimumNativeHeight:smallest[index],nativeMapSize:4096,
        maxTextureSize:this.renderer.capabilities.maxTextureSize,
        retainCoveredProjection:true,
        // The complete-map rectangle reaches well beyond the old +/-5 km
        // light-depth slab even though its visible land is only 3.2 km wide.
        // Keep a fixed, wider Z reference so both far maps remain cacheable
        // at wide desktop aspect ratios without reducing their texel density.
        depthAxisOrigin:this.wideShadowDepth&&index>=2?32768:5000,
        near:this.nativeShadowDepths[index].near,
        far:this.wideShadowDepth&&index>=2?65536:this.nativeShadowDepths[index].far,
      }));
      this.stableReferenceKey=key;
    }
    this.sunlight.lights.forEach((light,index)=>{
      if(index<this.firstStableShadowPass)return;
      const reference=this.stableReferences[index],extent=this.nativeShadowExtents[index];
      // The immutable authored stream spans -18..331.65 m. Include all live
      // receiver/caster bounds as well, particularly the animated aircraft.
      const bounds=this.combinedReceiverBounds;
      const minY=bounds.isEmpty()?-18:Math.min(-18,bounds.min.y),maxY=bounds.isEmpty()?600:Math.max(600,bounds.max.y);
      const nativeDepth=this.nativeShadowDepths[index],camera=light.shadow.camera;
      const wide=this.wideShadowDepth&&index>=2;
      if(wide)camera.far=65536;
      this.stablePasses[index]=!!reference?.apply(light,{width:extent,height:extent,mapSize:4096},[minY,maxY]).applied;
      if(wide){
        if(this.stablePasses[index]){
          // Orthographic shadow bias is in normalized depth; retain its
          // original world-space distance when expanding the Z interval.
          light.shadow.bias=nativeDepth.bias*(nativeDepth.far-nativeDepth.near)/(camera.far-camera.near);
        }else{
          camera.near=nativeDepth.near;camera.far=nativeDepth.far;
          light.shadow.bias=nativeDepth.bias;camera.updateProjectionMatrix();
        }
      }
      if(!this.stablePasses[index])light.shadow.mapSize.set(4096,4096);
      const map=light.shadow.map;
      if(map&&(map.width!==light.shadow.mapSize.x||map.height!==light.shadow.mapSize.y))map.setSize(light.shadow.mapSize.x,light.shadow.mapSize.y);
      if(wide&&this.stablePasses[index]&&map?.depthTexture&&map.depthTexture.type!==THREE.FloatType){
        // Three creates the first native PCF target itself. Upgrade that target
        // once it exists; the scrolling cache observes and recreates its format
        // before copying any depth. Width, PCF filtering and compare mode stay.
        map.dispose();map.depthTexture.type=THREE.FloatType;map.depthTexture.needsUpdate=true;
      }
      light.shadow.updateMatrices(light);
    });
  }
  /** Refresh camera-dependent shadow coverage immediately before a draw. */
  prepareRender(): void {
    if(!this.projection.equals(this.camera.projectionMatrix)){
      this.updateShadowFrustums();this.projection.copy(this.camera.projectionMatrix);
    }
    if(this.stableShadows)this.sunlight.lights.forEach((light,index)=>{
      if(index<this.firstStableShadowPass)return;
      const extent=this.nativeShadowExtents[index],camera=light.shadow.camera;
      const nativeDepth=this.nativeShadowDepths[index];
      camera.near=nativeDepth.near;camera.far=nativeDepth.far;light.shadow.bias=nativeDepth.bias;
      camera.left=-extent/2;camera.right=extent/2;camera.bottom=-extent/2;camera.top=extent/2;camera.updateProjectionMatrix();
      this.stablePasses[index]=false;
    });
    this.camera.updateMatrixWorld();this.sunlight.update();
    // The square light maps include space that cannot cast into visible receiver
    // geometry. Cull only that space; keep off-screen casters along the sun rays.
    let receivers:THREE.Box3;
    if(this.staticWorld){
      // Static source transforms are refreshed by their owner on chunk commits.
      // Dynamic aircraft, clouds and light targets still update every frame.
      this.scene.updateWorldMatrix(true,false);
      this.staticWorld.updateWorldMatrix(false,false);
      const revision=this.staticRevision();
      if(revision!==this.preparedStaticRevision||!this.staticWorldMatrix.equals(this.staticWorld.matrixWorld)){
        this.staticWorld.updateMatrixWorld(true);
        this.staticReceiverBounds.update(this.staticWorld);
        this.preparedStaticRevision=revision;this.staticWorldMatrix.copy(this.staticWorld.matrixWorld);
      }
      for(const child of this.scene.children)if(child!==this.staticWorld&&!child.userData.passInstanceProxy)child.updateMatrixWorld(true);
      receivers=this.combinedReceiverBounds.copy(this.staticReceiverBounds.bounds).union(this.receiverBounds.update(this.scene,this.staticWorld));
    }else{
      this.scene.updateMatrixWorld();receivers=this.receiverBounds.update(this.scene);
    }
    this.prepareStableShadows();
    const range=Math.min(this.camera.far,this.sunlight.maxFar)-this.camera.near;
    this.casterVolumes.forEach((volume,index)=>{
      const start=index===0?0:this.sunlight.breaks[index-1],end=this.sunlight.breaks[index];
      const near=(start-.125*start*start)*range,far=(end+.125*end*end)*range;
      const shadow=this.sunlight.lights[index].shadow;
      const texel=(shadow.camera.right-shadow.camera.left)/shadow.mapSize.x;
      volume.update(this.camera,near,far,receivers,this.sunlight.lightDirection,
        this.sunlight.lightFar+receivers.getSize(new THREE.Vector3()).length(),texel*4+shadow.normalBias+34);
    });
    // The moving aircraft and sun's moving coverage require a fresh shadow map.
    this.renderer.shadowMap.autoUpdate = true;
  }
  update(dt: number, p: THREE.Vector3, altitude: number, prepareForRender = true): void {
    this.sky.position.copy(this.camera.position);
    this.root.position.set(p.x, p.y - altitude, p.z);
    if(prepareForRender)this.prepareRender();
    this.drift += dt * 1.6;
    for (let i = 0; i < 85; i++) {
      const k = i * 6;
      const dx = ((this.cloudData[k] + this.drift - p.x) % 2380 + 3570) % 2380 - 1190;
      const dz = ((this.cloudData[k + 2] - p.z) % 2380 + 3570) % 2380 - 1190;
      this.dummy.position.set(p.x + dx, this.cloudData[k + 1], p.z + dz);
      this.dummy.scale.set(this.cloudData[k + 3], this.cloudData[k + 4], this.cloudData[k + 5]);
      this.dummy.rotation.y = i * .86; this.dummy.updateMatrix(); this.clouds.setMatrixAt(i, this.dummy.matrix);
    }
    this.clouds.instanceMatrix.needsUpdate = true;
  }
  dispose(): void {
    this.sky.geometry.dispose(); this.sky.material.dispose(); this.clouds.geometry.dispose(); (this.clouds.material as THREE.Material).dispose();
    this.sunlight.lights.forEach(light=>light.shadow.dispose());this.sunlight.remove();this.sunlight.dispose();
    this.root.removeFromParent(); this.sky.removeFromParent(); this.clouds.removeFromParent();
  }
}
