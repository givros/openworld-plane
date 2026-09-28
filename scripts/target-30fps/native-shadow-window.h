#pragma once
// Isolated full-density four-cascade cache. This header does not alter the game.
#include "native-world-runtime.h"
#include <cstring>
#include <limits>

namespace native_shadow {
using namespace native_world;
struct ShadowParameters {
    float axisX[4], axisY[4], forward[4], depthInterval[4];
    int32_t rectangle[4];
    uint32_t destination[4];
    int32_t window[4];
};
static_assert(sizeof(ShadowParameters) == 112);
struct Rectangle { int64_t x, y, width, height; };
struct LayerPlan {
    uint32_t cascade = 0;
    uint64_t expectedRevision = 0;
    std::string identity;
    ShadowParameters view{};
    std::vector<ShadowParameters> updates;
};
struct LayerState {
    bool valid = false;
    uint64_t revision = 0;
    std::string identity;
    ShadowParameters view{};
};
struct ShadowUpdateTiming { double gpuMs = 0; uint64_t tracedTexels = 0, reusedTexels = 0, revision = 0; };
static int32_t positiveModulo(int32_t value, uint32_t modulus) { int32_t result = value % int32_t(modulus); return result < 0 ? result + int32_t(modulus) : result; }
static uint64_t intersectionArea(const Rectangle& a, const Rectangle& b) {
    return uint64_t((std::max)(int64_t(0), (std::min)(a.x+a.width,b.x+b.width)-(std::max)(a.x,b.x))) *
        uint64_t((std::max)(int64_t(0), (std::min)(a.y+a.height,b.y+b.height)-(std::max)(a.y,b.y)));
}
static std::vector<Rectangle> exposedRectangles(const Rectangle& next, const Rectangle& old) {
    const auto left=(std::max)(next.x,old.x), right=(std::min)(next.x+next.width,old.x+old.width);
    const auto bottom=(std::max)(next.y,old.y), top=(std::min)(next.y+next.height,old.y+old.height);
    if(left>=right || bottom>=top)return {next};
    std::vector<Rectangle> result;
    if(next.x<old.x)result.push_back({next.x,next.y,old.x-next.x,next.height});
    else if(next.x>old.x)result.push_back({old.x+old.width,next.y,next.x-old.x,next.height});
    if(next.y<old.y)result.push_back({left,next.y,right-left,old.y-next.y});
    else if(next.y>old.y)result.push_back({left,old.y+old.height,right-left,next.y-old.y});
    return result;
}

/**
 * Synchronous prototype: every public update returns only after its GPU fence.
 * Resources remain GPU-local; optional readback is for diagnostics only.
 * A failed update invalidates that layer; partial texels are never committed.
 */
class NativeShadowWindowCache {
    Runtime& runtime;
    ComPtr<ID3D12Resource> acceleration, parameterBuffer, zeroCounters;
    ComPtr<ID3D12RootSignature> root;
    ComPtr<ID3D12PipelineState> updatePipeline, resolvePipeline;
    std::array<LayerState,4> states;
    std::array<uint64_t,4> resolvedRevisions{UINT64_MAX,UINT64_MAX,UINT64_MAX,UINT64_MAX};
    uint32_t mapSize;
    uint64_t layerBytes;

