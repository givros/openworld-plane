// Isolated replay of captured WebGL2 commands using their original GLSL.
#include "native-angle-context.h"
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <fstream>
#include <iostream>
#include <unordered_map>
#include <vector>
#include <array>
#include <chrono>
#include <limits>
#include <cmath>
using namespace winrt::Windows::Data::Json;
using J=IJsonValue;using O=JsonObject;using A=JsonArray;
static std::string str(J value){return winrt::to_string(value.GetString());}
static bool has(O object,const wchar_t* key){return object.HasKey(key);}
static J field(O object,const wchar_t* key){return object.GetNamedValue(key);}
static double number(J value){if(value.ValueType()==JsonValueType::Null)return 0;if(value.ValueType()==JsonValueType::Boolean)return value.GetBoolean()?1:0;if(value.ValueType()==JsonValueType::Number)return value.GetNumber();auto object=value.GetObject();if(has(object,L"number")){auto special=str(field(object,L"number"));if(special=="-0")return -0.;if(special=="NaN")return std::numeric_limits<double>::quiet_NaN();return special=="Infinity"?INFINITY:-INFINITY;}throw std::runtime_error("Expected numeric command argument");}
static uint64_t integer(J value){return uint64_t(number(value));}
static J at(A args,uint32_t index){return index<args.Size()?args.GetAt(index):JsonValue::CreateNullValue();}
static std::string textFile(const std::filesystem::path& path){std::ifstream file(path,std::ios::binary);if(!file)throw std::runtime_error("Cannot open "+path.string());return {std::istreambuf_iterator<char>(file),{}};}
static std::string quote(const std::string& text){std::string out="\"";for(char c:text){if(c=='"'||c=='\\')out+='\\';if(c=='\n'){out+="\\n";continue;}if(c=='\r'){out+="\\r";continue;}out+=c;}return out+'"';}

