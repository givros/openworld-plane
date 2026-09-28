// Experimental ABI-compatible four-sample packet visibility kernel.
// One invocation = one pixel. shape.w=1 uses the scalar reference; shape.w=4
// shares hierarchy/triangle loads across four exact MSAA rays. No cone/LOD test.
// spare.x retains scalar stack error bits. spare.y counts rays recalculated by
// the exact scalar fallback after a packet stack overflow (zero normally).
struct Node { lo: vec3<f32>, left: u32, hi: vec3<f32>, right: u32 }
struct Instance { row0: vec4<f32>, row1: vec4<f32>, row2: vec4<f32>, data: vec4<u32> }
struct Params { origin: vec4<f32>, base: vec4<f32>, dx: vec4<f32>, dy: vec4<f32>, shape: vec4<u32>, clip: vec4<f32> }
struct Hit { instance: u32, triangle: u32, distance: f32, u: f32, v: f32, steps: u32, spare: vec2<u32> }
@group(0) @binding(0) var<storage,read> nodes: array<Node>;
@group(0) @binding(1) var<storage,read> positions: array<f32>;
@group(0) @binding(2) var<storage,read> triangles: array<u32>;
@group(0) @binding(3) var<storage,read> instances: array<Instance>;
@group(0) @binding(4) var<storage,read> instanceOrder: array<u32>;
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var<storage,read_write> hits: array<Hit>;
@group(0) @binding(7) var outputImage: texture_storage_2d<rgba8unorm,write>;

struct Rays {
 origin: vec3<f32>,
 x: vec4<f32>, y: vec4<f32>, z: vec4<f32>,
 invX: vec4<f32>, invY: vec4<f32>, invZ: vec4<f32>,
 near: vec4<f32>, far: vec4<f32>
}
struct PacketHit {
 instance: vec4<u32>, triangle: vec4<u32>, distance: vec4<f32>,
 u: vec4<f32>, v: vec4<f32>, steps: vec4<u32>, overflow: u32
}
struct StackEntry { node: u32, mask: u32 }

fn position(index: u32) -> vec3<f32> {
 let p=index*3u; return vec3<f32>(positions[p],positions[p+1u],positions[p+2u]);
}
fn inverseDirection(d: vec3<f32>) -> vec3<f32> {
 return select(vec3<f32>(1e30),1.0/d,abs(d)>vec3<f32>(1e-30));
}
fn laneMask(condition: vec4<bool>) -> u32 {
 return select(0u,1u,condition.x)|select(0u,2u,condition.y)|select(0u,4u,condition.z)|select(0u,8u,condition.w);
}
fn laneFlags(mask: u32) -> vec4<bool> {
 return (vec4<u32>(mask)&vec4<u32>(1u,2u,4u,8u))!=vec4<u32>(0u);
}
fn boxNearPacket(node: Node, ray: Rays, far: vec4<f32>) -> vec4<f32> {
 let ax=(node.lo.x-ray.origin.x)*ray.invX; let bx=(node.hi.x-ray.origin.x)*ray.invX;
 let ay=(node.lo.y-ray.origin.y)*ray.invY; let by=(node.hi.y-ray.origin.y)*ray.invY;
 let az=(node.lo.z-ray.origin.z)*ray.invZ; let bz=(node.hi.z-ray.origin.z)*ray.invZ;
 let entry=max(ray.near,max(min(ax,bx),max(min(ay,by),min(az,bz))));
 let leave=min(far,min(max(ax,bx),min(max(ay,by),max(az,bz))));
 return select(vec4<f32>(1e30),entry,entry<=leave);
}

// Preserve each ray's own near-first order, including right-first equal-box ties.
// Usually two entries suffice; only divergent near orders require four entries.
fn pushChildren(stack: ptr<function,array<StackEntry,32>>, top: ptr<function,u32>,
 left: u32, right: u32, leftNear: vec4<f32>, rightNear: vec4<f32>, mask: u32) -> bool {
 let lm=mask&laneMask(leftNear<vec4<f32>(1e30));
 let rm=mask&laneMask(rightNear<vec4<f32>(1e30));
 let both=lm&rm;
 let leftFirst=both&laneMask(leftNear<rightNear);
 let rightFirst=both&(~leftFirst);
 if(leftFirst==0u){
  let needed=select(0u,1u,lm!=0u)+select(0u,1u,rm!=0u);
  if(*top+needed>32u){return false;}
  if(lm!=0u){(*stack)[*top]=StackEntry(left,lm);*top+=1u;}
  if(rm!=0u){(*stack)[*top]=StackEntry(right,rm);*top+=1u;}
 }else if(rightFirst==0u){
  let needed=select(0u,1u,lm!=0u)+select(0u,1u,rm!=0u);
  if(*top+needed>32u){return false;}
  if(rm!=0u){(*stack)[*top]=StackEntry(right,rm);*top+=1u;}
  if(lm!=0u){(*stack)[*top]=StackEntry(left,lm);*top+=1u;}
 }else{
  if(*top+4u>32u){return false;}
  let leftOnly=lm&(~rm); let rightOnly=rm&(~lm);
  (*stack)[*top]=StackEntry(left,rightFirst);
  (*stack)[*top+1u]=StackEntry(right,rightFirst|rightOnly);
  (*stack)[*top+2u]=StackEntry(right,leftFirst);
  (*stack)[*top+3u]=StackEntry(left,leftFirst|leftOnly);
  *top+=4u;
 }
 return true;
}

