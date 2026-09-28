// Lossless selection of original triangles for a later native raster pass.
// Dispatch clear -> UAV barrier -> collect -> UAV barrier -> prefix ->
// UAV barrier -> scatter -> UAV barrier/copy. The original hit buffer is
// immutable before collect; table entries only publish an existing hit index.
// Overflow is an explicit failed frame, never permission to omit triangles.
struct Hit {
    uint instance;
    uint triangleId;
    float distance;
    float u;
    float v;
    uint steps;
    uint spare0;
    uint spare1;
};
cbuffer Shape : register(b0) {
    uint hitCount;
    uint tableCapacity; // Power of two, and at least twice expected unique count.
    uint uniqueCapacity;
    uint materialCount; // At most 1024.
    uint triangleBlockSize; // Original consecutive triangles per candidate, >=1.
    uint3 padding;
};
StructuredBuffer<Hit> hits : register(t0);
StructuredBuffer<uint4> instanceMetadata : register(t1);
RWStructuredBuffer<uint> table : register(u0);
RWStructuredBuffer<uint> counters : register(u1); // 1024=total;1025=overflow.
RWStructuredBuffer<uint2> uniquePairs : register(u2);
RWStructuredBuffer<uint> materialOffsets : register(u3); // materialCount + 1.
RWStructuredBuffer<uint2> groupedPairs : register(u4);

uint hashPair(uint2 value) {
    uint x = value.x * 0x9e3779b9u ^ value.y * 0x85ebca6bu;
    x ^= x >> 16; x *= 0x7feb352du;
    x ^= x >> 15; x *= 0x846ca68bu;
    return x ^ (x >> 16);
}
[numthreads(256,1,1)]
void clear(uint3 id : SV_DispatchThreadID) {
    if (id.x < tableCapacity) table[id.x] = 0;
    if (id.x < 1026) counters[id.x] = 0;
}
[numthreads(256,1,1)]
void collect(uint3 id : SV_DispatchThreadID) {
    if (id.x >= hitCount) return;
    Hit hit = hits[id.x];
    if (hit.instance == 0xffffffffu) return;
    if (hit.spare0 != 0) { InterlockedAdd(counters[1025],1); return; }
    uint4 metadata = instanceMetadata[hit.instance];
    uint first = metadata.y + ((hit.triangleId-metadata.y)/triangleBlockSize)*triangleBlockSize;
    uint2 pair = uint2(hit.instance,first);
    // One contender for equal IDs in a wave, without quantizing the key.
    uint4 same = WaveMatch(pair);
    uint leader = same.x ? firstbitlow(same.x) :
                  same.y ? 32 + firstbitlow(same.y) :
                  same.z ? 64 + firstbitlow(same.z) : 96 + firstbitlow(same.w);
    if (WaveGetLaneIndex() != leader) return;
    uint slot = hashPair(pair) & (tableCapacity - 1);
    for (uint probe = 0; probe < tableCapacity; probe++) {
        uint previous;
        InterlockedCompareExchange(table[slot],0,id.x+1,previous);
        if (previous == 0) {
            uint material = metadata.x;
            if (material >= materialCount || material >= 1024) {
                InterlockedAdd(counters[1025],1); return;
            }
            uint destination;
            InterlockedAdd(counters[1024],1,destination);
            if (destination >= uniqueCapacity) {
                InterlockedAdd(counters[1025],1); return;
            }
            uniquePairs[destination] = pair;
            InterlockedAdd(counters[material],1);
            return;
        }
        Hit prior = hits[previous-1];
        if (prior.instance == pair.x) {
            uint priorFirst = metadata.y + ((prior.triangleId-metadata.y)/triangleBlockSize)*triangleBlockSize;
            if (priorFirst == pair.y) return;
        }
        slot = (slot + 1) & (tableCapacity - 1);
    }
    InterlockedAdd(counters[1025],1);
}
[numthreads(1,1,1)]
void prefix(uint3 id : SV_DispatchThreadID) {
    uint offset = 0;
    for (uint material = 0; material < materialCount; material++) {
        materialOffsets[material] = offset;
        offset += counters[material];
        counters[material] = 0;
    }
    materialOffsets[materialCount] = offset;
}
[numthreads(256,1,1)]
void scatter(uint3 id : SV_DispatchThreadID) {
    if (counters[1025] != 0 || id.x >= counters[1024]) return;
    uint2 pair = uniquePairs[id.x];
    uint material = instanceMetadata[pair.x].x;
    uint index;
    InterlockedAdd(counters[material],1,index);
    groupedPairs[materialOffsets[material]+index] = pair;
}
