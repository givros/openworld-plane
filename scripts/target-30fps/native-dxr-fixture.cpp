// Console-only native hardware RT fixture. No window, swap chain or game code.
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
using Microsoft::WRL::ComPtr;

static void check(HRESULT hr, const char* operation) {
    if (FAILED(hr)) {
        char message[160];
        sprintf_s(message, "%s failed: 0x%08lx", operation, (unsigned long)hr);
        throw std::runtime_error(message);
    }
}
static std::string utf8(const wchar_t* value) {
    int bytes = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
    std::string text(bytes, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value, -1, text.data(), bytes, nullptr, nullptr);
    text.pop_back();
    return text;
}
static std::string escaped(const std::string& value) {
    std::string output;
    for (char c : value) { if (c == '\\' || c == '"') output += '\\'; output += c; }
    return output;
}
static ComPtr<ID3D12Resource> buffer(ID3D12Device* device, uint64_t bytes, D3D12_HEAP_TYPE type,
        D3D12_RESOURCE_STATES state, D3D12_RESOURCE_FLAGS flags = D3D12_RESOURCE_FLAG_NONE) {
    D3D12_HEAP_PROPERTIES heap{};
    heap.Type = type;
    D3D12_RESOURCE_DESC desc{};
    desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    desc.Width = bytes;
    desc.Height = 1;
    desc.DepthOrArraySize = 1;
    desc.MipLevels = 1;
    desc.SampleDesc.Count = 1;
    desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    desc.Flags = flags;
    ComPtr<ID3D12Resource> resource;
    check(device->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &desc, state, nullptr,
        IID_PPV_ARGS(&resource)), "CreateCommittedResource");
    return resource;
}
static void upload(ID3D12Resource* target, const void* source, size_t size) {
    void* mapped{};
    D3D12_RANGE noRead{0, 0};
    check(target->Map(0, &noRead, &mapped), "Map upload");
    memcpy(mapped, source, size);
    target->Unmap(0, nullptr);
}
static void uavBarrier(ID3D12GraphicsCommandList* commands, ID3D12Resource* resource) {
    D3D12_RESOURCE_BARRIER barrier{};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
    barrier.UAV.pResource = resource;
    commands->ResourceBarrier(1, &barrier);
}
struct Hit { uint32_t hit, instance, primitive; float distance, u, v; uint32_t padding[2]; };
static_assert(sizeof(Hit) == 32);

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 3) throw std::runtime_error("Arguments: compiled_shader.dxil report.json");
        ComPtr<IDXGIFactory6> factory;
        check(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)), "CreateDXGIFactory2");
        ComPtr<IDXGIAdapter1> adapter;
        DXGI_ADAPTER_DESC1 desc{};
        for (UINT i = 0; ; ++i) {
            ComPtr<IDXGIAdapter1> candidate;
            HRESULT hr = factory->EnumAdapterByGpuPreference(i, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                IID_PPV_ARGS(&candidate));
            if (hr == DXGI_ERROR_NOT_FOUND) break;
            check(hr, "EnumAdapterByGpuPreference");
            DXGI_ADAPTER_DESC1 candidateDesc{};
            check(candidate->GetDesc1(&candidateDesc), "GetDesc1");
            if (!(candidateDesc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) &&
                std::wstring(candidateDesc.Description).find(L"RTX 3080") != std::wstring::npos) {
                adapter = candidate; desc = candidateDesc; break;
            }
        }
        if (!adapter) throw std::runtime_error("Expected physical RTX 3080 adapter was not enumerated");
        ComPtr<ID3D12Device5> device;
        check(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_12_0, IID_PPV_ARGS(&device)), "D3D12CreateDevice5");
        D3D12_FEATURE_DATA_D3D12_OPTIONS5 options5{};
        check(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS5, &options5, sizeof(options5)), "DXR feature query");
        D3D12_FEATURE_DATA_D3D12_OPTIONS7 options7{};
        check(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS7, &options7, sizeof(options7)), "Mesh shader feature query");
        D3D12_FEATURE_DATA_SHADER_MODEL shaderModel{D3D_SHADER_MODEL_6_5};
        check(device->CheckFeatureSupport(D3D12_FEATURE_SHADER_MODEL, &shaderModel, sizeof(shaderModel)), "Shader model feature query");
        if (options5.RaytracingTier < D3D12_RAYTRACING_TIER_1_1) throw std::runtime_error("Inline RT requires DXR tier 1.1");
        // The installed 19041 header stops at 1.1; current drivers can report 1.2.
        const char* dxrTier = unsigned(options5.RaytracingTier) == 12 ? "1.2" : unsigned(options5.RaytracingTier) == 11 ? "1.1" : "unknown newer tier";
        LARGE_INTEGER driverVersion{};
        check(adapter->CheckInterfaceSupport(__uuidof(IDXGIDevice), &driverVersion), "Driver version query");
        D3D12_COMMAND_QUEUE_DESC queueDesc{};
        queueDesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
        ComPtr<ID3D12CommandQueue> queue;
        check(device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&queue)), "CreateCommandQueue");
        ComPtr<ID3D12CommandAllocator> allocator;
        check(device->CreateCommandAllocator(queueDesc.Type, IID_PPV_ARGS(&allocator)), "CreateCommandAllocator");
        ComPtr<ID3D12GraphicsCommandList4> commands;
        check(device->CreateCommandList(0, queueDesc.Type, allocator.Get(), nullptr, IID_PPV_ARGS(&commands)), "CreateCommandList4");
        ComPtr<ID3D12Fence> fence;
        check(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence)), "CreateFence");
        HANDLE fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!fenceEvent) throw std::runtime_error("CreateEvent failed");

        const std::array<float, 9> triangle{-1, -1, 0, 1, -1, 0, 0, 1, 0};
        auto vertices = buffer(device.Get(), sizeof(triangle), D3D12_HEAP_TYPE_UPLOAD, D3D12_RESOURCE_STATE_GENERIC_READ);
        upload(vertices.Get(), triangle.data(), sizeof(triangle));
        D3D12_RAYTRACING_GEOMETRY_DESC geometry{};
        geometry.Type = D3D12_RAYTRACING_GEOMETRY_TYPE_TRIANGLES;
        geometry.Flags = D3D12_RAYTRACING_GEOMETRY_FLAG_OPAQUE;
        geometry.Triangles.VertexBuffer = {vertices->GetGPUVirtualAddress(), 3 * sizeof(float)};
        geometry.Triangles.VertexCount = 3;
        geometry.Triangles.VertexFormat = DXGI_FORMAT_R32G32B32_FLOAT;
        D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_INPUTS blasInput{};
        blasInput.Type = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL;
        blasInput.Flags = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PREFER_FAST_TRACE;
        blasInput.NumDescs = 1;
        blasInput.DescsLayout = D3D12_ELEMENTS_LAYOUT_ARRAY;
        blasInput.pGeometryDescs = &geometry;
        D3D12_RAYTRACING_ACCELERATION_STRUCTURE_PREBUILD_INFO blasInfo{};
        device->GetRaytracingAccelerationStructurePrebuildInfo(&blasInput, &blasInfo);
        auto blas = buffer(device.Get(), blasInfo.ResultDataMaxSizeInBytes, D3D12_HEAP_TYPE_DEFAULT,
            D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        auto blasScratch = buffer(device.Get(), blasInfo.ScratchDataSizeInBytes, D3D12_HEAP_TYPE_DEFAULT,
            D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC blasBuild{};
        blasBuild.Inputs = blasInput;
        blasBuild.DestAccelerationStructureData = blas->GetGPUVirtualAddress();
        blasBuild.ScratchAccelerationStructureData = blasScratch->GetGPUVirtualAddress();
        commands->BuildRaytracingAccelerationStructure(&blasBuild, 0, nullptr);
        uavBarrier(commands.Get(), blas.Get());

        D3D12_RAYTRACING_INSTANCE_DESC instance{};
        instance.Transform[0][0] = instance.Transform[1][1] = instance.Transform[2][2] = 1;
        instance.InstanceID = 7;
        instance.InstanceMask = 255;
        instance.Flags = D3D12_RAYTRACING_INSTANCE_FLAG_TRIANGLE_CULL_DISABLE;
        instance.AccelerationStructure = blas->GetGPUVirtualAddress();
        auto instances = buffer(device.Get(), sizeof(instance), D3D12_HEAP_TYPE_UPLOAD, D3D12_RESOURCE_STATE_GENERIC_READ);
        upload(instances.Get(), &instance, sizeof(instance));
        D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_INPUTS tlasInput{};
        tlasInput.Type = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL;
        tlasInput.Flags = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PREFER_FAST_TRACE;
        tlasInput.NumDescs = 1;
        tlasInput.DescsLayout = D3D12_ELEMENTS_LAYOUT_ARRAY;
        tlasInput.InstanceDescs = instances->GetGPUVirtualAddress();
        D3D12_RAYTRACING_ACCELERATION_STRUCTURE_PREBUILD_INFO tlasInfo{};
        device->GetRaytracingAccelerationStructurePrebuildInfo(&tlasInput, &tlasInfo);
        auto tlas = buffer(device.Get(), tlasInfo.ResultDataMaxSizeInBytes, D3D12_HEAP_TYPE_DEFAULT,
            D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        auto tlasScratch = buffer(device.Get(), tlasInfo.ScratchDataSizeInBytes, D3D12_HEAP_TYPE_DEFAULT,
            D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC tlasBuild{};
        tlasBuild.Inputs = tlasInput;
        tlasBuild.DestAccelerationStructureData = tlas->GetGPUVirtualAddress();
        tlasBuild.ScratchAccelerationStructureData = tlasScratch->GetGPUVirtualAddress();
        commands->BuildRaytracingAccelerationStructure(&tlasBuild, 0, nullptr);
        uavBarrier(commands.Get(), tlas.Get());

        std::array<D3D12_ROOT_PARAMETER, 2> rootParameters{};
        rootParameters[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_SRV;
        rootParameters[0].Descriptor.ShaderRegister = 0;
        rootParameters[0].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
        rootParameters[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_UAV;
        rootParameters[1].Descriptor.ShaderRegister = 0;
        rootParameters[1].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
        D3D12_ROOT_SIGNATURE_DESC rootDesc{};
        rootDesc.NumParameters = UINT(rootParameters.size());
        rootDesc.pParameters = rootParameters.data();
        ComPtr<ID3DBlob> rootBlob, errors;
        check(D3D12SerializeRootSignature(&rootDesc, D3D_ROOT_SIGNATURE_VERSION_1, &rootBlob, &errors), "SerializeRootSignature");
        ComPtr<ID3D12RootSignature> root;
        check(device->CreateRootSignature(0, rootBlob->GetBufferPointer(), rootBlob->GetBufferSize(), IID_PPV_ARGS(&root)), "CreateRootSignature");
        std::ifstream shaderFile(argv[1], std::ios::binary);
        if (!shaderFile) throw std::runtime_error("Cannot read compiled shader");
        std::vector<char> shader((std::istreambuf_iterator<char>(shaderFile)), std::istreambuf_iterator<char>());
        D3D12_COMPUTE_PIPELINE_STATE_DESC pipelineDesc{};
        pipelineDesc.pRootSignature = root.Get();
        pipelineDesc.CS = {shader.data(), shader.size()};
        ComPtr<ID3D12PipelineState> pipeline;
        check(device->CreateComputePipelineState(&pipelineDesc, IID_PPV_ARGS(&pipeline)), "CreateComputePipelineState");
        auto output = buffer(device.Get(), 4 * sizeof(Hit), D3D12_HEAP_TYPE_DEFAULT, D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
            D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        auto readback = buffer(device.Get(), 4 * sizeof(Hit), D3D12_HEAP_TYPE_READBACK, D3D12_RESOURCE_STATE_COPY_DEST);
        constexpr UINT repetitions = 256;
        D3D12_QUERY_HEAP_DESC queryDesc{};
        queryDesc.Type = D3D12_QUERY_HEAP_TYPE_TIMESTAMP;
        queryDesc.Count = 4;
        ComPtr<ID3D12QueryHeap> queries;
        check(device->CreateQueryHeap(&queryDesc, IID_PPV_ARGS(&queries)), "CreateQueryHeap");
        auto timestamps = buffer(device.Get(), 4 * sizeof(uint64_t), D3D12_HEAP_TYPE_READBACK, D3D12_RESOURCE_STATE_COPY_DEST);
        uint64_t frequency{};
        check(queue->GetTimestampFrequency(&frequency), "GetTimestampFrequency");
        commands->SetPipelineState(pipeline.Get());
        commands->SetComputeRootSignature(root.Get());
        commands->SetComputeRootShaderResourceView(0, tlas->GetGPUVirtualAddress());
        commands->SetComputeRootUnorderedAccessView(1, output->GetGPUVirtualAddress());
        commands->EndQuery(queries.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 0);
        commands->Dispatch(1, 1, 1);
        commands->EndQuery(queries.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 1);
        uavBarrier(commands.Get(), output.Get());
        commands->EndQuery(queries.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 2);
        for (UINT i = 0; i < repetitions; ++i) {
            commands->Dispatch(1, 1, 1);
            uavBarrier(commands.Get(), output.Get());
        }
        commands->EndQuery(queries.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 3);
        D3D12_RESOURCE_BARRIER copyBarrier{};
        copyBarrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        copyBarrier.Transition.pResource = output.Get();
        copyBarrier.Transition.StateBefore = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
        copyBarrier.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
        copyBarrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        commands->ResourceBarrier(1, &copyBarrier);
        commands->CopyResource(readback.Get(), output.Get());
        commands->ResolveQueryData(queries.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 0, 4, timestamps.Get(), 0);
        check(commands->Close(), "Close commands");
        ID3D12CommandList* commandLists[]{commands.Get()};
        queue->ExecuteCommandLists(1, commandLists);
        check(queue->Signal(fence.Get(), 1), "Signal fence");
        check(fence->SetEventOnCompletion(1, fenceEvent), "SetEventOnCompletion");
        DWORD wait = WaitForSingleObject(fenceEvent, 15000);
        CloseHandle(fenceEvent);
        if (wait != WAIT_OBJECT_0) throw std::runtime_error("GPU fixture exceeded 15-second completion bound");
        check(device->GetDeviceRemovedReason(), "Device status");
        Hit* hits{};
        D3D12_RANGE hitRange{0, 4 * sizeof(Hit)};
        check(readback->Map(0, &hitRange, reinterpret_cast<void**>(&hits)), "Map hit readback");
        uint64_t* ticks{};
        D3D12_RANGE timestampRange{0, 4 * sizeof(uint64_t)};
        check(timestamps->Map(0, &timestampRange, reinterpret_cast<void**>(&ticks)), "Map timestamp readback");
        bool passed = hits[0].hit == 1 && hits[1].hit == 0 && hits[2].hit == 1 && hits[3].hit == 1;
        for (UINT i : {0u, 2u, 3u}) passed &= hits[i].instance == 7 && hits[i].primitive == 0 && std::abs(hits[i].distance - 1.f) < 1e-6;
        std::ofstream report(argv[2]);
        if (!report) throw std::runtime_error("Cannot write report");
        report << std::setprecision(12) << "{\n  \"scope\": \"One-triangle native DXR capability fixture; not full-world timing or FPS\",\n"
            << "  \"adapter\": \"" << escaped(utf8(desc.Description)) << "\",\n"
            << "  \"vendorId\": " << desc.VendorId << ",\n  \"deviceId\": " << desc.DeviceId
            << ",\n  \"dedicatedVideoMemoryBytes\": " << desc.DedicatedVideoMemory
            << ",\n  \"dxrTier\": \"" << dxrTier << "\",\n  \"dxrTierRaw\": " << options5.RaytracingTier
            << ",\n  \"meshShaderTierRaw\": " << options7.MeshShaderTier
            << ",\n  \"shaderModelAtLeast\": \"6.5\",\n  \"shaderModelQueryRaw\": " << shaderModel.HighestShaderModel
            << ",\n  \"driverVersion\": \"" << HIWORD(driverVersion.HighPart) << '.' << LOWORD(driverVersion.HighPart) << '.' << HIWORD(driverVersion.LowPart) << '.' << LOWORD(driverVersion.LowPart) << "\",\n"
            << "  \"windowCreated\": false,\n  \"hardwareRayQueryExecuted\": true,\n"
            << "  \"timestampFrequencyHz\": " << frequency << ",\n"
            << "  \"singleDispatchGpuMs\": " << double(ticks[1] - ticks[0]) * 1000 / frequency << ",\n"
            << "  \"repeatedDispatches\": " << repetitions << ",\n"
            << "  \"repeatedDispatchesIncludingUavBarriersGpuMs\": " << double(ticks[3] - ticks[2]) * 1000 / frequency << ",\n"
            << "  \"blasBytes\": " << blasInfo.ResultDataMaxSizeInBytes << ",\n  \"tlasBytes\": " << tlasInfo.ResultDataMaxSizeInBytes
            << ",\n  \"passed\": " << (passed ? "true" : "false") << ",\n  \"hits\": [\n";
        for (UINT i = 0; i < 4; ++i) {
            const auto& h = hits[i];
            report << "    {\"ray\":" << i << ",\"hit\":" << h.hit << ",\"instance\":" << h.instance
                << ",\"primitive\":" << h.primitive << ",\"distance\":" << h.distance << ",\"u\":" << h.u << ",\"v\":" << h.v << "}" << (i == 3 ? "\n" : ",\n");
        }
        report << "  ],\n  \"errors\": []\n}\n";
        D3D12_RANGE noWrite{0, 0};
        readback->Unmap(0, &noWrite); timestamps->Unmap(0, &noWrite);
        std::cout << "Adapter: " << utf8(desc.Description) << "; DXR " << dxrTier << "; offscreen ray hits " << (passed ? "PASS" : "FAIL") << '\n';
        return passed ? 0 : 2;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
