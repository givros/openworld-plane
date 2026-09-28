struct Hit { uint instance; uint triangleGlobal; float distance; float u; float v; uint steps; uint2 spare; };
RaytracingAccelerationStructure world : register(t0);
StructuredBuffer<uint> triangleBase : register(t1);
RWStructuredBuffer<Hit> hits : register(u0);
cbuffer Camera : register(b0) { float4 origin; float4 base; float4 dx; float4 dy; uint4 shape; float4 clip; };
[numthreads(8,8,1)]
void main(uint3 id : SV_DispatchThreadID) {
    if(id.x>=shape.x || id.y>=shape.y || id.z>=shape.w)return;
    const float2 offsets[4]={float2(.375,.875),float2(.875,.625),float2(.125,.375),float2(.625,.125)};
    float2 offset=shape.w==1?float2(.5,.5):offsets[id.z];
    float3 forward=normalize(base.xyz+dx.xyz*float(shape.x)*.5+dy.xyz*float(shape.y)*.5);
    float3 direction=normalize(base.xyz+dx.xyz*(float(id.x)+offset.x)+dy.xyz*(float(id.y)+offset.y));
    float cosine=dot(direction,forward);
    RayDesc ray;ray.Origin=origin.xyz;ray.Direction=direction;ray.TMin=clip.x/cosine;ray.TMax=clip.y/cosine;
    RayQuery<RAY_FLAG_FORCE_OPAQUE|RAY_FLAG_SKIP_PROCEDURAL_PRIMITIVES> query;
    query.TraceRayInline(world,RAY_FLAG_NONE,255,ray);
    while(query.Proceed()){}
    Hit hit=(Hit)0;hit.instance=0xffffffff;hit.triangleGlobal=0xffffffff;hit.distance=ray.TMax;
    if(query.CommittedStatus()==COMMITTED_TRIANGLE_HIT){
        hit.instance=query.CommittedInstanceID();
        hit.triangleGlobal=triangleBase[hit.instance]+query.CommittedPrimitiveIndex();
        hit.distance=query.CommittedRayT();
        float2 bary=query.CommittedTriangleBarycentrics();hit.u=bary.x;hit.v=bary.y;
    }
    hits[(id.y*shape.x+id.x)*shape.w+id.z]=hit;
}