fn traceBlasPacket(instanceId: u32, world: Rays, mask: u32, previous: PacketHit) -> PacketHit {
 let instance=instances[instanceId]; let p=vec4<f32>(world.origin,1.0);
 var ray=world;
 ray.origin=vec3<f32>(dot(instance.row0,p),dot(instance.row1,p),dot(instance.row2,p));
 // Keep the reference's dot/normalize operations for each lane's ray setup.
 for(var lane=0u;lane<4u;lane++){
  let d=vec4<f32>(world.x[lane],world.y[lane],world.z[lane],0.0);
  let rd=vec3<f32>(dot(instance.row0,d),dot(instance.row1,d),dot(instance.row2,d));
  let inv=inverseDirection(rd);
  ray.x[lane]=rd.x;ray.y[lane]=rd.y;ray.z[lane]=rd.z;
  ray.invX[lane]=inv.x;ray.invY[lane]=inv.y;ray.invZ[lane]=inv.z;
 }
 var hit=previous;var stack:array<StackEntry,32>;var top=1u;stack[0]=StackEntry(instance.data.x,mask);
 loop{
  if(top==0u){break;}top--;let entry=stack[top];let node=nodes[entry.node];
  hit.steps+=select(vec4<u32>(0u),vec4<u32>(1u),laneFlags(entry.mask));
  let laneActive=entry.mask&laneMask(boxNearPacket(node,ray,hit.distance)<vec4<f32>(1e30));
  if(laneActive==0u){continue;}
  if((node.right&0x80000000u)!=0u){
   let count=node.right&0x7fffffffu;
   for(var j=0u;j<count;j++){
    let triangle=node.left+j;let index=triangle*3u;
    // One triangle fetch, four full Moller-Trumbore intersection tests.
    let a=position(triangles[index]);let e1=position(triangles[index+1u])-a;let e2=position(triangles[index+2u])-a;
    let cx=ray.y*e2.z-ray.z*e2.y;
    let cy=ray.z*e2.x-ray.x*e2.z;
    let cz=ray.x*e2.y-ray.y*e2.x;
    let det=e1.x*cx+e1.y*cy+e1.z*cz;
    var accepted=laneActive&laneMask(abs(det)>=vec4<f32>(1e-30));
    if(accepted==0u){continue;}
    let inverse=1.0/det;let delta=ray.origin-a;
    let u=(delta.x*cx+delta.y*cy+delta.z*cz)*inverse;
    accepted=accepted&laneMask(u>=vec4<f32>(0.0))&laneMask(u<=vec4<f32>(1.0));
    if(accepted==0u){continue;}
    let q=cross(delta,e1);
    let v=(ray.x*q.x+ray.y*q.y+ray.z*q.z)*inverse;
    accepted=accepted&laneMask(v>=vec4<f32>(0.0))&laneMask(u+v<=vec4<f32>(1.0));
    if(accepted==0u){continue;}
    let t=dot(e2,q)*inverse;
    accepted=accepted&laneMask(t>=ray.near)&laneMask(t<hit.distance);
    let flags=laneFlags(accepted);
    hit.instance=select(hit.instance,vec4<u32>(instanceId),flags);
    hit.triangle=select(hit.triangle,vec4<u32>(triangle),flags);
    hit.distance=select(hit.distance,t,flags);hit.u=select(hit.u,u,flags);hit.v=select(hit.v,v,flags);
   }
  }else{
   let leftNear=boxNearPacket(nodes[node.left],ray,hit.distance);
   let rightNear=boxNearPacket(nodes[node.right],ray,hit.distance);
   if(!pushChildren(&stack,&top,node.left,node.right,leftNear,rightNear,laneActive)){hit.overflow=1u;return hit;}
  }
 }
 return hit;
}

