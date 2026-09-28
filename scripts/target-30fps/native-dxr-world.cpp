// Isolated native benchmark. Reuse the tiny fixture's resource helpers; its
// renamed entry point is never called and creates no second device or window.
#define wmain unusedTinyFixtureEntry
#include "native-dxr-fixture.cpp"
#undef wmain
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <functional>
#include <numeric>

using Clock = std::chrono::steady_clock;
static double elapsed(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now()-start).count(); }
static uint64_t aligned(uint64_t n, uint64_t a=256) { return (n+a-1)/a*a; }
template<class T> static std::vector<T> readBinary(const std::filesystem::path& path) {
    std::ifstream file(path,std::ios::binary|std::ios::ate);
    if(!file)throw std::runtime_error("Cannot open "+path.string());
    const size_t bytes=size_t(file.tellg());
    if(bytes%sizeof(T))throw std::runtime_error("Invalid binary element size");
    std::vector<T> result(bytes/sizeof(T));file.seekg(0);file.read(reinterpret_cast<char*>(result.data()),bytes);
    if(!file)throw std::runtime_error("Incomplete binary read");return result;
}
struct Geometry { uint32_t id, vertexOffset, vertices, triangleOffset, triangles, root; };
struct WorldHit { uint32_t instance,triangle;float distance,u,v;uint32_t steps,spare[2]; };
static_assert(sizeof(Geometry)==24 && sizeof(WorldHit)==32);

struct Runtime {
    ComPtr<IDXGIAdapter3> adapter;DXGI_ADAPTER_DESC1 desc{};
    ComPtr<ID3D12Device5> device;ComPtr<ID3D12CommandQueue> queue;
    ComPtr<ID3D12CommandAllocator> allocator;ComPtr<ID3D12GraphicsCommandList4> commands;
    ComPtr<ID3D12Fence> fence;uint64_t fenceValue=0,frequency=0;
    ComPtr<ID3D12QueryHeap> queries;ComPtr<ID3D12Resource> queryReadback;
    D3D12_FEATURE_DATA_D3D12_OPTIONS5 capabilities{};
    Runtime(){
        ComPtr<IDXGIFactory6> factory;check(CreateDXGIFactory2(0,IID_PPV_ARGS(&factory)),"DXGI factory");
        for(UINT i=0;;++i){ComPtr<IDXGIAdapter1> candidate;HRESULT hr=factory->EnumAdapterByGpuPreference(i,DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,IID_PPV_ARGS(&candidate));if(hr==DXGI_ERROR_NOT_FOUND)break;check(hr,"Enumerate adapter");DXGI_ADAPTER_DESC1 d{};candidate->GetDesc1(&d);if(!(d.Flags&DXGI_ADAPTER_FLAG_SOFTWARE)&&std::wstring(d.Description).find(L"RTX 3080")!=std::wstring::npos){check(candidate.As(&adapter),"Adapter3");desc=d;break;}}
        if(!adapter)throw std::runtime_error("Physical RTX 3080 not found");
        check(D3D12CreateDevice(adapter.Get(),D3D_FEATURE_LEVEL_12_0,IID_PPV_ARGS(&device)),"Create D3D12 device");
        check(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS5,&capabilities,sizeof(capabilities)),"DXR capabilities");
        if(capabilities.RaytracingTier<D3D12_RAYTRACING_TIER_1_1)throw std::runtime_error("DXR1.1 required");
        D3D12_COMMAND_QUEUE_DESC q{};q.Type=D3D12_COMMAND_LIST_TYPE_DIRECT;
        check(device->CreateCommandQueue(&q,IID_PPV_ARGS(&queue)),"Create queue");
        check(device->CreateCommandAllocator(q.Type,IID_PPV_ARGS(&allocator)),"Create allocator");
        check(device->CreateCommandList(0,q.Type,allocator.Get(),nullptr,IID_PPV_ARGS(&commands)),"Create list");
        check(device->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&fence)),"Create fence");
        check(queue->GetTimestampFrequency(&frequency),"Timestamp frequency");
        D3D12_QUERY_HEAP_DESC query{};query.Type=D3D12_QUERY_HEAP_TYPE_TIMESTAMP;query.Count=2;
        check(device->CreateQueryHeap(&query,IID_PPV_ARGS(&queries)),"Create query heap");
        queryReadback=buffer(device.Get(),16,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);
    }
    void flush(){
        check(commands->Close(),"Close list");ID3D12CommandList* lists[]{commands.Get()};queue->ExecuteCommandLists(1,lists);
        check(queue->Signal(fence.Get(),++fenceValue),"Signal");HANDLE event=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!event)throw std::runtime_error("Fence event");
        check(fence->SetEventOnCompletion(fenceValue,event),"Fence completion");DWORD status=WaitForSingleObject(event,30000);CloseHandle(event);
        if(status!=WAIT_OBJECT_0)throw std::runtime_error("GPU work exceeded 30-second fence bound");
        check(device->GetDeviceRemovedReason(),"Device status");check(allocator->Reset(),"Reset allocator");check(commands->Reset(allocator.Get(),nullptr),"Reset list");
    }
    double timed(const std::function<void()>& work){
        commands->EndQuery(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,0);work();commands->EndQuery(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,1);
        commands->ResolveQueryData(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,0,2,queryReadback.Get(),0);flush();
        uint64_t* data{};D3D12_RANGE range{0,16};check(queryReadback->Map(0,&range,reinterpret_cast<void**>(&data)),"Read timestamps");double ms=double(data[1]-data[0])*1000/frequency;D3D12_RANGE empty{0,0};queryReadback->Unmap(0,&empty);return ms;
    }
    DXGI_QUERY_VIDEO_MEMORY_INFO memory(){DXGI_QUERY_VIDEO_MEMORY_INFO result{};check(adapter->QueryVideoMemoryInfo(0,DXGI_MEMORY_SEGMENT_GROUP_LOCAL,&result),"Video memory budget");return result;}
};
static void transition(ID3D12GraphicsCommandList* commands,ID3D12Resource* resource,D3D12_RESOURCE_STATES before,D3D12_RESOURCE_STATES after){D3D12_RESOURCE_BARRIER b{};b.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;b.Transition={resource,D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,before,after};commands->ResourceBarrier(1,&b);}
#include "native-dxr-dedup.h"