    void bind(ComPtr<ID3D12PipelineState>& pipeline, uint64_t parameterOffset) {
        auto* commands=runtime.commands.Get(); commands->SetPipelineState(pipeline.Get()); commands->SetComputeRootSignature(root.Get());
        commands->SetComputeRootShaderResourceView(0,acceleration->GetGPUVirtualAddress());
        commands->SetComputeRootUnorderedAccessView(1,cacheDepthWords->GetGPUVirtualAddress());
        commands->SetComputeRootUnorderedAccessView(2,resolvedDepthWords->GetGPUVirtualAddress());
        commands->SetComputeRootUnorderedAccessView(3,counters->GetGPUVirtualAddress());
        commands->SetComputeRootConstantBufferView(4,parameterBuffer->GetGPUVirtualAddress()+parameterOffset);
    }
    void validateView(const ShadowParameters& p, uint32_t cascade) const {
        if(cascade>=4 || p.destination[3]!=cascade || p.destination[2]!=mapSize)throw std::runtime_error("Wrong cascade or map density");
        float words[16];memcpy(words,&p,sizeof(words));for(uint32_t i=0;i<16;++i)if(!std::isfinite(words[i]))throw std::runtime_error("Non-finite shadow parameters");
        if(p.axisX[3]<=0 || p.axisY[3]<=0 || p.depthInterval[0]<=p.forward[3] || p.depthInterval[2]<=p.depthInterval[1])throw std::runtime_error("Invalid shadow projection interval");
        const float* basis[3]{p.axisX,p.axisY,p.forward};
        for(int a=0;a<3;a++)for(int b=a;b<3;b++){double dot=0;for(int k=0;k<3;k++)dot+=double(basis[a][k])*basis[b][k];if(std::abs(dot-(a==b?1.:0.))>1e-6)throw std::runtime_error("Non-orthonormal shadow basis");}
    }
    bool sameCacheProjection(const ShadowParameters& a,const ShadowParameters& b) const {
        // Near/far and the moving window are deliberately not dependencies of
        // world-axis depth. The fixed ray interval and all XY samples are.
        return memcmp(a.axisX,b.axisX,12*sizeof(float))==0 && a.depthInterval[0]==b.depthInterval[0];
    }
public:
    ComPtr<ID3D12Resource> cacheDepthWords,resolvedDepthWords,counters;
    NativeShadowWindowCache(Runtime& r,ID3D12Resource* tlas,const std::filesystem::path& updateShader,const std::filesystem::path& resolveShader,uint32_t size=4096)
        :runtime(r),acceleration(tlas),mapSize(size),layerBytes(uint64_t(size)*size*4) {
        if(size!=4096 || !tlas)throw std::runtime_error("This prototype preserves all four 4096 shadow maps");
        const auto memory=r.memory();if(memory.CurrentUsage+layerBytes*8+128ull*1024*1024>memory.Budget)throw std::runtime_error("Shadow cache exceeds current local memory budget");
        cacheDepthWords=buffer(r.device.Get(),layerBytes*4,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        resolvedDepthWords=buffer(r.device.Get(),layerBytes*4,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        counters=buffer(r.device.Get(),64,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        parameterBuffer=buffer(r.device.Get(),256*8,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);
        zeroCounters=buffer(r.device.Get(),64,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);const uint32_t zeros[16]{};upload(zeroCounters.Get(),zeros,sizeof(zeros));
        D3D12_ROOT_PARAMETER parameters[5]{};for(auto& p:parameters)p.ShaderVisibility=D3D12_SHADER_VISIBILITY_ALL;
        parameters[0].ParameterType=D3D12_ROOT_PARAMETER_TYPE_SRV;parameters[0].Descriptor.ShaderRegister=0;
        for(uint32_t i=1;i<=3;i++){parameters[i].ParameterType=D3D12_ROOT_PARAMETER_TYPE_UAV;parameters[i].Descriptor.ShaderRegister=i-1;}
        parameters[4].ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;parameters[4].Descriptor.ShaderRegister=0;
        D3D12_ROOT_SIGNATURE_DESC desc{};desc.NumParameters=5;desc.pParameters=parameters;ComPtr<ID3DBlob> serialized,error;
        check(D3D12SerializeRootSignature(&desc,D3D_ROOT_SIGNATURE_VERSION_1,&serialized,&error),"Serialize shadow root");
        check(r.device->CreateRootSignature(0,serialized->GetBufferPointer(),serialized->GetBufferSize(),IID_PPV_ARGS(&root)),"Create shadow root");
        auto pipeline=[&](const std::filesystem::path& path,ComPtr<ID3D12PipelineState>& target){auto code=readBinary<char>(path);D3D12_COMPUTE_PIPELINE_STATE_DESC p{};p.pRootSignature=root.Get();p.CS={code.data(),code.size()};check(r.device->CreateComputePipelineState(&p,IID_PPV_ARGS(&target)),"Create shadow pipeline");};
        pipeline(updateShader,updatePipeline);pipeline(resolveShader,resolvePipeline);
    }
    const LayerState& state(uint32_t cascade) const {if(cascade>=4)throw std::runtime_error("Unknown cascade");return states[cascade];}
    void invalidate(uint32_t cascade) {if(cascade>=4)throw std::runtime_error("Unknown cascade");states[cascade].valid=false;++states[cascade].revision;resolvedRevisions[cascade]=UINT64_MAX;}
    ShadowUpdateTiming applyPlan(const LayerPlan& plan) {
        validateView(plan.view,plan.cascade);auto& state=states[plan.cascade];
        if(plan.identity.empty() || plan.expectedRevision!=state.revision)throw std::runtime_error("Stale or unidentified shadow update plan");
        const bool compatible=state.valid && state.identity==plan.identity && sameCacheProjection(state.view,plan.view);
        Rectangle next{plan.view.window[0],plan.view.window[1],mapSize,mapSize},old{state.view.window[0],state.view.window[1],mapSize,mapSize};
        const auto expected=compatible?exposedRectangles(next,old):std::vector<Rectangle>{next};
        if(plan.updates.size()>8)throw std::runtime_error("Plan exceeds torus-split rectangle bound");
        uint64_t expectedArea=0,actualArea=0;for(const auto& rect:expected)expectedArea+=rect.width*rect.height;
        std::vector<Rectangle> actual;
        for(const auto& update:plan.updates){
            validateView(update,plan.cascade);
            if(memcmp(update.axisX,plan.view.axisX,16*sizeof(float))!=0 || update.window[0]!=plan.view.window[0] || update.window[1]!=plan.view.window[1])throw std::runtime_error("Plan update projection differs from its view");
            const auto* rect=update.rectangle;const auto* dest=update.destination;
            if(rect[2]<=0 || rect[3]<=0 || dest[0]!=positiveModulo(rect[0],mapSize) || dest[1]!=positiveModulo(rect[1],mapSize) || uint64_t(dest[0])+rect[2]>mapSize || uint64_t(dest[1])+rect[3]>mapSize)throw std::runtime_error("Invalid torus-split update rectangle");
            Rectangle area{rect[0],rect[1],rect[2],rect[3]};uint64_t inside=0;for(const auto& required:expected)inside+=intersectionArea(area,required);
            if(inside!=uint64_t(area.width*area.height))throw std::runtime_error("Update writes outside newly required pixels");
            for(const auto& previous:actual)if(intersectionArea(previous,area))throw std::runtime_error("Overlapping shadow update rectangles");
            actual.push_back(area);actualArea+=inside;
        }
        if(actualArea!=expectedArea)throw std::runtime_error("Incomplete shadow update coverage");
        resolvedRevisions[plan.cascade]=UINT64_MAX;
        ShadowUpdateTiming result;result.tracedTexels=actualArea;result.reusedTexels=uint64_t(mapSize)*mapSize-actualArea;
        if(!plan.updates.empty()) {
            std::array<uint8_t,256*8> parameters{};for(size_t i=0;i<plan.updates.size();i++)memcpy(parameters.data()+i*256,&plan.updates[i],sizeof(ShadowParameters));upload(parameterBuffer.Get(),parameters.data(),parameters.size());
            state.valid=false;
            result.gpuMs=runtime.timed([&](){for(size_t i=0;i<plan.updates.size();i++){bind(updatePipeline,i*256);const auto& rect=plan.updates[i].rectangle;runtime.commands->Dispatch((rect[2]+7)/8,(rect[3]+7)/8,1);}uavBarrier(runtime.commands.Get(),cacheDepthWords.Get());});
        }
        state.valid=true;state.identity=plan.identity;state.view=plan.view;++state.revision;result.revision=state.revision;return result;
    }
    /** Current near/far conversion is separate from invariant static depths. */
    double resolve(uint32_t cascade,const ShadowParameters& supplied,bool diagnostics=false) {
        validateView(supplied,cascade);const auto& s=states[cascade];
        if(!s.valid || !sameCacheProjection(s.view,supplied) || s.view.window[0]!=supplied.window[0] || s.view.window[1]!=supplied.window[1])throw std::runtime_error("Cannot resolve an incomplete or different shadow window");
        auto parameters=supplied;parameters.window[2]=diagnostics?1:0;upload(parameterBuffer.Get(),&parameters,sizeof(parameters));
        resolvedRevisions[cascade]=UINT64_MAX;
        const double time=runtime.timed([&](){
            transition(runtime.commands.Get(),counters.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_DEST);
            runtime.commands->CopyBufferRegion(counters.Get(),0,zeroCounters.Get(),0,64);
            transition(runtime.commands.Get(),counters.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
            bind(resolvePipeline,0);runtime.commands->Dispatch((mapSize+7)/8,(mapSize+7)/8,1);uavBarrier(runtime.commands.Get(),resolvedDepthWords.Get());uavBarrier(runtime.commands.Get(),counters.Get());
        });
        resolvedRevisions[cascade]=s.revision;return time;
    }
    /** Copies raw float bytes into RGBA8; no channel math, shader or CPU copy. */
    double copyLayerToRGBA8(uint32_t cascade,ID3D12Resource* destination,bool resolved=true) {
        if(cascade>=4 || !states[cascade].valid || (resolved && resolvedRevisions[cascade]!=states[cascade].revision))throw std::runtime_error("Uncommitted shadow export");const auto d=destination->GetDesc();
        if(d.Dimension!=D3D12_RESOURCE_DIMENSION_TEXTURE2D || d.Width!=mapSize || d.Height!=mapSize || d.Format!=DXGI_FORMAT_R8G8B8A8_UNORM || d.SampleDesc.Count!=1 || d.DepthOrArraySize!=1)throw std::runtime_error("Expected exact single-sample RGBA8 transport texture");
        auto* source=resolved?resolvedDepthWords.Get():cacheDepthWords.Get();
        return runtime.timed([&](){transition(runtime.commands.Get(),source,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);transition(runtime.commands.Get(),destination,D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST);
            D3D12_TEXTURE_COPY_LOCATION from{};from.pResource=source;from.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;from.PlacedFootprint.Offset=layerBytes*cascade;from.PlacedFootprint.Footprint={DXGI_FORMAT_R8G8B8A8_UNORM,mapSize,mapSize,1,mapSize*4};
            D3D12_TEXTURE_COPY_LOCATION to{};to.pResource=destination;to.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;runtime.commands->CopyTextureRegion(&to,0,0,0,&from,nullptr);
            transition(runtime.commands.Get(),destination,D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_COMMON);transition(runtime.commands.Get(),source,D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        });
    }
    std::vector<uint32_t> readLayer(uint32_t cascade,bool resolved=true) {
        if(cascade>=4 || !states[cascade].valid || (resolved && resolvedRevisions[cascade]!=states[cascade].revision))throw std::runtime_error("Uncommitted shadow readback");auto* source=resolved?resolvedDepthWords.Get():cacheDepthWords.Get();
        auto readback=buffer(runtime.device.Get(),layerBytes,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);
        transition(runtime.commands.Get(),source,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);runtime.commands->CopyBufferRegion(readback.Get(),0,source,layerBytes*cascade,layerBytes);transition(runtime.commands.Get(),source,D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);runtime.flush();
        void* mapped{};D3D12_RANGE range{0,size_t(layerBytes)};check(readback->Map(0,&range,&mapped),"Map shadow readback");std::vector<uint32_t> words(layerBytes/4);memcpy(words.data(),mapped,layerBytes);D3D12_RANGE empty{0,0};readback->Unmap(0,&empty);return words;
    }
    std::array<uint32_t,16> readCounters() {
        auto readback=buffer(runtime.device.Get(),64,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);transition(runtime.commands.Get(),counters.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);runtime.commands->CopyResource(readback.Get(),counters.Get());transition(runtime.commands.Get(),counters.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);runtime.flush();
        void* mapped{};D3D12_RANGE range{0,64};check(readback->Map(0,&range,&mapped),"Map shadow counters");std::array<uint32_t,16> result{};memcpy(result.data(),mapped,64);D3D12_RANGE empty{0,0};readback->Unmap(0,&empty);return result;
    }
};
}
