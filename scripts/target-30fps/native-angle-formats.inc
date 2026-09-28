    // Data-plane proof: import original integer/float D3D12 textures as EGLImages,
    // sample in GLSL ES and return raw uint32 words through an integer framebuffer.
    using CreateImage=void*(EGLAPIENTRY*)(EGLDisplay,EGLContext,EGLenum,EGLClientBuffer,const EGLint*);
    using DestroyImage=EGLBoolean(EGLAPIENTRY*)(EGLDisplay,void*);
    using BindImage=void(APIENTRY*)(GLenum,void*);
    auto createImage=reinterpret_cast<CreateImage>(eglGetProcAddress("eglCreateImageKHR"));
    auto destroyImage=reinterpret_cast<DestroyImage>(eglGetProcAddress("eglDestroyImageKHR"));
    auto bindImage=reinterpret_cast<BindImage>(eglGetProcAddress("glEGLImageTargetTexture2DOES"));
    if(!createImage||!destroyImage||!bindImage)throw std::runtime_error("EGLImage data-plane entry points unavailable");
    G(PFNGLGENTEXTURESPROC,glGenTextures);G(PFNGLBINDTEXTUREPROC,glBindTexture);G(PFNGLTEXIMAGE2DPROC,glTexImage2D);G(PFNGLTEXPARAMETERIPROC,glTexParameteri);G(PFNGLFRAMEBUFFERTEXTURE2DPROC,glFramebufferTexture2D);G(PFNGLDELETETEXTURESPROC,glDeleteTextures);G(PFNGLDELETEFRAMEBUFFERSPROC,glDeleteFramebuffers);
    const char* formatNames[]{"RGBA32_UINT","RGBA32_FLOAT","R32_FLOAT"};
    const DXGI_FORMAT formatEnums[]{DXGI_FORMAT_R32G32B32A32_UINT,DXGI_FORMAT_R32G32B32A32_FLOAT,DXGI_FORMAT_R32_FLOAT};
    const std::array<uint32_t,4> uintWords{0x12345678u,0xffffffffu,0x7fc12345u,0x80000000u};
    std::array<float,4> floatValues{.123456789f,16000.125f,-97.03125f,1.1754944e-38f};std::array<uint32_t,4> floatWords{};memcpy(floatWords.data(),floatValues.data(),16);
    std::ofstream formatReport(output/L"formats-report.json");formatReport<<"{\n\"renderer\":\""<<escaped(renderer)<<"\",\"windowCreated\":false,\"cpuTransferBetweenApis\":false,\"tests\":[\n";
    for(UINT formatIndex=0;formatIndex<3;++formatIndex){
        auto dataDesc=textureDesc;dataDesc.Width=1;dataDesc.Height=1;dataDesc.Format=formatEnums[formatIndex];dataDesc.Flags|=D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
        ComPtr<ID3D12Resource> sharedData12;ComPtr<ID3D11Texture2D> sharedData11;
        D3D11_TEXTURE2D_DESC nativeDesc{};nativeDesc.Width=1;nativeDesc.Height=1;nativeDesc.MipLevels=1;nativeDesc.ArraySize=1;nativeDesc.Format=formatEnums[formatIndex];nativeDesc.SampleDesc.Count=1;nativeDesc.Usage=D3D11_USAGE_DEFAULT;nativeDesc.BindFlags=D3D11_BIND_SHADER_RESOURCE|D3D11_BIND_RENDER_TARGET;nativeDesc.MiscFlags=D3D11_RESOURCE_MISC_SHARED_NTHANDLE|D3D11_RESOURCE_MISC_SHARED;
        HRESULT openResult=device11->CreateTexture2D(&nativeDesc,nullptr,&sharedData11);HANDLE handle{};
        if(SUCCEEDED(openResult)){ComPtr<IDXGIResource1> sharedResource;check(sharedData11.As(&sharedResource),"Data resource1");openResult=sharedResource->CreateSharedHandle(nullptr,DXGI_SHARED_RESOURCE_READ|DXGI_SHARED_RESOURCE_WRITE,nullptr,&handle);if(SUCCEEDED(openResult)){openResult=device12->OpenSharedHandle(handle,IID_PPV_ARGS(&sharedData12));CloseHandle(handle);}}
        if(FAILED(openResult)){if(formatIndex)formatReport<<",\n";formatReport<<"{\"format\":\""<<formatNames[formatIndex]<<"\",\"sharedResourceOpened\":false,\"openHresult\":"<<uint32_t(openResult)<<",\"rawWordsExact\":false}";std::cout<<"FORMAT "<<formatNames[formatIndex]<<" sharedResourceOpenFailed="<<std::hex<<openResult<<std::dec<<std::endl;continue;}
        dataDesc=sharedData12->GetDesc();
        D3D12_PLACED_SUBRESOURCE_FOOTPRINT dataFootprint{};UINT64 dataBytes=0;device12->GetCopyableFootprints(&dataDesc,0,1,0,&dataFootprint,nullptr,nullptr,&dataBytes);auto dataUpload=buffer(device12.Get(),dataBytes,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);auto expected=formatIndex==0?uintWords:floatWords;upload(dataUpload.Get(),expected.data(),formatIndex==2?4:16);
        D3D12_TEXTURE_COPY_LOCATION sourceData{};sourceData.pResource=dataUpload.Get();sourceData.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;sourceData.PlacedFootprint=dataFootprint;D3D12_TEXTURE_COPY_LOCATION destinationData{};destinationData.pResource=sharedData12.Get();destinationData.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        D3D12_RESOURCE_BARRIER dataBarrier{};dataBarrier.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;dataBarrier.Transition={sharedData12.Get(),D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST};commands->ResourceBarrier(1,&dataBarrier);commands->CopyTextureRegion(&destinationData,0,0,0,&sourceData,nullptr);std::swap(dataBarrier.Transition.StateBefore,dataBarrier.Transition.StateAfter);commands->ResourceBarrier(1,&dataBarrier);wait();
        while(eglGetError()!=EGL_SUCCESS){};while(glGetError()!=GL_NO_ERROR){};
        const EGLint imageAttributes[]{EGL_NONE};void* imported=createImage(display,EGL_NO_CONTEXT,0x3484,reinterpret_cast<EGLClientBuffer>(sharedData11.Get()),imageAttributes);const auto importError=eglGetError();
        bool exact=false;GLenum imageError=0,framebufferStatus=0;std::array<uint32_t,4> actual{};
        if(imported){
            GLuint inputTexture=0;glGenTextures(1,&inputTexture);glBindTexture(GL_TEXTURE_2D,inputTexture);bindImage(GL_TEXTURE_2D,imported);imageError=glGetError();glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
            if(imageError==GL_NO_ERROR){
                GLuint resultTexture=0,resultFbo=0;glGenTextures(1,&resultTexture);glBindTexture(GL_TEXTURE_2D,resultTexture);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA32UI,1,1,0,GL_RGBA_INTEGER,GL_UNSIGNED_INT,nullptr);glGenFramebuffers(1,&resultFbo);glBindFramebuffer(GL_FRAMEBUFFER,resultFbo);glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,resultTexture,0);framebufferStatus=glCheckFramebufferStatus(GL_FRAMEBUFFER);
                if(framebufferStatus==GL_FRAMEBUFFER_COMPLETE){
                    const char* dataVertex="#version 300 es\nprecision highp float;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}";
                    const char* uintFragment="#version 300 es\nprecision highp float;precision highp int;uniform highp usampler2D source;out highp uvec4 color;void main(){color=texelFetch(source,ivec2(0),0);}";
                    const char* floatFragment="#version 300 es\nprecision highp float;precision highp int;uniform highp sampler2D source;out highp uvec4 color;void main(){color=floatBitsToUint(texelFetch(source,ivec2(0),0));}";
                    auto dataProgram=glCreateProgram();glAttachShader(dataProgram,compile(GL_VERTEX_SHADER,dataVertex));glAttachShader(dataProgram,compile(GL_FRAGMENT_SHADER,formatIndex==0?uintFragment:floatFragment));glLinkProgram(dataProgram);GLint valid=0;glGetProgramiv(dataProgram,GL_LINK_STATUS,&valid);if(!valid)throw std::runtime_error("Data format GLSL link failed");glUseProgram(dataProgram);glBindTexture(GL_TEXTURE_2D,inputTexture);glViewport(0,0,1,1);glDrawArrays(GL_TRIANGLES,0,3);glReadPixels(0,0,1,1,GL_RGBA_INTEGER,GL_UNSIGNED_INT,actual.data());glFinish();imageError=glGetError();
                    if(formatIndex==2)expected={floatWords[0],0,0,0x3f800000};exact=actual==expected&&imageError==GL_NO_ERROR;
                }
                glBindFramebuffer(GL_FRAMEBUFFER,0);glDeleteFramebuffers(1,&resultFbo);glDeleteTextures(1,&resultTexture);
            }
            glBindTexture(GL_TEXTURE_2D,0);glDeleteTextures(1,&inputTexture);eglCheck(destroyImage(display,imported),"Destroy data EGLImage");glFinish();
        }
        if(formatIndex)formatReport<<",\n";formatReport<<"{\"format\":\""<<formatNames[formatIndex]<<"\",\"eglImageAccepted\":"<<(imported?"true":"false")<<",\"eglError\":"<<importError<<",\"glError\":"<<imageError<<",\"framebufferStatus\":"<<framebufferStatus<<",\"rawWordsExact\":"<<(exact?"true":"false")<<",\"expected\":[";for(int i=0;i<4;++i)formatReport<<(i?",":"")<<expected[i];formatReport<<"],\"actual\":[";for(int i=0;i<4;++i)formatReport<<(i?",":"")<<actual[i];formatReport<<"]}";formatReport.flush();
        std::cout<<"FORMAT "<<formatNames[formatIndex]<<" accepted="<<(imported!=nullptr)<<" EGLerror="<<importError<<" GLerror="<<imageError<<" exact="<<exact<<std::endl;
    }
    formatReport<<"\n]}\n";formatReport.close();
