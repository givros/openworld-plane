"""Packed, uncompressed physical-scale surface detail and editable crop kits."""
import math
import random
import bpy


def terrain_finish(obj):
    import numpy as np
    size=1024
    y,x=np.mgrid[0:size,0:size]/size
    # Periodic granular height gives a seamless material, not terrain noise.
    rng=np.random.default_rng(5821)
    height=np.zeros((size,size))
    for frequency,amplitude in [(5,.4),(13,.19),(29,.11),(67,.06),(131,.025)]:
        for _ in range(4):
            a=int(rng.integers(-frequency,frequency+1));b=int(rng.integers(-frequency,frequency+1))
            height+=amplitude*np.sin(math.tau*(x*a+y*b)+rng.random()*math.tau)
    dx=(np.roll(height,-1,1)-np.roll(height,1,1))*5
    dy=(np.roll(height,-1,0)-np.roll(height,1,0))*5
    normals=np.stack([-dx,-dy,np.ones_like(height)],axis=-1)
    normals/=np.linalg.norm(normals,axis=-1)[...,None]
    rgba=np.ones((size,size,4),dtype=np.float32);rgba[...,:3]=normals*.5+.5
    image=bpy.data.images.new('Terrain_grain_3m_normal',width=size,height=size,alpha=True)
    image.colorspace_settings.name='Non-Color';image.pixels.foreach_set(rgba.ravel());image.pack()
    material=obj.data.materials[0];nodes=material.node_tree.nodes;links=material.node_tree.links
    texture=nodes.new('ShaderNodeTexImage');texture.image=image;texture.extension='REPEAT'
    normal=nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.5
    links.new(texture.outputs['Color'],normal.inputs['Color'])
    links.new(normal.outputs['Normal'],nodes.get('Principled BSDF').inputs['Normal'])
    uv=obj.data.uv_layers.new(name='SurfaceMeters')
    for polygon in obj.data.polygons:
        for loopindex in polygon.loop_indices:
            vertex=obj.data.vertices[obj.data.loops[loopindex].vertex_index]
            uv.data[loopindex].uv=(vertex.co.x/3,-vertex.co.y/3)
    obj['surface_detail']='Packed 1024px seamless granular normal; 3m physical repeat; source and GLB preserved'


def crops(ctx,name,cx,cz,width,depth,material='crop_gold'):
    if not hasattr(ctx,'meshes'):return
    key=('crop-prototype',material)
    if key not in ctx.meshes:
        rng=random.Random(1864);verts=[];faces=[]
        def blade(a,b,w):
            k=len(verts);x,y,z=a;xx,yy,zz=b
            verts.extend([(x-w,y,z),(x+w,y,z),(xx+w*.32,yy,zz),(xx-w*.32,yy,zz)])
            faces.append((k,k+1,k+2,k+3))
        for iz in range(18):
            for ix in range(18):
                x,z=(ix+.5)*.32-2.88+rng.uniform(-.07,.07),(iz+.5)*.32-2.88+rng.uniform(-.07,.07)
                h=rng.uniform(.64,1.02);lean=rng.uniform(-.16,.16)
                blade((x,0,z),(x+lean,h,z+.04),.012)
                for side in (-1,1):blade((x,h*.33,z),(x+side*.22,h*.70,z+.13),.028)
                for ear in range(5):
                    ey=h-.04+ear*.035;ex=x+lean
                    blade((ex,ey,z+.04),(ex+(-1 if ear%2 else 1)*.047,ey+.08,z+.05),.025)
        proto=ctx.mesh('CropPrototype/'+material,verts,faces,material)
        ctx.meshes[key]=proto.data
        bpy.data.objects.remove(proto,do_unlink=True)
        ctx.entries.pop()
    spacing=5.65
    nx,nz=int((width-3)/spacing),int((depth-3)/spacing)
    for iz in range(nz):
        for ix in range(nx):
            x=cx-width/2+3+(ix+.5)*spacing;z=cz-depth/2+3+(iz+.5)*spacing
            obj=ctx._object(f'{name}/crop-{ix}-{iz}',ctx.meshes[key],material,(x,ctx.ground(x,z)+.1,z))
            from mathutils import Vector
            gx=(ctx.ground(x+2,z)-ctx.ground(x-2,z))/4
            gz=(ctx.ground(x,z+2)-ctx.ground(x,z-2))/4
            obj.rotation_mode='QUATERNION'
            obj.rotation_quaternion=Vector((0,0,1)).rotation_difference(Vector((-gx,gz,1)).normalized())
