// Explicit GLES calls for immutable recorder ABI version1.
        if(op=="activeTexture"){CALL(PFNGLACTIVETEXTUREPROC,glActiveTexture,U(0));return;}
        if(op=="attachShader"){CALL(PFNGLATTACHSHADERPROC,glAttachShader,H(0),H(1));return;}
        if(op=="detachShader"){CALL(PFNGLDETACHSHADERPROC,glDetachShader,H(0),H(1));return;}
        if(op=="deleteShader"){CALL(PFNGLDELETESHADERPROC,glDeleteShader,H(0));return;}
        if(op=="deleteProgram"){CALL(PFNGLDELETEPROGRAMPROC,glDeleteProgram,H(0));return;}
        if(op=="useProgram"){CALL(PFNGLUSEPROGRAMPROC,glUseProgram,H(0));return;}
        if(op=="validateProgram"){CALL(PFNGLVALIDATEPROGRAMPROC,glValidateProgram,H(0));return;}
        if(op=="bindAttribLocation"){CALL(PFNGLBINDATTRIBLOCATIONPROC,glBindAttribLocation,H(0),U(1),S(2).c_str());return;}
        if(op=="bindBuffer"){CALL(PFNGLBINDBUFFERPROC,glBindBuffer,U(0),H(1));return;}
        if(op=="bindBufferBase"){CALL(PFNGLBINDBUFFERBASEPROC,glBindBufferBase,U(0),U(1),H(2));return;}
        if(op=="bindBufferRange"){CALL(PFNGLBINDBUFFERRANGEPROC,glBindBufferRange,U(0),U(1),H(2),integer(at(a,3)),integer(at(a,4)));return;}
        if(op=="copyBufferSubData"){CALL(PFNGLCOPYBUFFERSUBDATAPROC,glCopyBufferSubData,U(0),U(1),integer(at(a,2)),integer(at(a,3)),integer(at(a,4)));return;}
        if(op=="bindTexture"){CALL(PFNGLBINDTEXTUREPROC,glBindTexture,U(0),H(1));return;}
        if(op=="bindRenderbuffer"){CALL(PFNGLBINDRENDERBUFFERPROC,glBindRenderbuffer,U(0),H(1));return;}
        if(op=="bindSampler"){CALL(PFNGLBINDSAMPLERPROC,glBindSampler,U(0),H(1));return;}
        if(op=="bindVertexArray"){CALL(PFNGLBINDVERTEXARRAYPROC,glBindVertexArray,H(0));return;}
        if(op=="blendColor"){CALL(PFNGLBLENDCOLORPROC,glBlendColor,F(0),F(1),F(2),F(3));return;}
        if(op=="blendEquation"){CALL(PFNGLBLENDEQUATIONPROC,glBlendEquation,U(0));return;}
        if(op=="blendEquationSeparate"){CALL(PFNGLBLENDEQUATIONSEPARATEPROC,glBlendEquationSeparate,U(0),U(1));return;}
        if(op=="blendFunc"){CALL(PFNGLBLENDFUNCPROC,glBlendFunc,U(0),U(1));return;}
        if(op=="blendFuncSeparate"){CALL(PFNGLBLENDFUNCSEPARATEPROC,glBlendFuncSeparate,U(0),U(1),U(2),U(3));return;}
        if(op=="clear"){CALL(PFNGLCLEARPROC,glClear,U(0));return;}
        if(op=="clearColor"){CALL(PFNGLCLEARCOLORPROC,glClearColor,F(0),F(1),F(2),F(3));return;}
        if(op=="clearDepth"){CALL(PFNGLCLEARDEPTHFPROC,glClearDepthf,F(0));return;}
        if(op=="clearStencil"){CALL(PFNGLCLEARSTENCILPROC,glClearStencil,N(0));return;}
        if(op=="colorMask"){CALL(PFNGLCOLORMASKPROC,glColorMask,N(0),N(1),N(2),N(3));return;}
        if(op=="cullFace"){CALL(PFNGLCULLFACEPROC,glCullFace,U(0));return;}
        if(op=="depthFunc"){CALL(PFNGLDEPTHFUNCPROC,glDepthFunc,U(0));return;}
        if(op=="depthMask"){CALL(PFNGLDEPTHMASKPROC,glDepthMask,N(0));return;}
        if(op=="depthRange"){CALL(PFNGLDEPTHRANGEFPROC,glDepthRangef,F(0),F(1));return;}
        if(op=="disable"){CALL(PFNGLDISABLEPROC,glDisable,U(0));return;}
        if(op=="enable"){CALL(PFNGLENABLEPROC,glEnable,U(0));return;}
        if(op=="frontFace"){CALL(PFNGLFRONTFACEPROC,glFrontFace,U(0));return;}
        if(op=="hint"){CALL(PFNGLHINTPROC,glHint,U(0),U(1));return;}
        if(op=="lineWidth"){CALL(PFNGLLINEWIDTHPROC,glLineWidth,F(0));return;}
        if(op=="polygonOffset"){CALL(PFNGLPOLYGONOFFSETPROC,glPolygonOffset,F(0),F(1));return;}
        if(op=="sampleCoverage"){CALL(PFNGLSAMPLECOVERAGEPROC,glSampleCoverage,F(0),N(1));return;}
        if(op=="scissor"){CALL(PFNGLSCISSORPROC,glScissor,N(0),N(1),N(2),N(3));return;}
        if(op=="viewport"){CALL(PFNGLVIEWPORTPROC,glViewport,N(0),N(1),N(2),N(3));return;}
        if(op=="stencilFunc"){CALL(PFNGLSTENCILFUNCPROC,glStencilFunc,U(0),N(1),U(2));return;}
        if(op=="stencilFuncSeparate"){CALL(PFNGLSTENCILFUNCSEPARATEPROC,glStencilFuncSeparate,U(0),U(1),N(2),U(3));return;}
        if(op=="stencilMask"){CALL(PFNGLSTENCILMASKPROC,glStencilMask,U(0));return;}
        if(op=="stencilMaskSeparate"){CALL(PFNGLSTENCILMASKSEPARATEPROC,glStencilMaskSeparate,U(0),U(1));return;}
        if(op=="stencilOp"){CALL(PFNGLSTENCILOPPROC,glStencilOp,U(0),U(1),U(2));return;}
        if(op=="stencilOpSeparate"){CALL(PFNGLSTENCILOPSEPARATEPROC,glStencilOpSeparate,U(0),U(1),U(2),U(3));return;}
        if(op=="generateMipmap"){CALL(PFNGLGENERATEMIPMAPPROC,glGenerateMipmap,U(0));return;}
        if(op=="texParameterf"){CALL(PFNGLTEXPARAMETERFPROC,glTexParameterf,U(0),U(1),F(2));return;}
        if(op=="texParameteri"){CALL(PFNGLTEXPARAMETERIPROC,glTexParameteri,U(0),U(1),N(2));return;}
        if(op=="texStorage2D"){CALL(PFNGLTEXSTORAGE2DPROC,glTexStorage2D,U(0),N(1),U(2),N(3),N(4));return;}
        if(op=="texStorage3D"){CALL(PFNGLTEXSTORAGE3DPROC,glTexStorage3D,U(0),N(1),U(2),N(3),N(4),N(5));return;}
        if(op=="samplerParameterf"){CALL(PFNGLSAMPLERPARAMETERFPROC,glSamplerParameterf,H(0),U(1),F(2));return;}
        if(op=="samplerParameteri"){CALL(PFNGLSAMPLERPARAMETERIPROC,glSamplerParameteri,H(0),U(1),N(2));return;}
        if(op=="framebufferRenderbuffer"){CALL(PFNGLFRAMEBUFFERRENDERBUFFERPROC,glFramebufferRenderbuffer,U(0),U(1),U(2),H(3));return;}
        if(op=="framebufferTexture2D"){CALL(PFNGLFRAMEBUFFERTEXTURE2DPROC,glFramebufferTexture2D,U(0),U(1),U(2),H(3),N(4));return;}
        if(op=="framebufferTextureLayer"){CALL(PFNGLFRAMEBUFFERTEXTURELAYERPROC,glFramebufferTextureLayer,U(0),U(1),H(2),N(3),N(4));return;}
        if(op=="renderbufferStorage"){CALL(PFNGLRENDERBUFFERSTORAGEPROC,glRenderbufferStorage,U(0),U(1),N(2),N(3));return;}
        if(op=="renderbufferStorageMultisample"){CALL(PFNGLRENDERBUFFERSTORAGEMULTISAMPLEPROC,glRenderbufferStorageMultisample,U(0),N(1),U(2),N(3),N(4));return;}
        if(op=="blitFramebuffer"){CALL(PFNGLBLITFRAMEBUFFERPROC,glBlitFramebuffer,N(0),N(1),N(2),N(3),N(4),N(5),N(6),N(7),U(8),U(9));return;}
        if(op=="disableVertexAttribArray"){CALL(PFNGLDISABLEVERTEXATTRIBARRAYPROC,glDisableVertexAttribArray,U(0));return;}
        if(op=="enableVertexAttribArray"){CALL(PFNGLENABLEVERTEXATTRIBARRAYPROC,glEnableVertexAttribArray,U(0));return;}
        if(op=="vertexAttribDivisor"){CALL(PFNGLVERTEXATTRIBDIVISORPROC,glVertexAttribDivisor,U(0),U(1));return;}
        if(op=="vertexAttribPointer"){CALL(PFNGLVERTEXATTRIBPOINTERPROC,glVertexAttribPointer,U(0),N(1),U(2),N(3),N(4),P(5));return;}
        if(op=="vertexAttribIPointer"){CALL(PFNGLVERTEXATTRIBIPOINTERPROC,glVertexAttribIPointer,U(0),N(1),U(2),N(3),P(4));return;}
        if(op=="drawArrays"){CALL(PFNGLDRAWARRAYSPROC,glDrawArrays,U(0),N(1),N(2));return;}
        if(op=="drawElements"){CALL(PFNGLDRAWELEMENTSPROC,glDrawElements,U(0),N(1),U(2),P(3));return;}
        if(op=="drawArraysInstanced"){CALL(PFNGLDRAWARRAYSINSTANCEDPROC,glDrawArraysInstanced,U(0),N(1),N(2),N(3));return;}
        if(op=="drawElementsInstanced"){CALL(PFNGLDRAWELEMENTSINSTANCEDPROC,glDrawElementsInstanced,U(0),N(1),U(2),P(3),N(4));return;}
        if(op=="drawRangeElements"){CALL(PFNGLDRAWRANGEELEMENTSPROC,glDrawRangeElements,U(0),U(1),U(2),N(3),U(4),P(5));return;}
        if(op=="finish"){CALL(PFNGLFINISHPROC,glFinish);return;}
        if(op=="flush"){CALL(PFNGLFLUSHPROC,glFlush);return;}
        if(op=="beginQuery"){CALL(PFNGLBEGINQUERYPROC,glBeginQuery,U(0),H(1));return;}
        if(op=="endQuery"){CALL(PFNGLENDQUERYPROC,glEndQuery,U(0));return;}
        if(op=="copyTexImage2D"){CALL(PFNGLCOPYTEXIMAGE2DPROC,glCopyTexImage2D,U(0),N(1),U(2),N(3),N(4),N(5),N(6),N(7));return;}
        if(op=="copyTexSubImage2D"){CALL(PFNGLCOPYTEXSUBIMAGE2DPROC,glCopyTexSubImage2D,U(0),N(1),N(2),N(3),N(4),N(5),N(6),N(7));return;}
        if(op=="copyTexSubImage3D"){CALL(PFNGLCOPYTEXSUBIMAGE3DPROC,glCopyTexSubImage3D,U(0),N(1),N(2),N(3),N(4),N(5),N(6),N(7),N(8));return;}
        if(op=="clearBufferfi"){CALL(PFNGLCLEARBUFFERFIPROC,glClearBufferfi,U(0),N(1),F(2),N(3));return;}
        if(op=="clearBufferfv"){auto data=array<GLfloat>(at(a,2));size_t offset=size_t(integer(at(a,3)));if(offset>=data.size())throw std::runtime_error("Clear array offset");CALL(PFNGLCLEARBUFFERFVPROC,glClearBufferfv,U(0),N(1),data.data()+offset);return;}
        if(op=="clearBufferiv"){auto data=array<GLint>(at(a,2));size_t offset=size_t(integer(at(a,3)));if(offset>=data.size())throw std::runtime_error("Clear array offset");CALL(PFNGLCLEARBUFFERIVPROC,glClearBufferiv,U(0),N(1),data.data()+offset);return;}
        if(op=="clearBufferuiv"){auto data=array<GLuint>(at(a,2));size_t offset=size_t(integer(at(a,3)));if(offset>=data.size())throw std::runtime_error("Clear array offset");CALL(PFNGLCLEARBUFFERUIVPROC,glClearBufferuiv,U(0),N(1),data.data()+offset);return;}
        if(op=="vertexAttrib1f"){CALL(PFNGLVERTEXATTRIB1FPROC,glVertexAttrib1f,U(0),F(1));return;}
        if(op=="vertexAttrib1fv"){auto data=array<GLfloat>(at(a,1));CALL(PFNGLVERTEXATTRIB1FVPROC,glVertexAttrib1fv,U(0),data.data());return;}
        if(op=="vertexAttrib2f"){CALL(PFNGLVERTEXATTRIB2FPROC,glVertexAttrib2f,U(0),F(1),F(2));return;}
        if(op=="vertexAttrib2fv"){auto data=array<GLfloat>(at(a,1));CALL(PFNGLVERTEXATTRIB2FVPROC,glVertexAttrib2fv,U(0),data.data());return;}
        if(op=="vertexAttrib3f"){CALL(PFNGLVERTEXATTRIB3FPROC,glVertexAttrib3f,U(0),F(1),F(2),F(3));return;}
        if(op=="vertexAttrib3fv"){auto data=array<GLfloat>(at(a,1));CALL(PFNGLVERTEXATTRIB3FVPROC,glVertexAttrib3fv,U(0),data.data());return;}
        if(op=="vertexAttrib4f"){CALL(PFNGLVERTEXATTRIB4FPROC,glVertexAttrib4f,U(0),F(1),F(2),F(3),F(4));return;}
        if(op=="vertexAttrib4fv"){auto data=array<GLfloat>(at(a,1));CALL(PFNGLVERTEXATTRIB4FVPROC,glVertexAttrib4fv,U(0),data.data());return;}