int wmain(int argc,wchar_t** argv){
    try{
        if(argc==5 && std::wstring(argv[1])==L"--dedup")return runDedup(argv[2],argv[3],argv[4]);
        if(argc!=4)throw std::runtime_error("Arguments: visibility-world-directory native-metadata-directory shader.dxil");
        const auto began=Clock::now();const std::filesystem::path source=argv[1],destination=argv[2];
        auto metadata=readBinary<uint32_t>(destination/L"geometry.bin");
        const uint32_t geometryCount=metadata[0],instanceCount=metadata[1],vertexCount=metadata[2],triangleCount=metadata[3];
        if(metadata.size()!=4+size_t(geometryCount)*6)throw std::runtime_error("Geometry metadata size mismatch");
        std::vector<Geometry> geometries(geometryCount);memcpy(geometries.data(),metadata.data()+4,geometryCount*sizeof(Geometry));
        auto instanceGeometry=readBinary<uint32_t>(destination/L"instance-geometry.bin");
        auto matrices=readBinary<float>(source/L"instances-forward.bin");auto camera=readBinary<uint32_t>(destination/L"camera.bin");
        if(instanceGeometry.size()!=instanceCount||matrices.size()!=size_t(instanceCount)*16||camera.size()!=24)throw std::runtime_error("Instance/camera metadata mismatch");
        const uint32_t width=camera[16],height=camera[17],samples=camera[19];const uint64_t hitCount=uint64_t(width)*height*samples,hitBytes=hitCount*sizeof(WorldHit);
        Runtime r;auto initialMemory=r.memory();
        std::cout<<"ADAPTER "<<utf8(r.desc.Description)<<" budget="<<initialMemory.Budget<<" initialUsage="<<initialMemory.CurrentUsage<<std::endl;
        auto positions=buffer(r.device.Get(),uint64_t(vertexCount)*12,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_COPY_DEST);
        auto indices=buffer(r.device.Get(),uint64_t(triangleCount)*12,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_COPY_DEST);
        constexpr uint64_t stagingBytes=64ull*1024*1024;
        auto staging=buffer(r.device.Get(),stagingBytes,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);
        void* stagingData{};D3D12_RANGE noRead{0,0};check(staging->Map(0,&noRead,&stagingData),"Map staging");
        const auto uploadStart=Clock::now();
        auto copyFile=[&](const std::filesystem::path& path,ID3D12Resource* target,uint64_t bytes,bool rebase){
            std::ifstream file(path,std::ios::binary);if(!file)throw std::runtime_error("Missing source buffer");uint32_t g=0;
            for(uint64_t offset=0;offset<bytes;offset+=stagingBytes){uint64_t count=(std::min)(stagingBytes,bytes-offset);file.read(reinterpret_cast<char*>(stagingData),count);if(!file)throw std::runtime_error("Source buffer read failed");
                if(rebase){auto words=static_cast<uint32_t*>(stagingData);for(uint64_t i=0;i<count/4;++i){const uint64_t globalIndex=offset/4+i;while(g+1<geometryCount&&globalIndex>=uint64_t(geometries[g+1].triangleOffset)*3)++g;uint32_t original=words[i];if(original<geometries[g].vertexOffset||original>=geometries[g].vertexOffset+geometries[g].vertices)throw std::runtime_error("Triangle vertex outside source geometry");words[i]=original-geometries[g].vertexOffset;}}
                r.commands->CopyBufferRegion(target,offset,staging.Get(),0,count);r.flush();
            }transition(r.commands.Get(),target,D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);r.flush();
        };
        copyFile(source/L"positions.bin",positions.Get(),uint64_t(vertexCount)*12,false);
        copyFile(source/L"triangles.bin",indices.Get(),uint64_t(triangleCount)*12,true);
        staging->Unmap(0,nullptr);staging.Reset();const double uploadMs=elapsed(uploadStart);
        std::cout<<"UPLOAD_COMPLETE ms="<<uploadMs<<std::endl;
        std::vector<D3D12_RAYTRACING_GEOMETRY_DESC> descriptors(geometryCount);
        std::vector<D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_INPUTS> inputs(geometryCount);
        std::vector<uint64_t> blasOffsets(geometryCount);uint64_t blasBytes=0,scratchBytes=0;
        for(uint32_t i=0;i<geometryCount;++i){const auto& g=geometries[i];auto& d=descriptors[i];d.Type=D3D12_RAYTRACING_GEOMETRY_TYPE_TRIANGLES;d.Flags=D3D12_RAYTRACING_GEOMETRY_FLAG_OPAQUE;d.Triangles.VertexBuffer={positions->GetGPUVirtualAddress()+uint64_t(g.vertexOffset)*12,12};d.Triangles.VertexCount=g.vertices;d.Triangles.VertexFormat=DXGI_FORMAT_R32G32B32_FLOAT;d.Triangles.IndexBuffer=indices->GetGPUVirtualAddress()+uint64_t(g.triangleOffset)*12;d.Triangles.IndexCount=g.triangles*3;d.Triangles.IndexFormat=DXGI_FORMAT_R32_UINT;
            auto& in=inputs[i];in.Type=D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL;in.Flags=D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PREFER_FAST_TRACE;in.NumDescs=1;in.DescsLayout=D3D12_ELEMENTS_LAYOUT_ARRAY;in.pGeometryDescs=&d;
            D3D12_RAYTRACING_ACCELERATION_STRUCTURE_PREBUILD_INFO info{};r.device->GetRaytracingAccelerationStructurePrebuildInfo(&in,&info);blasOffsets[i]=blasBytes;blasBytes+=aligned(info.ResultDataMaxSizeInBytes);scratchBytes=(std::max)(scratchBytes,info.ScratchDataSizeInBytes);}
        D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_INPUTS tlasInput{};tlasInput.Type=D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL;tlasInput.Flags=D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PREFER_FAST_TRACE;tlasInput.NumDescs=instanceCount;tlasInput.DescsLayout=D3D12_ELEMENTS_LAYOUT_ARRAY;
        D3D12_RAYTRACING_ACCELERATION_STRUCTURE_PREBUILD_INFO tlasInfo{};r.device->GetRaytracingAccelerationStructurePrebuildInfo(&tlasInput,&tlasInfo);scratchBytes=(std::max)(scratchBytes,tlasInfo.ScratchDataSizeInBytes);
        const uint64_t estimatedPeakLocal=uint64_t(vertexCount+triangleCount)*12+blasBytes+scratchBytes+tlasInfo.ResultDataMaxSizeInBytes+hitBytes+uint64_t(instanceCount)*68;
        if(estimatedPeakLocal+512ull*1024*1024>initialMemory.Budget)throw std::runtime_error("Projected native AS/input/hit allocation exceeds safe local-memory budget");
        std::cout<<"AS_PREFLIGHT blas="<<blasBytes<<" scratch="<<scratchBytes<<" tlas="<<tlasInfo.ResultDataMaxSizeInBytes<<" estimatedPeak="<<estimatedPeakLocal<<std::endl;
        auto blas=buffer(r.device.Get(),blasBytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        auto scratch=buffer(r.device.Get(),scratchBytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        double blasGpuMs=0;const auto buildStart=Clock::now();
        for(uint32_t start=0;start<geometryCount;start+=64){blasGpuMs+=r.timed([&](){for(uint32_t i=start;i<(std::min)(start+64,geometryCount);++i){D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC build{};build.Inputs=inputs[i];build.DestAccelerationStructureData=blas->GetGPUVirtualAddress()+blasOffsets[i];build.ScratchAccelerationStructureData=scratch->GetGPUVirtualAddress();r.commands->BuildRaytracingAccelerationStructure(&build,0,nullptr);uavBarrier(r.commands.Get(),scratch.Get());}uavBarrier(r.commands.Get(),blas.Get());});if(start%512==0)std::cout<<"BLAS "<<(std::min)(start+64,geometryCount)<<"/"<<geometryCount<<std::endl;}
        std::vector<D3D12_RAYTRACING_INSTANCE_DESC> nativeInstances(instanceCount);std::vector<uint32_t> triangleBases(instanceCount);
        for(uint32_t i=0;i<instanceCount;++i){const auto geometry=instanceGeometry[i];if(geometry>=geometryCount)throw std::runtime_error("Invalid instance geometry ID");auto& d=nativeInstances[i];for(uint32_t row=0;row<3;++row)for(uint32_t col=0;col<4;++col)d.Transform[row][col]=matrices[size_t(i)*16+col*4+row];d.InstanceID=i;d.InstanceMask=255;d.Flags=D3D12_RAYTRACING_INSTANCE_FLAG_TRIANGLE_CULL_DISABLE;d.AccelerationStructure=blas->GetGPUVirtualAddress()+blasOffsets[geometry];triangleBases[i]=geometries[geometry].triangleOffset;}
        auto nativeInstanceBuffer=buffer(r.device.Get(),uint64_t(instanceCount)*64,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);upload(nativeInstanceBuffer.Get(),nativeInstances.data(),nativeInstances.size()*64);
        tlasInput.InstanceDescs=nativeInstanceBuffer->GetGPUVirtualAddress();auto tlas=buffer(r.device.Get(),tlasInfo.ResultDataMaxSizeInBytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        const double tlasGpuMs=r.timed([&](){D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC build{};build.Inputs=tlasInput;build.DestAccelerationStructureData=tlas->GetGPUVirtualAddress();build.ScratchAccelerationStructureData=scratch->GetGPUVirtualAddress();r.commands->BuildRaytracingAccelerationStructure(&build,0,nullptr);uavBarrier(r.commands.Get(),tlas.Get());});
        const double buildWallMs=elapsed(buildStart);scratch.Reset();nativeInstanceBuffer.Reset();positions.Reset();indices.Reset();
        nativeInstances.clear();nativeInstances.shrink_to_fit();matrices.clear();matrices.shrink_to_fit();
        auto bases=buffer(r.device.Get(),uint64_t(instanceCount)*4,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);upload(bases.Get(),triangleBases.data(),triangleBases.size()*4);
        auto cameraBuffer=buffer(r.device.Get(),256,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);upload(cameraBuffer.Get(),camera.data(),96);
        auto hits=buffer(r.device.Get(),hitBytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        auto hitsReadback=buffer(r.device.Get(),hitBytes,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);
        std::array<D3D12_ROOT_PARAMETER,4> parameters{};for(auto& p:parameters)p.ShaderVisibility=D3D12_SHADER_VISIBILITY_ALL;
        parameters[0].ParameterType=D3D12_ROOT_PARAMETER_TYPE_SRV;parameters[0].Descriptor.ShaderRegister=0;
        parameters[1].ParameterType=D3D12_ROOT_PARAMETER_TYPE_SRV;parameters[1].Descriptor.ShaderRegister=1;
        parameters[2].ParameterType=D3D12_ROOT_PARAMETER_TYPE_UAV;parameters[2].Descriptor.ShaderRegister=0;
        parameters[3].ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;parameters[3].Descriptor.ShaderRegister=0;
        D3D12_ROOT_SIGNATURE_DESC rootDesc{};rootDesc.NumParameters=4;rootDesc.pParameters=parameters.data();ComPtr<ID3DBlob> serialized,error;check(D3D12SerializeRootSignature(&rootDesc,D3D_ROOT_SIGNATURE_VERSION_1,&serialized,&error),"Serialize root");ComPtr<ID3D12RootSignature> root;check(r.device->CreateRootSignature(0,serialized->GetBufferPointer(),serialized->GetBufferSize(),IID_PPV_ARGS(&root)),"Create root");
        auto shader=readBinary<char>(argv[3]);D3D12_COMPUTE_PIPELINE_STATE_DESC pso{};pso.pRootSignature=root.Get();pso.CS={shader.data(),shader.size()};ComPtr<ID3D12PipelineState> pipeline;check(r.device->CreateComputePipelineState(&pso,IID_PPV_ARGS(&pipeline)),"Create ray-query pipeline");
        const double setupWallMs=elapsed(began);auto activeMemory=r.memory();std::vector<double> gpuTimes,wallTimes,warmupGpu;
        for(uint32_t frame=0;frame<8;++frame){auto start=Clock::now();const double gpu=r.timed([&](){r.commands->SetPipelineState(pipeline.Get());r.commands->SetComputeRootSignature(root.Get());r.commands->SetComputeRootShaderResourceView(0,tlas->GetGPUVirtualAddress());r.commands->SetComputeRootShaderResourceView(1,bases->GetGPUVirtualAddress());r.commands->SetComputeRootUnorderedAccessView(2,hits->GetGPUVirtualAddress());r.commands->SetComputeRootConstantBufferView(3,cameraBuffer->GetGPUVirtualAddress());r.commands->Dispatch((width+7)/8,(height+7)/8,samples);uavBarrier(r.commands.Get(),hits.Get());});const double wall=elapsed(start);if(frame<3)warmupGpu.push_back(gpu);else{gpuTimes.push_back(gpu);wallTimes.push_back(wall);}std::cout<<"FRAME "<<frame<<" GPUms="<<gpu<<" completedMs="<<wall<<std::endl;}
        auto readStart=Clock::now();const double readbackGpuMs=r.timed([&](){transition(r.commands.Get(),hits.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);r.commands->CopyResource(hitsReadback.Get(),hits.Get());});WorldHit* mapped{};D3D12_RANGE readRange{0,SIZE_T(hitBytes)};check(hitsReadback->Map(0,&readRange,reinterpret_cast<void**>(&mapped)),"Map world hits");const double readbackWallMs=elapsed(readStart);
        uint64_t found=0,invalid=0;for(uint64_t i=0;i<hitCount;++i){const auto& h=mapped[i];if(h.instance!=0xffffffff){++found;if(h.instance>=instanceCount||h.triangle>=triangleCount||!std::isfinite(h.distance)||!std::isfinite(h.u)||!std::isfinite(h.v))++invalid;}}
        auto fileStart=Clock::now();std::ofstream hitFile(destination/L"hits.bin",std::ios::binary);hitFile.write(reinterpret_cast<const char*>(mapped),hitBytes);hitFile.close();const double fileWriteMs=elapsed(fileStart);
        std::ofstream report(destination/L"report.json");report<<std::setprecision(12)<<"{\n\"scope\":\"Native DXR full-source primary visibility only; no shading, shadows, browser bridge or FPS claim\",\n\"adapter\":\""<<escaped(utf8(r.desc.Description))<<"\",\n\"dxrTierRaw\":"<<r.capabilities.RaytracingTier<<",\n\"width\":"<<width<<",\"height\":"<<height<<",\"samples\":"<<samples<<",\n\"geometries\":"<<geometryCount<<",\"placements\":"<<instanceCount<<",\"uniqueTriangles\":"<<triangleCount<<",\n\"sourceGeometryReduced\":false,\"sourcePositionPrecisionReduced\":false,\n\"initialBudgetBytes\":"<<initialMemory.Budget<<",\"initialLocalUsageBytes\":"<<initialMemory.CurrentUsage<<",\"activeLocalUsageBytes\":"<<activeMemory.CurrentUsage<<",\"estimatedPeakLocalAllocationBytes\":"<<estimatedPeakLocal<<",\n\"blasBytes\":"<<blasBytes<<",\"tlasBytes\":"<<tlasInfo.ResultDataMaxSizeInBytes<<",\"scratchBytes\":"<<scratchBytes<<",\"hitBufferBytes\":"<<hitBytes<<",\n\"uploadWallMs\":"<<uploadMs<<",\"blasBuildGpuMs\":"<<blasGpuMs<<",\"tlasBuildGpuMs\":"<<tlasGpuMs<<",\"accelerationBuildWallMs\":"<<buildWallMs<<",\"setupWallMs\":"<<setupWallMs<<",\n\"timings\":[";
        for(size_t i=0;i<gpuTimes.size();++i)report<<(i?",":"")<<"{\"gpuMs\":"<<gpuTimes[i]<<",\"completedMs\":"<<wallTimes[i]<<"}";
        report<<"],\n\"warmupGpuMs\":[";for(size_t i=0;i<warmupGpu.size();++i)report<<(i?",":"")<<warmupGpu[i];
        report<<"],\n\"fullHitReadbackGpuMs\":"<<readbackGpuMs<<",\"fullHitReadbackWallMs\":"<<readbackWallMs<<",\"hitFileWriteWallMs\":"<<fileWriteMs<<",\n\"found\":"<<found<<",\"totalSamples\":"<<hitCount<<",\"invalidHits\":"<<invalid<<",\n\"validationHits\":[\n";
        bool comma=false;for(uint32_t y=0;y<12;++y)for(uint32_t x=0;x<16;++x)for(uint32_t sample=0;sample<samples;++sample){uint32_t px=uint32_t((x+.5)*width/16),py=uint32_t((y+.5)*height/12);const auto& h=mapped[(uint64_t(py)*width+px)*samples+sample];if(comma)report<<",\n";comma=true;report<<"{\"x\":"<<px<<",\"y\":"<<py<<",\"sample\":"<<sample<<",\"instance\":"<<h.instance<<",\"triangle\":"<<h.triangle<<",\"distance\":"<<h.distance<<",\"u\":"<<h.u<<",\"v\":"<<h.v<<"}";}
        report<<"\n],\n\"errors\":[]\n}\n";D3D12_RANGE noWrite{0,0};hitsReadback->Unmap(0,&noWrite);std::cout<<"COMPLETE invalidHits="<<invalid<<" sourceInstances="<<instanceCount<<std::endl;return invalid?2:0;
    }catch(const std::exception& error){std::cerr<<error.what()<<std::endl;return 1;}
}
