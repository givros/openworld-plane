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

fn position(index: u32) -> vec3<f32> { let p=index*3u;return vec3<f32>(positions[p],positions[p+1u],positions[p+2u]); }
fn inverseDirection(d: vec3<f32>) -> vec3<f32> { return select(vec3<f32>(1e30),1.0/d,abs(d)>vec3<f32>(1e-30)); }
fn boxNear(node: Node, ro: vec3<f32>, inv: vec3<f32>, near: f32, far: f32) -> f32 {
 let a=(node.lo-ro)*inv;let b=(node.hi-ro)*inv;
 let low=min(a,b);let high=max(a,b);
 let entry=max(near,max(low.x,max(low.y,low.z)));let leave=min(far,min(high.x,min(high.y,high.z)));
 return select(1e30,entry,entry<=leave);
}
fn traceBlas(instanceId: u32, worldOrigin: vec3<f32>, worldDirection: vec3<f32>, near: f32, previous: Hit) -> Hit {
 let instance=instances[instanceId];let p=vec4<f32>(worldOrigin,1.0);let d=vec4<f32>(worldDirection,0.0);
 let ro=vec3<f32>(dot(instance.row0,p),dot(instance.row1,p),dot(instance.row2,p));
 let rd=vec3<f32>(dot(instance.row0,d),dot(instance.row1,d),dot(instance.row2,d));let inv=inverseDirection(rd);
 var hit=previous;var stack:array<u32,64>;var top=1u;stack[0]=instance.data.x;
 loop {
  if(top==0u){break;}top--;let node=nodes[stack[top]];hit.steps++;
  if(boxNear(node,ro,inv,near,hit.distance)>=1e30){continue;}
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
   let leftNear=boxNear(nodes[node.left],ro,inv,near,hit.distance);let rightNear=boxNear(nodes[node.right],ro,inv,near,hit.distance);
   if(leftNear<1e30&&rightNear<1e30){
    if(top+2u>64u){hit.spare.x=1u;return hit;}
    stack[top]=select(node.left,node.right,leftNear<rightNear);stack[top+1u]=select(node.right,node.left,leftNear<rightNear);top+=2u;
   }else if(leftNear<1e30){stack[top]=node.left;top++;}else if(rightNear<1e30){stack[top]=node.right;top++;}
  }
 }
 return hit;
}
fn traceWorld(ro: vec3<f32>, rd: vec3<f32>, near: f32, far: f32) -> Hit {
 var hit=Hit(0xffffffffu,0xffffffffu,far,0.0,0.0,0u,vec2<u32>(0u));
 let inv=inverseDirection(rd);var stack:array<u32,64>;var top=1u;stack[0]=params.shape.z;
 loop{
  if(top==0u){break;}top--;let node=nodes[stack[top]];hit.steps++;
  if(boxNear(node,ro,inv,near,hit.distance)>=1e30){continue;}
  if((node.right&0x80000000u)!=0u){
   let count=node.right&0x7fffffffu;
   for(var j=0u;j<count;j++){hit=traceBlas(instanceOrder[node.left+j],ro,rd,near,hit);}
  }else{
   let leftNear=boxNear(nodes[node.left],ro,inv,near,hit.distance);let rightNear=boxNear(nodes[node.right],ro,inv,near,hit.distance);
   if(leftNear<1e30&&rightNear<1e30){
    if(top+2u>64u){hit.spare.x=2u;return hit;}
    stack[top]=select(node.left,node.right,leftNear<rightNear);stack[top+1u]=select(node.right,node.left,leftNear<rightNear);top+=2u;
   }else if(leftNear<1e30){stack[top]=node.left;top++;}else if(rightNear<1e30){stack[top]=node.right;top++;}
  }
 }
 return hit;
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3<u32>){
 if(id.x>=params.shape.x||id.y>=params.shape.y){return;}
 let offsets=array<vec2<f32>,4>(vec2<f32>(0.375,0.125),vec2<f32>(0.875,0.375),vec2<f32>(0.125,0.625),vec2<f32>(0.625,0.875));
 let forward=normalize(params.base.xyz+params.dx.xyz*f32(params.shape.x)*0.5+params.dy.xyz*f32(params.shape.y)*0.5);
 let sample=id.z;
 let offset=select(offsets[sample],vec2<f32>(0.5),params.shape.w==1u);
 let direction=normalize(params.base.xyz+params.dx.xyz*(f32(id.x)+offset.x)+params.dy.xyz*(f32(id.y)+offset.y));
 let cosine=dot(direction,forward);let hit=traceWorld(params.origin.xyz,direction,params.clip.x/cosine,params.clip.y/cosine);
 hits[(id.y*params.shape.x+id.x)*params.shape.w+sample]=hit;
 if(sample==0u){textureStore(outputImage,vec2<i32>(id.xy),vec4<f32>(hit.distance/2000.0,0.0,0.0,1.0));}
}
