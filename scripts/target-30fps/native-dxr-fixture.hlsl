struct Hit {
    uint hit;
    uint instance;
    uint primitive;
    float distance;
    float2 barycentric;
    uint padding0;
    uint padding1;
};
RaytracingAccelerationStructure world : register(t0);
RWStructuredBuffer<Hit> results : register(u0);

[numthreads(4, 1, 1)]
void main(uint3 dispatchId : SV_DispatchThreadID) {
    uint index = dispatchId.x;
    RayDesc ray;
    ray.Origin = float3(index == 1 ? 2.0 : (index == 3 ? 0.2 : 0.0), 0.0, index == 2 ? 1.0 : -1.0);
    ray.Direction = float3(0.0, 0.0, index == 2 ? -1.0 : 1.0);
    ray.TMin = 0.001;
    ray.TMax = 10.0;
    RayQuery<RAY_FLAG_FORCE_OPAQUE | RAY_FLAG_SKIP_PROCEDURAL_PRIMITIVES> query;
    query.TraceRayInline(world, RAY_FLAG_NONE, 0xff, ray);
    while (query.Proceed()) {}
    Hit hit = (Hit)0;
    hit.hit = query.CommittedStatus() == COMMITTED_TRIANGLE_HIT;
    if (hit.hit) {
        hit.instance = query.CommittedInstanceID();
        hit.primitive = query.CommittedPrimitiveIndex();
        hit.distance = query.CommittedRayT();
        hit.barycentric = query.CommittedTriangleBarycentrics();
    }
    results[index] = hit;
}
