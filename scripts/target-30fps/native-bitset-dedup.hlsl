// Exact frame visibility bits: one bit per original placed triangle.
// No attributes, positions or source triangles are altered or compressed.
struct Hit { uint instance; uint triangleId; float distance; float u; float v; uint steps; uint2 spare; };
cbuffer Shape : register(b0) { uint hitCount; uint wordCount; uint dirtyCapacity; uint materialCount; };
StructuredBuffer<Hit> hits : register(t0);
// material ID, global triangle base, geometry triangle count, placed word offset
StructuredBuffer<uint4> metadata : register(t1);
RWStructuredBuffer<uint> bits : register(u0);
RWStructuredBuffer<uint2> dirtyWords : register(u1);
// Materials[0..1023], total pairs[1024], overflow[1025], dirty count[1026]
RWStructuredBuffer<uint> counters : register(u2);
RWStructuredBuffer<uint> offsets : register(u3);
RWStructuredBuffer<uint2> pairs : register(u4);
[numthreads(256,1,1)]
void initialize(uint3 id : SV_DispatchThreadID) {
    uint index=id.x+id.y*65535u*256u;
    if(index<wordCount)bits[index]=0;
}
[numthreads(256,1,1)]
void clearDirty(uint3 id : SV_DispatchThreadID) {
    if(id.x>=counters[1026])return;
    uint2 dirty=dirtyWords[id.x];bits[metadata[dirty.x].w+dirty.y]=0;
}
[numthreads(256,1,1)]
void clearCounters(uint3 id : SV_DispatchThreadID) {
    if(id.x<1027)counters[id.x]=0;
}
[numthreads(256,1,1)]
void collect(uint3 id : SV_DispatchThreadID) {
    if(id.x>=hitCount)return;
    Hit hit=hits[id.x];if(hit.instance==0xffffffffu)return;
    uint4 source=metadata[hit.instance];uint local=hit.triangleId-source.y;
    if(local>=source.z||source.x>=materialCount||hit.spare.x!=0){InterlockedAdd(counters[1025],1);return;}
    uint word=local>>5;uint prior;InterlockedOr(bits[source.w+word],1u<<(local&31),prior);
    bool first=prior==0;
    uint active=WaveActiveCountBits(first);uint start=0;
    if(WaveIsFirstLane()&&active)InterlockedAdd(counters[1026],active,start);
    start=WaveReadLaneFirst(start);
    if(first){uint destination=start+WavePrefixCountBits(first);if(destination>=dirtyCapacity){InterlockedAdd(counters[1025],1);return;}dirtyWords[destination]=uint2(hit.instance,word);}
}
[numthreads(256,1,1)]
void count(uint3 id : SV_DispatchThreadID) {
    if(id.x>=counters[1026])return;
    uint2 dirty=dirtyWords[id.x];uint4 source=metadata[dirty.x];uint amount=countbits(bits[source.w+dirty.y]);
    InterlockedAdd(counters[source.x],amount);
}
[numthreads(1,1,1)]
void prefix(uint3 id : SV_DispatchThreadID) {
    uint total=0;for(uint material=0;material<materialCount;++material){offsets[material]=total;total+=counters[material];counters[material]=0;}
    offsets[materialCount]=total;counters[1024]=total;
}
[numthreads(256,1,1)]
void scatter(uint3 id : SV_DispatchThreadID) {
    if(counters[1025]!=0||id.x>=counters[1026])return;
    uint2 dirty=dirtyWords[id.x];uint4 source=metadata[dirty.x];uint word=bits[source.w+dirty.y];uint amount=countbits(word);uint start;
    InterlockedAdd(counters[source.x],amount,start);start+=offsets[source.x];
    while(word){uint bit=firstbitlow(word);pairs[start++]=uint2(dirty.x,source.y+dirty.y*32+bit);word&=word-1;}
}