fn traceWorldPacket(ray: Rays) -> PacketHit {
 var hit=PacketHit(vec4<u32>(0xffffffffu),vec4<u32>(0xffffffffu),ray.far,vec4<f32>(0.0),vec4<f32>(0.0),vec4<u32>(0u),0u);
 var stack:array<StackEntry,32>;var top=1u;stack[0]=StackEntry(params.shape.z,15u);
 loop{
  if(top==0u){break;}top--;let entry=stack[top];let node=nodes[entry.node];
  hit.steps+=select(vec4<u32>(0u),vec4<u32>(1u),laneFlags(entry.mask));
  let laneActive=entry.mask&laneMask(boxNearPacket(node,ray,hit.distance)<vec4<f32>(1e30));
  if(laneActive==0u){continue;}
  if((node.right&0x80000000u)!=0u){
   let count=node.right&0x7fffffffu;
   for(var j=0u;j<count;j++){
    hit=traceBlasPacket(instanceOrder[node.left+j],ray,laneActive,hit);
    if(hit.overflow!=0u){return hit;}
   }
  }else{
   let leftNear=boxNearPacket(nodes[node.left],ray,hit.distance);
   let rightNear=boxNearPacket(nodes[node.right],ray,hit.distance);
   if(!pushChildren(&stack,&top,node.left,node.right,leftNear,rightNear,laneActive)){hit.overflow=2u;return hit;}
  }
 }
 return hit;
}

// Exact scalar reference/fallback, retaining original hit identity and float32
// payload. Real BVH depth is <=22. A scalar overflow remains an explicit error.
fn boxNearScalar(node: Node, ro: vec3<f32>, inv: vec3<f32>, near: f32, far: f32) -> f32 {
 let a=(node.lo-ro)*inv;let b=(node.hi-ro)*inv;let low=min(a,b);let high=max(a,b);
 let entry=max(near,max(low.x,max(low.y,low.z)));let leave=min(far,min(high.x,min(high.y,high.z)));
 return select(1e30,entry,entry<=leave);
}
fn traceBlasScalar(instanceId: u32, worldOrigin: vec3<f32>, worldDirection: vec3<f32>, near: f32, previous: Hit) -> Hit {
 let instance=instances[instanceId];let p=vec4<f32>(worldOrigin,1.0);let d=vec4<f32>(worldDirection,0.0);
 let ro=vec3<f32>(dot(instance.row0,p),dot(instance.row1,p),dot(instance.row2,p));
 let rd=vec3<f32>(dot(instance.row0,d),dot(instance.row1,d),dot(instance.row2,d));let inv=inverseDirection(rd);
 var hit=previous;var stack:array<u32,32>;var top=1u;stack[0]=instance.data.x;
 loop{
  if(top==0u){break;}top--;let node=nodes[stack[top]];hit.steps++;
  if(boxNearScalar(node,ro,inv,near,hit.distance)>=1e30){continue;}
  if((node.right&0x80000000u)!=0u){
   let count=node.right&0x7fffffffu;
   for(var j=0u;j<count;j++){
    let triangle=node.left+j;let index=triangle*3u;
    let a=position(triangles[index]);let edge1=position(triangles[index+1u])-a;let edge2=position(triangles[index+2u])-a;
    let crossDirection=cross(rd,edge2);let determinant=dot(edge1,crossDirection);
    if(abs(determinant)<1e-30){continue;}
    let inverse=1.0/determinant;let delta=ro-a;let u=dot(delta,crossDirection)*inverse;
    if(u<0.0||u>1.0){continue;}let q=cross(delta,edge1);let v=dot(rd,q)*inverse;
    if(v<0.0||u+v>1.0){continue;}let t=dot(edge2,q)*inverse;
    if(t>=near&&t<hit.distance){hit.instance=instanceId;hit.triangle=triangle;hit.distance=t;hit.u=u;hit.v=v;}
   }
  }else{
   let leftNear=boxNearScalar(nodes[node.left],ro,inv,near,hit.distance);let rightNear=boxNearScalar(nodes[node.right],ro,inv,near,hit.distance);
   if(leftNear<1e30&&rightNear<1e30){
    if(top+2u>32u){hit.spare.x=1u;return hit;}
    stack[top]=select(node.left,node.right,leftNear<rightNear);stack[top+1u]=select(node.right,node.left,leftNear<rightNear);top+=2u;
   }else if(leftNear<1e30){stack[top]=node.left;top++;}else if(rightNear<1e30){stack[top]=node.right;top++;}
  }
 }
 return hit;
}
fn traceWorldScalar(ro: vec3<f32>, rd: vec3<f32>, near: f32, far: f32) -> Hit {
 var hit=Hit(0xffffffffu,0xffffffffu,far,0.0,0.0,0u,vec2<u32>(0u));
 let inv=inverseDirection(rd);var stack:array<u32,32>;var top=1u;stack[0]=params.shape.z;
 loop{
  if(top==0u){break;}top--;let node=nodes[stack[top]];hit.steps++;
  if(boxNearScalar(node,ro,inv,near,hit.distance)>=1e30){continue;}
  if((node.right&0x80000000u)!=0u){
   let count=node.right&0x7fffffffu;
   for(var j=0u;j<count;j++){hit=traceBlasScalar(instanceOrder[node.left+j],ro,rd,near,hit);}
  }else{
   let leftNear=boxNearScalar(nodes[node.left],ro,inv,near,hit.distance);let rightNear=boxNearScalar(nodes[node.right],ro,inv,near,hit.distance);
   if(leftNear<1e30&&rightNear<1e30){
    if(top+2u>32u){hit.spare.x=2u;return hit;}
    stack[top]=select(node.left,node.right,leftNear<rightNear);stack[top+1u]=select(node.right,node.left,leftNear<rightNear);top+=2u;
   }else if(leftNear<1e30){stack[top]=node.left;top++;}else if(rightNear<1e30){stack[top]=node.right;top++;}
  }
 }
 return hit;
}
fn debugColor(hit: Hit) -> vec3<f32> {
 if(hit.instance==0xffffffffu){return vec3<f32>(0.66,0.80,0.87);}
 let seed=f32((hit.instance*1664525u+1013904223u)&255u)/255.0;
 let value=1.0/(1.0+hit.distance/800.0);return vec3<f32>(0.14+seed*0.17,0.28+value*0.46,0.12+seed*0.12);
}

