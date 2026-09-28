// Included after Runtime: isolated sparse selection from the immutable native hits.
static int runDedup(const std::filesystem::path& source,const std::filesystem::path& destination,const std::filesystem::path& shaderDirectory){
    Runtime r;
    const auto started=Clock::now();
    auto hitWords=readBinary<uint32_t>(destination/L"hits.bin");
    auto metadata=readBinary<uint32_t>(source/L"native-instance-metadata.bin");
    if(hitWords.size()%8||metadata.size()%4)throw std::runtime_error("Dedup input ABI mismatch");
    const uint32_t hitCount=uint32_t(hitWords.size()/8),instanceCount=uint32_t(metadata.size()/4);
    uint32_t materialCount=0;for(uint32_t i=0;i<instanceCount;++i)materialCount=(std::max)(materialCount,metadata[i*4]+1);
    if(materialCount>1024)throw std::runtime_error("Dedup material count exceeds shader capacity");
    const uint32_t tableCapacity=8u*1024*1024,uniqueCapacity=hitCount;
    if(hitCount>=tableCapacity)throw std::runtime_error("Dedup table must exceed maximum unique candidates");
    auto uploadDefault=[&](const void* data,uint64_t bytes){
        auto result=buffer(r.device.Get(),bytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_COPY_DEST);
        const uint64_t chunkSize=64ull*1024*1024;
        auto staging=buffer(r.device.Get(),(std::min)(chunkSize,bytes),D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);
        for(uint64_t offset=0;offset<bytes;offset+=chunkSize){const auto count=(std::min)(chunkSize,bytes-offset);upload(staging.Get(),static_cast<const char*>(data)+offset,count);r.commands->CopyBufferRegion(result.Get(),offset,staging.Get(),0,count);r.flush();}
        transition(r.commands.Get(),result.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);r.flush();return result;
    };
    auto hits=uploadDefault(hitWords.data(),hitWords.size()*4);
    auto instanceMetadata=uploadDefault(metadata.data(),metadata.size()*4);
    hitWords.clear();hitWords.shrink_to_fit();
    auto uav=[&](uint64_t bytes){return buffer(r.device.Get(),bytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);};
    auto table=uav(uint64_t(tableCapacity)*4),counters=uav(1026*4),unique=uav(uint64_t(uniqueCapacity)*8),offsets=uav(uint64_t(materialCount+1)*4),grouped=uav(uint64_t(uniqueCapacity)*8);
    auto constants=buffer(r.device.Get(),256,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);
    auto counterReadback=buffer(r.device.Get(),1026*4,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);
    auto offsetReadback=buffer(r.device.Get(),uint64_t(materialCount+1)*4,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);
    auto pairsReadback=buffer(r.device.Get(),uint64_t(uniqueCapacity)*8,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);
    std::array<D3D12_ROOT_PARAMETER,8> parameters{};
    for(uint32_t i=0;i<8;++i){auto& p=parameters[i];p.ShaderVisibility=D3D12_SHADER_VISIBILITY_ALL;p.ParameterType=i<2?D3D12_ROOT_PARAMETER_TYPE_SRV:i<7?D3D12_ROOT_PARAMETER_TYPE_UAV:D3D12_ROOT_PARAMETER_TYPE_CBV;p.Descriptor.ShaderRegister=i<2?i:i<7?i-2:0;}
    D3D12_ROOT_SIGNATURE_DESC rootDesc{};rootDesc.NumParameters=8;rootDesc.pParameters=parameters.data();ComPtr<ID3DBlob> serialized,error;check(D3D12SerializeRootSignature(&rootDesc,D3D_ROOT_SIGNATURE_VERSION_1,&serialized,&error),"Serialize dedup root");ComPtr<ID3D12RootSignature> root;check(r.device->CreateRootSignature(0,serialized->GetBufferPointer(),serialized->GetBufferSize(),IID_PPV_ARGS(&root)),"Create dedup root");
    std::array<ComPtr<ID3D12PipelineState>,4> pipelines;
    const wchar_t* shaderNames[]{L"clear.dxil",L"collect.dxil",L"prefix.dxil",L"scatter.dxil"};
    for(uint32_t i=0;i<4;++i){auto code=readBinary<char>(shaderDirectory/shaderNames[i]);D3D12_COMPUTE_PIPELINE_STATE_DESC pso{};pso.pRootSignature=root.Get();pso.CS={code.data(),code.size()};check(r.device->CreateComputePipelineState(&pso,IID_PPV_ARGS(&pipelines[i])),"Create dedup pipeline");}
    const double setupMs=elapsed(started);std::ofstream report(destination/L"dedup-report.json");
    report<<std::setprecision(12)<<"{\n\"scope\":\"Isolated GPU lossless dedup from immutable full-world 4-sample hit buffer; excludes ray tracing and browser transport\",\n\"adapter\":\""<<escaped(utf8(r.desc.Description))<<"\",\n\"hitCount\":"<<hitCount<<",\"instanceCount\":"<<instanceCount<<",\"materialCount\":"<<materialCount<<",\"tableCapacity\":"<<tableCapacity<<",\"uniqueCapacity\":"<<uniqueCapacity<<",\"setupWallMs\":"<<setupMs<<",\n\"blocks\":[\n";
    bool firstBlock=true;
    for(uint32_t block:{1u,8u,32u,64u}){
        const std::array<uint32_t,8> values{hitCount,tableCapacity,uniqueCapacity,materialCount,block,0,0,0};upload(constants.Get(),values.data(),32);
        auto dispatch=[&](){
            r.commands->SetComputeRootSignature(root.Get());r.commands->SetComputeRootShaderResourceView(0,hits->GetGPUVirtualAddress());r.commands->SetComputeRootShaderResourceView(1,instanceMetadata->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(2,table->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(3,counters->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(4,unique->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(5,offsets->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(6,grouped->GetGPUVirtualAddress());r.commands->SetComputeRootConstantBufferView(7,constants->GetGPUVirtualAddress());
            r.commands->SetPipelineState(pipelines[0].Get());r.commands->Dispatch((tableCapacity+255)/256,1,1);uavBarrier(r.commands.Get(),nullptr);
            r.commands->SetPipelineState(pipelines[1].Get());r.commands->Dispatch((hitCount+255)/256,1,1);uavBarrier(r.commands.Get(),nullptr);
            r.commands->SetPipelineState(pipelines[2].Get());r.commands->Dispatch(1,1,1);uavBarrier(r.commands.Get(),nullptr);
            r.commands->SetPipelineState(pipelines[3].Get());r.commands->Dispatch((uniqueCapacity+255)/256,1,1);uavBarrier(r.commands.Get(),nullptr);
        };
        std::vector<double> times;for(uint32_t frame=0;frame<8;++frame){const double gpu=r.timed(dispatch);if(frame>=3)times.push_back(gpu);}
        auto counterStart=Clock::now();const double counterGpu=r.timed([&](){transition(r.commands.Get(),counters.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);r.commands->CopyResource(counterReadback.Get(),counters.Get());transition(r.commands.Get(),counters.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);});
        uint32_t* countData{};D3D12_RANGE countRange{0,1026*4};check(counterReadback->Map(0,&countRange,reinterpret_cast<void**>(&countData)),"Map dedup counters");const uint32_t count=countData[1024],overflow=countData[1025];D3D12_RANGE noWrite{0,0};counterReadback->Unmap(0,&noWrite);const double counterWall=elapsed(counterStart);
        if(overflow||count>uniqueCapacity)throw std::runtime_error("Dedup overflow; no sparse frame accepted");
        const uint64_t bytes=uint64_t(count)*8;const auto copyStart=Clock::now();const double copyGpu=r.timed([&](){transition(r.commands.Get(),grouped.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);transition(r.commands.Get(),offsets.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);r.commands->CopyBufferRegion(pairsReadback.Get(),0,grouped.Get(),0,bytes);r.commands->CopyResource(offsetReadback.Get(),offsets.Get());transition(r.commands.Get(),grouped.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);transition(r.commands.Get(),offsets.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);});
        uint32_t* pairData{};uint32_t* offsetData{};D3D12_RANGE pairRange{0,SIZE_T(bytes)},offsetRange{0,SIZE_T(materialCount+1)*4};check(pairsReadback->Map(0,&pairRange,reinterpret_cast<void**>(&pairData)),"Map sparse pairs");check(offsetReadback->Map(0,&offsetRange,reinterpret_cast<void**>(&offsetData)),"Map sparse offsets");const double copyWall=elapsed(copyStart);
        uint64_t selectedTriangles=0;for(uint32_t i=0;i<count;++i){const auto instance=pairData[i*2],first=pairData[i*2+1];if(instance>=instanceCount)throw std::runtime_error("Sparse instance invalid");const uint32_t begin=metadata[instance*4+1],length=metadata[instance*4+2];if(first<begin||first>=begin+length||(first-begin)%block)throw std::runtime_error("Sparse triangle block invalid");selectedTriangles+=(std::min)(block,begin+length-first);}
        if(offsetData[materialCount]!=count)throw std::runtime_error("Material offsets do not cover all candidates");
        auto fileStart=Clock::now();auto name=L"blocks-"+std::to_wstring(block);std::ofstream pairFile(destination/(name+L"-pairs.bin"),std::ios::binary);pairFile.write(reinterpret_cast<char*>(pairData),bytes);pairFile.close();std::ofstream offsetFile(destination/(name+L"-offsets.bin"),std::ios::binary);offsetFile.write(reinterpret_cast<char*>(offsetData),(materialCount+1)*4);offsetFile.close();const double fileMs=elapsed(fileStart);pairsReadback->Unmap(0,&noWrite);offsetReadback->Unmap(0,&noWrite);
        auto sorted=times;std::sort(sorted.begin(),sorted.end());
        if(!firstBlock)report<<",\n";firstBlock=false;report<<"{\"blockSize\":"<<block<<",\"pairs\":"<<count<<",\"pairBytes\":"<<bytes<<",\"offsetBytes\":"<<(materialCount+1)*4<<",\"selectedOriginalTriangles\":"<<selectedTriangles<<",\"rasterVertices\":"<<selectedTriangles*3<<",\"overflow\":"<<overflow<<",\"gpuMs\":[";for(size_t i=0;i<times.size();++i)report<<(i?",":"")<<times[i];report<<"],\"medianGpuMs\":"<<sorted[2]<<",\"counterReadbackGpuMs\":"<<counterGpu<<",\"counterReadbackWallMs\":"<<counterWall<<",\"sparseReadbackGpuMs\":"<<copyGpu<<",\"sparseReadbackWallMs\":"<<copyWall<<",\"fileWriteWallMs\":"<<fileMs<<"}";report.flush();
        std::cout<<"DEDUP block="<<block<<" pairs="<<count<<" bytes="<<bytes<<" originalTriangles="<<selectedTriangles<<" medianGPUms="<<sorted[2]<<" copyGPUms="<<copyGpu<<std::endl;
    }
    report<<"\n],\n\"errors\":[]\n}\n";return 0;
}
