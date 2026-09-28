// Small standalone ANGLE ES3 context; never creates a desktop window.
#pragma once
#include <windows.h>
#include <EGL/egl.h>
#include <GL/glcorearb.h>
#include <filesystem>
#include <stdexcept>
#include <string>

class NativeAngleContext {
    HMODULE eglLibrary=nullptr,glLibrary=nullptr;
    EGLDisplay display=EGL_NO_DISPLAY;
    EGLContext context=EGL_NO_CONTEXT;
    EGLSurface surface=EGL_NO_SURFACE;
    decltype(&::eglGetProcAddress) getProcedure=nullptr;
    decltype(&::eglMakeCurrent) makeCurrent=nullptr;
    decltype(&::eglDestroyContext) destroyContext=nullptr;
    decltype(&::eglDestroySurface) destroySurface=nullptr;
    decltype(&::eglTerminate) terminate=nullptr;
public:
    template<class T>T function(const char* name)const{
        FARPROC result=GetProcAddress(glLibrary,name);
        if(!result)result=reinterpret_cast<FARPROC>(getProcedure(name));
        if(!result)throw std::runtime_error(std::string("Missing native GLES entry point: ")+name);
        return reinterpret_cast<T>(result);
    }
    explicit NativeAngleContext(const std::filesystem::path& libraries){
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS|LOAD_LIBRARY_SEARCH_USER_DIRS);
        if(!AddDllDirectory(libraries.c_str()))throw std::runtime_error("Cannot register ANGLE library directory");
        eglLibrary=LoadLibraryExW((libraries/L"libEGL.dll").c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        glLibrary=LoadLibraryExW((libraries/L"libGLESv2.dll").c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if(!eglLibrary||!glLibrary)throw std::runtime_error("Cannot load installed ANGLE libraries");
        auto eglFunction=[&](const char* name){auto address=GetProcAddress(eglLibrary,name);if(!address)throw std::runtime_error(std::string("Missing EGL export: ")+name);return address;};
        getProcedure=reinterpret_cast<decltype(getProcedure)>(eglFunction("eglGetProcAddress"));
        makeCurrent=reinterpret_cast<decltype(makeCurrent)>(eglFunction("eglMakeCurrent"));
        destroyContext=reinterpret_cast<decltype(destroyContext)>(eglFunction("eglDestroyContext"));
        destroySurface=reinterpret_cast<decltype(destroySurface)>(eglFunction("eglDestroySurface"));
        terminate=reinterpret_cast<decltype(terminate)>(eglFunction("eglTerminate"));
        auto error=reinterpret_cast<decltype(&::eglGetError)>(eglFunction("eglGetError"));
        auto check=[&](bool success,const char* label){if(!success)throw std::runtime_error(std::string(label)+" EGLerror="+std::to_string(error()));};
        using Platform=EGLDisplay(EGLAPIENTRY*)(EGLenum,void*,const EGLint*);
        auto platform=reinterpret_cast<Platform>(getProcedure("eglGetPlatformDisplayEXT"));if(!platform)throw std::runtime_error("No ANGLE platform extension");
        const EGLint attributes[]{0x3203,0x3208,0x3209,0x320A,EGL_NONE};display=platform(0x3202,EGL_DEFAULT_DISPLAY,attributes);check(display!=EGL_NO_DISPLAY,"D3D11 display");
        EGLint major=0,minor=0;check(reinterpret_cast<decltype(&::eglInitialize)>(eglFunction("eglInitialize"))(display,&major,&minor),"Initialize");
        check(reinterpret_cast<decltype(&::eglBindAPI)>(eglFunction("eglBindAPI"))(EGL_OPENGL_ES_API),"Bind ES");
        const EGLint configs[]{EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,0x0040,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};EGLConfig config{};EGLint count=0;check(reinterpret_cast<decltype(&::eglChooseConfig)>(eglFunction("eglChooseConfig"))(display,configs,&config,1,&count)&&count,"ES3 config");
        const EGLint contextAttributes[]{EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};context=reinterpret_cast<decltype(&::eglCreateContext)>(eglFunction("eglCreateContext"))(display,config,EGL_NO_CONTEXT,contextAttributes);check(context!=EGL_NO_CONTEXT,"ES3 context");
        const EGLint dimensions[]{EGL_WIDTH,1,EGL_HEIGHT,1,EGL_NONE};surface=reinterpret_cast<decltype(&::eglCreatePbufferSurface)>(eglFunction("eglCreatePbufferSurface"))(display,config,dimensions);check(surface!=EGL_NO_SURFACE,"No-window pbuffer");check(makeCurrent(display,surface,surface,context),"Make current");
        const auto getString=function<PFNGLGETSTRINGPROC>("glGetString");const std::string renderer=reinterpret_cast<const char*>(getString(GL_RENDERER));if(renderer.find("RTX 3080")==std::string::npos)throw std::runtime_error("Unexpected renderer: "+renderer);
    }
    ~NativeAngleContext(){if(display!=EGL_NO_DISPLAY){makeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);if(surface!=EGL_NO_SURFACE)destroySurface(display,surface);if(context!=EGL_NO_CONTEXT)destroyContext(display,context);terminate(display);}}
};
