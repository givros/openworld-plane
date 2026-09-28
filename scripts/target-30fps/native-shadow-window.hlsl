// Full-source static shadow depths. One ray at the original non-MSAA shadow
// pixel centre. Geometric coverage is a prototype until compared with raster.
RaytracingAccelerationStructure world : register(t0);
RWStructuredBuffer<uint> cacheDepthWords : register(u0);
RWStructuredBuffer<uint> resolvedDepthWords : register(u1);
RWStructuredBuffer<uint> counters : register(u2);
cbuffer ShadowWindow : register(b0) {
    float4 axisX;          // xyz fixed light-right, w exact world texel width
    float4 axisY;          // xyz fixed light-up,    w exact world texel height
    float4 forward;        // xyz fixed sun-forward,w global start axis depth
    float4 depthInterval;  // global end, current light near axis, current far axis
    int4 worldRectangle;   // x,y,width,height in integer world light pixels
    uint4 destination;     // x,y,mapSize,cascade in physical toroidal storage
    int4 currentWindow;    // current x,y (remaining words reserved)
};
uint positiveModulo(int value, uint modulus) { int remainder = value % int(modulus); return uint(remainder < 0 ? remainder + int(modulus) : remainder); }
uint cacheIndex(uint2 physical) { return (destination.w * destination.z + physical.y) * destination.z + physical.x; }
float3 rayOrigin(int2 pixel) {
    precise float x = (float(pixel.x) + .5) * axisX.w;
    precise float y = (float(pixel.y) + .5) * axisY.w;
    precise float3 origin = axisX.xyz * x + axisY.xyz * y + forward.xyz * forward.w;
    return origin;
}
float traceDepth(int2 pixel, float nearAxis, float farAxis) {
    RayDesc ray; ray.Origin = rayOrigin(pixel); ray.Direction = forward.xyz;
    ray.TMin = max(0, nearAxis - forward.w); ray.TMax = max(ray.TMin, farAxis - forward.w);
    RayQuery<RAY_FLAG_FORCE_OPAQUE | RAY_FLAG_SKIP_PROCEDURAL_PRIMITIVES> query;
    query.TraceRayInline(world, RAY_FLAG_NONE, 255, ray);
    while(query.Proceed()) {}
    return query.CommittedStatus() == COMMITTED_TRIANGLE_HIT ? forward.w + query.CommittedRayT() : asfloat(0x7f800000);
}
[numthreads(8,8,1)]
void updateWindow(uint3 id : SV_DispatchThreadID) {
    if(id.x >= uint(worldRectangle.z) || id.y >= uint(worldRectangle.w)) return;
    int2 pixel = worldRectangle.xy + int2(id.xy);
    float value = traceDepth(pixel, forward.w, depthInterval.x);
    cacheDepthWords[cacheIndex(destination.xy + id.xy)] = asuint(value);
}
[numthreads(8,8,1)]
void resolveWindow(uint3 id : SV_DispatchThreadID) {
    if(id.x >= destination.z || id.y >= destination.z) return;
    int2 pixel = currentWindow.xy + int2(id.xy);
    uint2 physical = uint2(positiveModulo(pixel.x, destination.z), positiveModulo(pixel.y, destination.z));
    float depth = asfloat(cacheDepthWords[cacheIndex(physical)]);
    // A cached upstream hit before the moving near plane cannot simply become
    // clear: another surface may lie behind it. Only this exceptional case is
    // retraced within the current native clipping interval.
    bool fallback = depth < depthInterval.y;
    if(fallback) {
        depth = traceDepth(pixel, depthInterval.y, depthInterval.z);
    }
    float normalized = 1;
    if(isfinite(depth) && depth <= depthInterval.z) {
        normalized = saturate((depth - depthInterval.y) / (depthInterval.z - depthInterval.y));
    }
    resolvedDepthWords[(destination.w * destination.z + id.y) * destination.z + id.x] = asuint(normalized);
    if(currentWindow.z != 0) {
        uint fallbackCount = WaveActiveCountBits(fallback);
        uint fallbackHits = WaveActiveCountBits(fallback && isfinite(depth));
        uint finiteCount = WaveActiveCountBits(isfinite(depth) && depth <= depthInterval.z);
        if(WaveIsFirstLane()) {
            InterlockedAdd(counters[destination.w * 4], fallbackCount);
            InterlockedAdd(counters[destination.w * 4 + 1], fallbackHits);
            InterlockedAdd(counters[destination.w * 4 + 2], finiteCount);
        }
    }
}
