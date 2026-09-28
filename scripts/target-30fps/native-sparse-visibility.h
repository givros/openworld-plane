#pragma once
#include "native-world-runtime.h"

namespace native_world {
// Persistent, lossless GPU partition of original triangle IDs by native draw state.
// Read back only 625+1 offsets and two status words; triangle references stay on GPU.
class NativeSparseVisibility {
public:
    Runtime& r;
    uint32_t hitCapacity=0,groupCount=0,tableCapacity=0,instanceCount=0;
    ComPtr<ID3D12Resource> instanceMetadata,table,counters,unique,offsets,grouped,constants,offsetReadback,statusReadback;
    ComPtr<ID3D12RootSignature> root;
    std::array<ComPtr<ID3D12PipelineState>,4> pipelines;
    std::vector<uint32_t> completedOffsets;
    uint32_t completedCount=0;
    static constexpr uint32_t sharedTextureWidth=4096;

    NativeSparseVisibility(Runtime& runtime,const std::filesystem::path& metadataPath,const std::filesystem::path& shaderDirectory,uint32_t maximumHits):r(runtime),hitCapacity(maximumHits) {
        if(!maximumHits||maximumHits>=8388608u)throw std::runtime_error("Visibility capacity exceeds this prototype's one-axis clear dispatch");
        tableCapacity=1;while(tableCapacity<=maximumHits)tableCapacity*=2;
        auto metadata=readBinary<uint32_t>(metadataPath);
        if(metadata.size()%4)throw std::runtime_error("Native draw metadata ABI mismatch");
        instanceCount=uint32_t(metadata.size()/4);
        for(uint32_t i=0;i<instanceCount;++i)groupCount=(std::max)(groupCount,metadata[i*4]+1);
        if(!groupCount||groupCount>1024)throw std::runtime_error("Draw signature count exceeds shader capacity");
        const uint64_t metadataBytes=uint64_t(metadata.size())*4;
        instanceMetadata=buffer(r.device.Get(),metadataBytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_COPY_DEST);
        auto staging=buffer(r.device.Get(),metadataBytes,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);
        upload(staging.Get(),metadata.data(),metadataBytes);r.commands->CopyResource(instanceMetadata.Get(),staging.Get());
        transition(r.commands.Get(),instanceMetadata.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);r.flush();
        auto uav=[&](uint64_t bytes){return buffer(r.device.Get(),bytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);};
        table=uav(uint64_t(tableCapacity)*4);counters=uav(1026*4);unique=uav(uint64_t(hitCapacity)*8);offsets=uav(uint64_t(groupCount+1)*4);
        // Whole texture rows permit direct buffer->RGBA8 resource copies with
        // all 32 original ID bits intact; no conversion shader or CPU list.
        grouped=uav(aligned(uint64_t(hitCapacity)*8,uint64_t(sharedTextureWidth)*4));
        constants=buffer(r.device.Get(),256,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);
        offsetReadback=buffer(r.device.Get(),uint64_t(groupCount+1)*4,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);
        statusReadback=buffer(r.device.Get(),8,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);
        completedOffsets.resize(groupCount+1);
        std::array<D3D12_ROOT_PARAMETER,8> parameters{};
        for(uint32_t i=0;i<8;++i){auto& p=parameters[i];p.ShaderVisibility=D3D12_SHADER_VISIBILITY_ALL;p.ParameterType=i<2?D3D12_ROOT_PARAMETER_TYPE_SRV:i<7?D3D12_ROOT_PARAMETER_TYPE_UAV:D3D12_ROOT_PARAMETER_TYPE_CBV;p.Descriptor.ShaderRegister=i<2?i:i<7?i-2:0;}
        D3D12_ROOT_SIGNATURE_DESC description{};description.NumParameters=8;description.pParameters=parameters.data();ComPtr<ID3DBlob> serialized,error;
        check(D3D12SerializeRootSignature(&description,D3D_ROOT_SIGNATURE_VERSION_1,&serialized,&error),"Serialize native sparse root");
        check(r.device->CreateRootSignature(0,serialized->GetBufferPointer(),serialized->GetBufferSize(),IID_PPV_ARGS(&root)),"Create native sparse root");
        const wchar_t* shaders[]{L"clear.dxil",L"collect.dxil",L"prefix.dxil",L"scatter.dxil"};
        for(uint32_t i=0;i<4;++i){auto code=readBinary<char>(shaderDirectory/shaders[i]);D3D12_COMPUTE_PIPELINE_STATE_DESC pso{};pso.pRootSignature=root.Get();pso.CS={code.data(),code.size()};check(r.device->CreateComputePipelineState(&pso,IID_PPV_ARGS(&pipelines[i])),"Create native sparse pipeline");}
    }
    void dispatch(ID3D12Resource* hits,uint32_t hitCount,uint32_t triangleBlockSize=1) {
        if(!hits||!hitCount||hitCount>hitCapacity||!triangleBlockSize)throw std::runtime_error("Invalid visibility dispatch");
        const std::array<uint32_t,8> values{hitCount,tableCapacity,hitCapacity,groupCount,triangleBlockSize,0,0,0};upload(constants.Get(),values.data(),32);
        transition(r.commands.Get(),hits,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        r.commands->SetComputeRootSignature(root.Get());r.commands->SetComputeRootShaderResourceView(0,hits->GetGPUVirtualAddress());r.commands->SetComputeRootShaderResourceView(1,instanceMetadata->GetGPUVirtualAddress());
        r.commands->SetComputeRootUnorderedAccessView(2,table->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(3,counters->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(4,unique->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(5,offsets->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(6,grouped->GetGPUVirtualAddress());r.commands->SetComputeRootConstantBufferView(7,constants->GetGPUVirtualAddress());
        r.commands->SetPipelineState(pipelines[0].Get());r.commands->Dispatch((tableCapacity+255)/256,1,1);uavBarrier(r.commands.Get(),nullptr);
        r.commands->SetPipelineState(pipelines[1].Get());r.commands->Dispatch((hitCount+255)/256,1,1);uavBarrier(r.commands.Get(),nullptr);
        r.commands->SetPipelineState(pipelines[2].Get());r.commands->Dispatch(1,1,1);uavBarrier(r.commands.Get(),nullptr);
        r.commands->SetPipelineState(pipelines[3].Get());r.commands->Dispatch((hitCount+255)/256,1,1);uavBarrier(r.commands.Get(),nullptr);
        transition(r.commands.Get(),hits,D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
    }
    void enqueueStatusReadback() {
        transition(r.commands.Get(),offsets.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);
        transition(r.commands.Get(),counters.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);
        r.commands->CopyResource(offsetReadback.Get(),offsets.Get());r.commands->CopyBufferRegion(statusReadback.Get(),0,counters.Get(),1024*4,8);
        transition(r.commands.Get(),offsets.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        transition(r.commands.Get(),counters.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
    }
    // The owner must first complete the command list with a GPU fence.
    void readCompletedStatus() {
        uint32_t* status=nullptr;D3D12_RANGE statusRange{0,8},empty{0,0};check(statusReadback->Map(0,&statusRange,reinterpret_cast<void**>(&status)),"Map sparse status");
        const uint32_t count=status[0],overflow=status[1];statusReadback->Unmap(0,&empty);
        if(overflow||count>hitCapacity)throw std::runtime_error("Native triangle selection overflow; frame rejected");
        uint32_t* data=nullptr;D3D12_RANGE range{0,size_t(groupCount+1)*4};check(offsetReadback->Map(0,&range,reinterpret_cast<void**>(&data)),"Map draw offsets");
        std::copy(data,data+groupCount+1,completedOffsets.begin());offsetReadback->Unmap(0,&empty);
        if(completedOffsets.front()!=0||completedOffsets.back()!=count||!std::is_sorted(completedOffsets.begin(),completedOffsets.end()))throw std::runtime_error("Native draw partition invalid");
        completedCount=count;
    }
    void copyCompletedPairsToRGBA8(ID3D12Resource* target,D3D12_RESOURCE_STATES before,D3D12_RESOURCE_STATES after) {
        const auto description=target->GetDesc();const uint32_t rows=uint32_t((uint64_t(completedCount)*2+sharedTextureWidth-1)/sharedTextureWidth);
        if(description.Format!=DXGI_FORMAT_R8G8B8A8_UNORM||description.Width!=sharedTextureWidth||description.Height<rows||description.SampleDesc.Count!=1)throw std::runtime_error("Shared candidate texture ABI mismatch");
        if(!rows)return;
        transition(r.commands.Get(),grouped.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);
        if(before!=D3D12_RESOURCE_STATE_COPY_DEST)transition(r.commands.Get(),target,before,D3D12_RESOURCE_STATE_COPY_DEST);
        D3D12_TEXTURE_COPY_LOCATION source{},destination{};source.pResource=grouped.Get();source.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        source.PlacedFootprint.Footprint={DXGI_FORMAT_R8G8B8A8_UNORM,sharedTextureWidth,rows,1,sharedTextureWidth*4};
        destination.pResource=target;destination.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;destination.SubresourceIndex=0;
        r.commands->CopyTextureRegion(&destination,0,0,0,&source,nullptr);
        transition(r.commands.Get(),grouped.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        if(after!=D3D12_RESOURCE_STATE_COPY_DEST)transition(r.commands.Get(),target,D3D12_RESOURCE_STATE_COPY_DEST,after);
    }
};
} // namespace native_world