@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3<u32>){
 if(id.x>=params.shape.x||id.y>=params.shape.y){return;}
 let offsets=array<vec2<f32>,4>(vec2<f32>(0.375,0.125),vec2<f32>(0.875,0.375),vec2<f32>(0.125,0.625),vec2<f32>(0.625,0.875));
 let forward=normalize(params.base.xyz+params.dx.xyz*f32(params.shape.x)*0.5+params.dy.xyz*f32(params.shape.y)*0.5);
 if(params.shape.w==1u){
  let direction=normalize(params.base.xyz+params.dx.xyz*(f32(id.x)+0.5)+params.dy.xyz*(f32(id.y)+0.5));
  let cosine=dot(direction,forward);let hit=traceWorldScalar(params.origin.xyz,direction,params.clip.x/cosine,params.clip.y/cosine);
  hits[id.y*params.shape.x+id.x]=hit;textureStore(outputImage,vec2<i32>(id.xy),vec4<f32>(debugColor(hit),1.0));return;
 }
 if(params.shape.w!=4u){return;}
 var ray:Rays;ray.origin=params.origin.xyz;
 for(var lane=0u;lane<4u;lane++){
  let direction=normalize(params.base.xyz+params.dx.xyz*(f32(id.x)+offsets[lane].x)+params.dy.xyz*(f32(id.y)+offsets[lane].y));
  let cosine=dot(direction,forward);let inv=inverseDirection(direction);
  ray.x[lane]=direction.x;ray.y[lane]=direction.y;ray.z[lane]=direction.z;
  ray.invX[lane]=inv.x;ray.invY[lane]=inv.y;ray.invZ[lane]=inv.z;
  ray.near[lane]=params.clip.x/cosine;ray.far[lane]=params.clip.y/cosine;
 }
 let packet=traceWorldPacket(ray);var color=vec3<f32>(0.0);
 for(var lane=0u;lane<4u;lane++){
  var hit=Hit(packet.instance[lane],packet.triangle[lane],packet.distance[lane],packet.u[lane],packet.v[lane],packet.steps[lane],vec2<u32>(0u));
  if(packet.overflow!=0u){
   hit=traceWorldScalar(ray.origin,vec3<f32>(ray.x[lane],ray.y[lane],ray.z[lane]),ray.near[lane],ray.far[lane]);
   hit.spare.y=1u;
  }
  hits[(id.y*params.shape.x+id.x)*4u+lane]=hit;color+=debugColor(hit);
 }
 textureStore(outputImage,vec2<i32>(id.xy),vec4<f32>(color*0.25,1.0));
}