class Player {
    NativeAngleContext gl;
    std::filesystem::path root;
    std::unordered_map<uint32_t,intptr_t> objects;
    std::unordered_map<std::string,O> blobs;
    std::unordered_map<uint32_t,std::vector<std::pair<std::string,GLuint>>> attributes;
    std::unordered_map<uint32_t,std::unordered_map<uint32_t,GLuint>> blocks;
    GLuint defaultFbo=0,resolveFbo=0,color=0,depth=0,resolved=0;
    GLuint drawFbo=0,readFbo=0;
    uint32_t width=0,height=0;
    uint64_t draws=0,commands=0;
    bool flipY=false,premultiply=false,canvasAlpha=true;
    std::vector<unsigned char> bytes(J value){
        if(value.ValueType()==JsonValueType::Null)return {};
        if(value.ValueType()!=JsonValueType::Object)throw std::runtime_error("Expected immutable binary blob");
        auto descriptor=value.GetObject();if(has(descriptor,L"image"))descriptor=descriptor.GetNamedObject(L"image");
        auto id=str(field(descriptor,L"blob"));auto found=blobs.find(id);if(found==blobs.end())throw std::runtime_error("Missing blob "+id);
        auto reference=found->second.GetNamedObject(L"reference");auto path=root/winrt::to_string(reference.GetNamedString(L"file"));
        auto length=size_t(number(field(descriptor,L"byteLength")));auto offset=has(reference,L"byteOffset")?uint64_t(number(field(reference,L"byteOffset"))):0;
        std::vector<unsigned char> result(length);std::ifstream file(path,std::ios::binary);if(!file)throw std::runtime_error("Missing binary file "+path.string());file.seekg(offset);file.read(reinterpret_cast<char*>(result.data()),length);if(!file)throw std::runtime_error("Incomplete blob "+id);return result;
    }
    static size_t elementSize(J value){if(value.ValueType()!=JsonValueType::Object)return 1;auto object=value.GetObject();if(!has(object,L"type"))return 1;auto type=str(field(object,L"type"));if(type.find("64")!=std::string::npos)return 8;if(type.find("32")!=std::string::npos)return 4;if(type.find("16")!=std::string::npos)return 2;return 1;}
    template<class T>std::vector<T> array(J value){if(value.ValueType()==JsonValueType::Array){auto items=value.GetArray();std::vector<T> result(items.Size());for(uint32_t i=0;i<items.Size();++i)result[i]=T(number(items.GetAt(i)));return result;}auto data=bytes(value);if(data.size()%sizeof(T))throw std::runtime_error("Misaligned typed uniform data");std::vector<T> result(data.size()/sizeof(T));memcpy(result.data(),data.data(),data.size());return result;}
    intptr_t handle(J value){if(value.ValueType()==JsonValueType::Null)return 0;auto id=uint32_t(number(field(value.GetObject(),L"id")));auto found=objects.find(id);if(found==objects.end())throw std::runtime_error("Unknown object ID "+std::to_string(id));return found->second;}
    static uint32_t id(J value){return uint32_t(number(field(value.GetObject(),L"id")));}
    void result(O command,intptr_t value){if(has(command,L"result")&&field(command,L"result").ValueType()!=JsonValueType::Null)objects[id(field(command,L"result"))]=value;}
#define CALL(type,name,...) gl.function<type>(#name)(__VA_ARGS__)
    void checkShader(GLuint shader){GLint okay=0;CALL(PFNGLGETSHADERIVPROC,glGetShaderiv,shader,GL_COMPILE_STATUS,&okay);if(!okay){GLint length=0;CALL(PFNGLGETSHADERIVPROC,glGetShaderiv,shader,GL_INFO_LOG_LENGTH,&length);std::vector<char> log(length+1);CALL(PFNGLGETSHADERINFOLOGPROC,glGetShaderInfoLog,shader,length,nullptr,log.data());throw std::runtime_error(std::string("Original shader compilation: ")+log.data());}}
    void checkProgram(GLuint program){GLint okay=0;CALL(PFNGLGETPROGRAMIVPROC,glGetProgramiv,program,GL_LINK_STATUS,&okay);if(!okay){GLint length=0;CALL(PFNGLGETPROGRAMIVPROC,glGetProgramiv,program,GL_INFO_LOG_LENGTH,&length);std::vector<char> log(length+1);CALL(PFNGLGETPROGRAMINFOLOGPROC,glGetProgramInfoLog,program,length,nullptr,log.data());throw std::runtime_error(std::string("Original program link: ")+log.data());}}
    void texture(O command,const std::string& op){
        auto description=command.GetNamedObject(L"textureUpload");auto n=[&](const wchar_t* key){return GLint(number(field(description,key)));};auto pixels=field(description,L"pixels");std::vector<unsigned char> data;const void* pointer=nullptr;
        if(pixels.ValueType()==JsonValueType::Number)pointer=reinterpret_cast<const void*>(integer(pixels));
        else if(pixels.ValueType()!=JsonValueType::Null){
            data=bytes(pixels);size_t offset=size_t(n(L"sourceElementOffset"))*elementSize(pixels);if(offset>data.size())throw std::runtime_error("Texture source offset outside snapshot");pointer=data.data()+offset;
            auto object=pixels.GetObject();if(has(object,L"image")){
                auto image=object.GetNamedObject(L"image");if(str(field(image,L"encoding"))!="rgba8")throw std::runtime_error("Native replay requires exact decoded RGBA8 image snapshot");
                const auto sourceKind=str(field(image,L"sourceKind"));const bool bitmap=sourceKind=="ImageBitmap";const bool sourcePremultiplied=field(image,L"premultipliedAlpha").GetBoolean();if(sourcePremultiplied)throw std::runtime_error("Premultiplied source image needs explicit immutable pixel convention");
                // WebGL ignores unpack transforms for ImageBitmap; its snapshot
                // must already incorporate bitmap creation options.
                if(!bitmap&&flipY){const size_t row=size_t(n(L"width"))*4;std::vector<unsigned char> temp(row);for(int y=0;y<n(L"height")/2;++y){auto* a=data.data()+y*row;auto* b=data.data()+(n(L"height")-1-y)*row;memcpy(temp.data(),a,row);memcpy(a,b,row);memcpy(b,temp.data(),row);}}
                if(!bitmap&&premultiply)for(size_t i=0;i+3<data.size();i+=4)for(size_t c=0;c<3;++c)data[i+c]=uint8_t((uint32_t(data[i+c])*data[i+3]+127)/255);
                pointer=data.data();
            }
        }
        if(op=="texImage2D")CALL(PFNGLTEXIMAGE2DPROC,glTexImage2D,n(L"target"),n(L"level"),n(L"internalformat"),n(L"width"),n(L"height"),n(L"border"),n(L"format"),n(L"type"),pointer);
        else if(op=="texSubImage2D")CALL(PFNGLTEXSUBIMAGE2DPROC,glTexSubImage2D,n(L"target"),n(L"level"),n(L"xoffset"),n(L"yoffset"),n(L"width"),n(L"height"),n(L"format"),n(L"type"),pointer);
        else if(op=="texImage3D")CALL(PFNGLTEXIMAGE3DPROC,glTexImage3D,n(L"target"),n(L"level"),n(L"internalformat"),n(L"width"),n(L"height"),n(L"depth"),n(L"border"),n(L"format"),n(L"type"),pointer);
        else CALL(PFNGLTEXSUBIMAGE3DPROC,glTexSubImage3D,n(L"target"),n(L"level"),n(L"xoffset"),n(L"yoffset"),n(L"zoffset"),n(L"width"),n(L"height"),n(L"depth"),n(L"format"),n(L"type"),pointer);
    }
public:
    Player(const std::filesystem::path& libraries,const std::filesystem::path& capture,O recording):gl(libraries),root(capture.parent_path()){
        auto dimensions=recording.GetNamedObject(L"initialDrawingBuffer");width=uint32_t(number(field(dimensions,L"width")));height=uint32_t(number(field(dimensions,L"height")));if(!width||!height)throw std::runtime_error("Invalid default drawing buffer size");
        const auto frames=recording.GetNamedArray(L"frames");if(frames.Size()){auto first=frames.GetAt(0).GetObject();width=uint32_t(number(field(first,L"drawingBufferWidth")));height=uint32_t(number(field(first,L"drawingBufferHeight")));for(auto item:frames){auto frame=item.GetObject();if(number(field(frame,L"drawingBufferWidth"))!=width||number(field(frame,L"drawingBufferHeight"))!=height)throw std::runtime_error("Multiple default framebuffer sizes need explicit resize replay");}}
        for(auto requirement:std::array<std::pair<const wchar_t*,int>,3>{{{L"samples",4},{L"depthBits",24},{L"stencilBits",0}}})if(has(dimensions,requirement.first)&&field(dimensions,requirement.first).ValueType()!=JsonValueType::Null&&number(field(dimensions,requirement.first))!=requirement.second)throw std::runtime_error("Default framebuffer attributes differ from verified 4xMSAA/DEPTH24/no-stencil target");
        if(has(recording,L"contextAttributes")&&field(recording,L"contextAttributes").ValueType()==JsonValueType::Object){auto attributes=recording.GetNamedObject(L"contextAttributes");if(has(attributes,L"alpha"))canvasAlpha=field(attributes,L"alpha").GetBoolean();}
        auto blobArray=recording.GetNamedArray(L"blobs");for(auto item:blobArray){auto record=item.GetObject();if(!has(record,L"reference"))throw std::runtime_error("Capture blob has no external reference");blobs.emplace(str(field(record,L"id")),record);}
        for(auto item:recording.GetNamedArray(L"commands")){auto command=item.GetObject();if(str(field(command,L"op"))=="getAttribLocation"){auto args=command.GetNamedArray(L"args");auto location=int(number(field(command,L"result")));if(location>=0)attributes[id(args.GetAt(0))].push_back({str(args.GetAt(1)),GLuint(location)});}}
        CALL(PFNGLGENFRAMEBUFFERSPROC,glGenFramebuffers,1,&defaultFbo);CALL(PFNGLBINDFRAMEBUFFERPROC,glBindFramebuffer,GL_FRAMEBUFFER,defaultFbo);CALL(PFNGLGENRENDERBUFFERSPROC,glGenRenderbuffers,1,&color);CALL(PFNGLBINDRENDERBUFFERPROC,glBindRenderbuffer,GL_RENDERBUFFER,color);CALL(PFNGLRENDERBUFFERSTORAGEMULTISAMPLEPROC,glRenderbufferStorageMultisample,GL_RENDERBUFFER,4,GL_RGBA8,width,height);CALL(PFNGLFRAMEBUFFERRENDERBUFFERPROC,glFramebufferRenderbuffer,GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,color);CALL(PFNGLGENRENDERBUFFERSPROC,glGenRenderbuffers,1,&depth);CALL(PFNGLBINDRENDERBUFFERPROC,glBindRenderbuffer,GL_RENDERBUFFER,depth);CALL(PFNGLRENDERBUFFERSTORAGEMULTISAMPLEPROC,glRenderbufferStorageMultisample,GL_RENDERBUFFER,4,GL_DEPTH_COMPONENT24,width,height);CALL(PFNGLFRAMEBUFFERRENDERBUFFERPROC,glFramebufferRenderbuffer,GL_FRAMEBUFFER,GL_DEPTH_ATTACHMENT,GL_RENDERBUFFER,depth);if(CALL(PFNGLCHECKFRAMEBUFFERSTATUSPROC,glCheckFramebufferStatus,GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE)throw std::runtime_error("Native 4xMSAA framebuffer incomplete");
        CALL(PFNGLCLEARCOLORPROC,glClearColor,0,0,0,0);CALL(PFNGLCLEARPROC,glClear,GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);drawFbo=readFbo=defaultFbo;
        CALL(PFNGLGENFRAMEBUFFERSPROC,glGenFramebuffers,1,&resolveFbo);CALL(PFNGLGENRENDERBUFFERSPROC,glGenRenderbuffers,1,&resolved);CALL(PFNGLBINDRENDERBUFFERPROC,glBindRenderbuffer,GL_RENDERBUFFER,resolved);CALL(PFNGLRENDERBUFFERSTORAGEPROC,glRenderbufferStorage,GL_RENDERBUFFER,GL_RGBA8,width,height);CALL(PFNGLBINDFRAMEBUFFERPROC,glBindFramebuffer,GL_FRAMEBUFFER,resolveFbo);CALL(PFNGLFRAMEBUFFERRENDERBUFFERPROC,glFramebufferRenderbuffer,GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,resolved);CALL(PFNGLBINDFRAMEBUFFERPROC,glBindFramebuffer,GL_FRAMEBUFFER,defaultFbo);
    }
    void execute(O c){
        auto op=str(field(c,L"op"));auto a=c.GetNamedArray(L"args");auto N=[&](int i){return GLint(number(at(a,i)));};auto U=[&](int i){return GLuint(number(at(a,i)));};auto F=[&](int i){return GLfloat(number(at(a,i)));};auto H=[&](int i){return GLuint(handle(at(a,i)));};auto P=[&](int i){return reinterpret_cast<const void*>(integer(at(a,i)));};auto S=[&](int i){return str(at(a,i));};
        if(op=="$set"){if(S(1)!="srgb")throw std::runtime_error("Unsupported canvas color-space property "+S(1));return;}
        if(op=="createShader"){result(c,CALL(PFNGLCREATESHADERPROC,glCreateShader,U(0)));return;}
        if(op=="createProgram"){result(c,CALL(PFNGLCREATEPROGRAMPROC,glCreateProgram));return;}
#define CREATE(OP,TYPE,FUNC) if(op==OP){GLuint value=0;CALL(TYPE,FUNC,1,&value);result(c,value);return;}
        CREATE("createBuffer",PFNGLGENBUFFERSPROC,glGenBuffers) CREATE("createTexture",PFNGLGENTEXTURESPROC,glGenTextures) CREATE("createFramebuffer",PFNGLGENFRAMEBUFFERSPROC,glGenFramebuffers) CREATE("createRenderbuffer",PFNGLGENRENDERBUFFERSPROC,glGenRenderbuffers) CREATE("createVertexArray",PFNGLGENVERTEXARRAYSPROC,glGenVertexArrays) CREATE("createSampler",PFNGLGENSAMPLERSPROC,glGenSamplers) CREATE("createQuery",PFNGLGENQUERIESPROC,glGenQueries)
#define DELETE_GL(OP,TYPE,FUNC) if(op==OP){GLuint value=H(0);CALL(TYPE,FUNC,1,&value);return;}
        DELETE_GL("deleteBuffer",PFNGLDELETEBUFFERSPROC,glDeleteBuffers) DELETE_GL("deleteTexture",PFNGLDELETETEXTURESPROC,glDeleteTextures) DELETE_GL("deleteFramebuffer",PFNGLDELETEFRAMEBUFFERSPROC,glDeleteFramebuffers) DELETE_GL("deleteRenderbuffer",PFNGLDELETERENDERBUFFERSPROC,glDeleteRenderbuffers) DELETE_GL("deleteVertexArray",PFNGLDELETEVERTEXARRAYSPROC,glDeleteVertexArrays) DELETE_GL("deleteSampler",PFNGLDELETESAMPLERSPROC,glDeleteSamplers) DELETE_GL("deleteQuery",PFNGLDELETEQUERIESPROC,glDeleteQueries)
        if(op=="shaderSource"){auto source=S(1);const char* pointer=source.c_str();CALL(PFNGLSHADERSOURCEPROC,glShaderSource,H(0),1,&pointer,nullptr);return;}
        if(op=="compileShader"){CALL(PFNGLCOMPILESHADERPROC,glCompileShader,H(0));checkShader(H(0));return;}
        if(op=="linkProgram"){for(const auto& binding:attributes[id(at(a,0))])CALL(PFNGLBINDATTRIBLOCATIONPROC,glBindAttribLocation,H(0),binding.second,binding.first.c_str());CALL(PFNGLLINKPROGRAMPROC,glLinkProgram,H(0));checkProgram(H(0));return;}
        if(op=="getUniformLocation"){result(c,CALL(PFNGLGETUNIFORMLOCATIONPROC,glGetUniformLocation,H(0),S(1).c_str()));return;}
        if(op=="getAttribLocation"){auto actual=CALL(PFNGLGETATTRIBLOCATIONPROC,glGetAttribLocation,H(0),S(1).c_str());if(actual!=GLint(number(field(c,L"result"))))throw std::runtime_error("Original attribute location mismatch");return;}
        if(op=="getUniformBlockIndex"){blocks[id(at(a,0))][uint32_t(number(field(c,L"result")))]=CALL(PFNGLGETUNIFORMBLOCKINDEXPROC,glGetUniformBlockIndex,H(0),S(1).c_str());return;}
        if(op=="uniformBlockBinding"){CALL(PFNGLUNIFORMBLOCKBINDINGPROC,glUniformBlockBinding,H(0),blocks[id(at(a,0))].at(U(1)),U(2));return;}
        if(op=="bufferData"||op=="bufferSubData"){
            int dataIndex=op=="bufferData"?1:2;auto value=at(a,dataIndex);std::vector<unsigned char> data;size_t size=0;const void* pointer=nullptr;
            if(value.ValueType()==JsonValueType::Number)size=size_t(integer(value));else if(value.ValueType()!=JsonValueType::Null){data=bytes(value);size_t elem=elementSize(value),offset=size_t(integer(at(a,dataIndex+(op=="bufferData"?2:1))))*elem;size=data.size()-offset;int lengthIndex=dataIndex+(op=="bufferData"?3:2);if(uint32_t(lengthIndex)<a.Size()&&number(at(a,lengthIndex))!=0)size=size_t(integer(at(a,lengthIndex)))*elem;if(offset>data.size()||size>data.size()-offset)throw std::runtime_error("Buffer subview outside immutable blob");pointer=data.data()+offset;}
            if(op=="bufferData")CALL(PFNGLBUFFERDATAPROC,glBufferData,U(0),size,pointer,U(2));else CALL(PFNGLBUFFERSUBDATAPROC,glBufferSubData,U(0),integer(at(a,1)),size,pointer);return;
        }
        if(op=="texImage2D"||op=="texSubImage2D"||op=="texImage3D"||op=="texSubImage3D"){texture(c,op);return;}
        if(op=="bindFramebuffer"){GLuint value=at(a,1).ValueType()==JsonValueType::Null?defaultFbo:H(1);CALL(PFNGLBINDFRAMEBUFFERPROC,glBindFramebuffer,U(0),value);if(U(0)==GL_FRAMEBUFFER||U(0)==GL_DRAW_FRAMEBUFFER)drawFbo=value;if(U(0)==GL_FRAMEBUFFER||U(0)==GL_READ_FRAMEBUFFER)readFbo=value;return;}
        if(op=="drawBuffers"){auto list=array<GLenum>(at(a,0));if(drawFbo==defaultFbo)for(auto& attachment:list)if(attachment==GL_BACK)attachment=GL_COLOR_ATTACHMENT0;CALL(PFNGLDRAWBUFFERSPROC,glDrawBuffers,GLsizei(list.size()),list.data());return;}
        if(op=="readBuffer"){CALL(PFNGLREADBUFFERPROC,glReadBuffer,U(0)==GL_BACK&&readFbo==defaultFbo?GL_COLOR_ATTACHMENT0:U(0));return;}
        if(op=="invalidateFramebuffer"||op=="invalidateSubFramebuffer"){auto attachments=array<GLenum>(at(a,1));bool isDefault=U(0)==GL_READ_FRAMEBUFFER?readFbo==defaultFbo:drawFbo==defaultFbo;if(isDefault)for(auto& attachment:attachments){if(attachment==GL_COLOR)attachment=GL_COLOR_ATTACHMENT0;if(attachment==GL_DEPTH)attachment=GL_DEPTH_ATTACHMENT;if(attachment==GL_STENCIL)attachment=GL_STENCIL_ATTACHMENT;}if(op=="invalidateFramebuffer")CALL(PFNGLINVALIDATEFRAMEBUFFERPROC,glInvalidateFramebuffer,U(0),GLsizei(attachments.size()),attachments.data());else CALL(PFNGLINVALIDATESUBFRAMEBUFFERPROC,glInvalidateSubFramebuffer,U(0),GLsizei(attachments.size()),attachments.data(),N(2),N(3),N(4),N(5));return;}
        if(op=="pixelStorei"){if(U(0)==37440){flipY=N(1)!=0;return;}if(U(0)==37441){premultiply=N(1)!=0;return;}if(U(0)==37443)return;CALL(PFNGLPIXELSTOREIPROC,glPixelStorei,U(0),N(1));return;}
        if(op.rfind("uniform",0)==0){uniform(op,a);return;}
#include "native-angle-replay-commands.inc"
        throw std::runtime_error("Unsupported mutating command: "+op);
    }
    void uniform(const std::string& op,A a);
    void replay(O recording,const std::filesystem::path& output){
        auto began=std::chrono::steady_clock::now();for(auto item:recording.GetNamedArray(L"commands")){auto command=item.GetObject();try{execute(command);auto error=CALL(PFNGLGETERRORPROC,glGetError);if(error)throw std::runtime_error("GL error "+std::to_string(error));++commands;if(str(field(command,L"op")).rfind("draw",0)==0)++draws;}catch(const std::exception& error){throw std::runtime_error("seq "+std::to_string(integer(field(command,L"seq")))+" "+str(field(command,L"op"))+": "+error.what());}}
        CALL(PFNGLDISABLEPROC,glDisable,GL_SCISSOR_TEST);CALL(PFNGLBINDBUFFERPROC,glBindBuffer,GL_PIXEL_PACK_BUFFER,0);CALL(PFNGLBINDFRAMEBUFFERPROC,glBindFramebuffer,GL_READ_FRAMEBUFFER,defaultFbo);CALL(PFNGLBINDFRAMEBUFFERPROC,glBindFramebuffer,GL_DRAW_FRAMEBUFFER,resolveFbo);CALL(PFNGLBLITFRAMEBUFFERPROC,glBlitFramebuffer,0,0,width,height,0,0,width,height,GL_COLOR_BUFFER_BIT,GL_NEAREST);CALL(PFNGLBINDFRAMEBUFFERPROC,glBindFramebuffer,GL_READ_FRAMEBUFFER,resolveFbo);CALL(PFNGLPIXELSTOREIPROC,glPixelStorei,GL_PACK_ALIGNMENT,1);std::vector<uint8_t> pixels(size_t(width)*height*4);CALL(PFNGLREADPIXELSPROC,glReadPixels,0,0,width,height,GL_RGBA,GL_UNSIGNED_BYTE,pixels.data());CALL(PFNGLFINISHPROC,glFinish);auto error=CALL(PFNGLGETERRORPROC,glGetError);if(error)throw std::runtime_error("Final resolve GL error "+std::to_string(error));
        if(!canvasAlpha)for(size_t i=3;i<pixels.size();i+=4)pixels[i]=255;
        std::filesystem::create_directories(output);std::ofstream image(output/L"frame.rgba",std::ios::binary);image.write(reinterpret_cast<char*>(pixels.data()),pixels.size());image.close();auto renderer=reinterpret_cast<const char*>(CALL(PFNGLGETSTRINGPROC,glGetString,GL_RENDERER));std::ofstream report(output/L"report.json");report<<"{\"renderer\":"<<quote(renderer)<<",\"width\":"<<width<<",\"height\":"<<height<<",\"samples\":4,\"colorFormat\":\"RGBA8\",\"depthFormat\":\"DEPTH24\",\"rowOrigin\":\"bottom-left\",\"commands\":"<<commands<<",\"drawCalls\":"<<draws<<",\"replayAndReadbackWallMs\":"<<std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-began).count()<<",\"originalShadersReused\":true,\"windowCreated\":false,\"passed\":true,\"errors\":[]}\n";std::cout<<"PASS replay commands="<<commands<<" draws="<<draws<<std::endl;
    }
};

#include "native-angle-replay-uniforms.inc"
int wmain(int argc,wchar_t** argv){try{if(argc!=4)throw std::runtime_error("Arguments: installed-ANGLE-directory capture.json output-directory");winrt::init_apartment();auto recording=JsonObject::Parse(winrt::to_hstring(textFile(argv[2])));if(recording.GetNamedNumber(L"version")!=1)throw std::runtime_error("Unsupported capture ABI");Player player(argv[1],argv[2],recording);player.replay(recording,argv[3]);return 0;}catch(const winrt::hresult_error& error){std::cerr<<winrt::to_string(error.message())<<std::endl;return 1;}catch(const std::exception& error){std::cerr<<error.what()<<std::endl;return 1;}}
