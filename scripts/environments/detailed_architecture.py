"""Four Horizons architectural assemblies, in metres with local +Z front / Y up.

Original geometry informed by the user's Willowmere and Verdant City references.
Components remain editable by construction role and material. No decimation,
proxy meshes, texture compression or distance-dependent detail are used.
"""
import math
import random
import hashlib
import bpy
from mathutils import Vector
from layout_datums import facade_bays, entry_anchor

TAU=math.tau
UP=Vector((0,1,0))


def surface_images(ctx,family):
    """Original 2 m repeat, full-resolution PNG-compatible normal/roughness data."""
    import numpy as np
    cache=getattr(ctx,'_architecture_surface_images',{})
    if family in cache:return cache[family]
    size=512;rng=np.random.default_rng({'plaster':401,'stone':402,'wood':403}[family])
    yy,xx=np.mgrid[0:size,0:size]/size
    fine=rng.normal(0,1,(size,size))
    broad=np.sin(xx*TAU*7+np.sin(yy*TAU*3))*np.cos(yy*TAU*9)
    if family=='wood':
        height=np.sin(xx*TAU*145+np.sin(yy*TAU*2)*1.8)*.00032+fine*.000045
        rough=.76+broad*.055+fine*.018
    elif family=='stone':
        height=broad*.00035+fine*.00012
        rough=.88+broad*.045+fine*.018
    else:
        height=broad*.0008+fine*.00022
        rough=.86+broad*.035+fine*.02
    dx=(np.roll(height,-1,1)-np.roll(height,1,1))/(4/size)
    dy=(np.roll(height,-1,0)-np.roll(height,1,0))/(4/size)
    norm=np.sqrt(dx*dx+dy*dy+1)
    rgba=np.ones((size,size,4),dtype=np.float32)
    rgba[:,:,0]=-.5*dx/norm+.5;rgba[:,:,1]=-.5*dy/norm+.5;rgba[:,:,2]=.5/norm+.5
    normal=bpy.data.images.new('Architecture_'+family+'_2m_Normal',width=size,height=size,alpha=True)
    normal.colorspace_settings.name='Non-Color';normal.pixels.foreach_set(rgba.ravel());normal.pack()
    values=np.clip(rough,.55,.98);rgba[:,:,:3]=values[:,:,None]
    roughness=bpy.data.images.new('Architecture_'+family+'_2m_Roughness',width=size,height=size,alpha=True)
    roughness.colorspace_settings.name='Non-Color';roughness.pixels.foreach_set(rgba.ravel());roughness.pack()
    cache[family]=(normal,roughness);ctx._architecture_surface_images=cache
    return cache[family]


def textured_material(ctx,key,family):
    name=key+'/crafted-'+family
    if name in ctx.materials:return name
    material=ctx.materials[key].copy();material.name=name;ctx.materials[name]=material
    normal,roughness=surface_images(ctx,family);nodes=material.node_tree.nodes;links=material.node_tree.links
    bs=nodes.get('Principled BSDF');tex=nodes.new('ShaderNodeTexImage');tex.name='Architecture_Surface_Normal';tex.image=normal;tex.extension='REPEAT'
    normal_node=nodes.new('ShaderNodeNormalMap');normal_node.inputs['Strength'].default_value=.65
    links.new(tex.outputs['Color'],normal_node.inputs['Color']);links.new(normal_node.outputs['Normal'],bs.inputs['Normal'])
    rough=nodes.new('ShaderNodeTexImage');rough.image=roughness;rough.extension='REPEAT';links.new(rough.outputs['Color'],bs.inputs['Roughness'])
    material['surface_scale_meters']=2.0;material['surface_detail']='Original uncompressed 512 px tangent normal and roughness maps'
    return name


def palette(ctx,wall,roof):
    swatches={
        'limestone':('d2c6ab',.88,0),'stone_mid':('b7aa8f',.93,0),'stone_warm':('c5b599',.91,0),
        'stone_dark':('928774',.94,0),'mortar':('9b9584',.96,0),'plaster_worn':('c4b99c',.96,0),
        'oak':('795a40',.82,0),'oak_light':('92734f',.83,0),'oak_dark':('493d31',.88,0),
        'shutter_sage':('617766',.76,0),'shutter_blue':('57757f',.74,0),'shutter_olive':('7a8058',.79,0),
        'frame':('e4ddc8',.72,0),'iron':('354547',.5,.48),'zinc':('798584',.48,.55),
        'glass_deep':('355b61',.24,.32),'glass_sky':('6e999f',.22,.36),'recess':('273b3d',.92,0),
        'clay0':('a85841',.86,0),'clay1':('bb6c4f',.86,0),'clay2':('a6644a',.88,0),
        'clay3':('c27a5a',.87,0),'clay4':('97523f',.9,0),'slate0':('526772',.87,0),
        'slate1':('647883',.88,0),'slate2':('465c68',.89,0),'slate3':('72848b',.85,0),
        'earth_light':('dbb789',.96,0),'earth_dark':('b38a62',.98,0),'earth_pale':('e3c69f',.95,0),
        'door_teal':('486d65',.77,0),'brass':('b79a66',.42,.65),'canvas':('c4ac80',.94,0),
        'terrace':('bfa886',.95,0),'runoff':('a59d87',.98,0),
    }
    result={'wall':wall,'roof':roof}
    for name,(colour,roughness,metallic) in swatches.items():
        key='architecture_'+name;ctx.material(key,colour,roughness,metallic);result[name]=key
    result['wall']=textured_material(ctx,wall,'wood' if 'timber' in wall else 'plaster')
    for role in ('limestone','stone_mid','stone_warm','stone_dark','earth_light','earth_dark','earth_pale'):
        result[role]=textured_material(ctx,result[role],'stone' if role.startswith('stone') or role=='limestone' else 'plaster')
    for role in ('oak','oak_light','oak_dark'):result[role]=textured_material(ctx,result[role],'wood')
    return result


class Assembly:
    def __init__(self,ctx,name,x,z,base,yaw):
        self.ctx,self.name,self.x,self.z,self.base,self.yaw=ctx,name,x,z,base,yaw
        self.c,self.s=math.cos(yaw),math.sin(yaw)
        self.parts={};self.component_count=0;self.anchors=[]

    def poly(self,role,verts,faces,material,smooth=False):
        key=(role,material);part=self.parts.setdefault(key,{'v':[],'f':[],'smooth':[]})
        offset=len(part['v']);part['v'].extend(tuple(v) for v in verts)
        part['f'].extend(tuple(offset+i for i in face) for face in faces)
        part['smooth'].extend([smooth]*len(faces));self.component_count+=1

    def box(self,role,center,size,material,axes=None,bevel=0):
        half=[v*.5 for v in size]
        if min(half)<=0:return
        axes=[Vector(v) for v in (axes or ((1,0,0),(0,1,0),(0,0,1)))]
        center=Vector(center)
        if bevel<=0:
            vertices=[center+sum((axes[i]*half[i]*sign[i] for i in range(3)),Vector()) for sign in
                [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
            faces=[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
        else:
            bevel=min(bevel,min(half)*.44);vertices=[];lookup={}
            for sx in (-1,1):
                for sy in (-1,1):
                    for sz in (-1,1):
                        signs=(sx,sy,sz)
                        for axis in range(3):
                            lookup[(signs,axis)]=len(vertices)
                            vertices.append(center+sum((axes[i]*signs[i]*(half[i] if axis==i else half[i]-bevel) for i in range(3)),Vector()))
            faces=[]
            for axis in range(3):
                other=[i for i in range(3) if i!=axis]
                for sign in (-1,1):
                    face=[]
                    for a,b in [(-1,-1),(1,-1),(1,1),(-1,1)]:
                        s=[0,0,0];s[axis]=sign;s[other[0]]=a;s[other[1]]=b;face.append(lookup[(tuple(s),axis)])
                    faces.append(tuple(face))
            for axis_a,axis_b in [(0,1),(0,2),(1,2)]:
                common=3-axis_a-axis_b
                for a in (-1,1):
                    for b in (-1,1):
                        ends=[]
                        for side in (-1,1):
                            s=[0,0,0];s[axis_a]=a;s[axis_b]=b;s[common]=side;ends.append(tuple(s))
                        faces.append((lookup[(ends[0],axis_a)],lookup[(ends[1],axis_a)],lookup[(ends[1],axis_b)],lookup[(ends[0],axis_b)]))
            for signs in [s for s,a in lookup if a==0]:faces.append(tuple(lookup[(signs,axis)] for axis in range(3)))
            # Each convex face is oriented away from its own cuboid center.
            oriented=[]
            for face in faces:
                p,q,r=[vertices[i] for i in face[:3]];normal=(q-p).cross(r-p)
                mid=sum((vertices[i] for i in face),Vector())/len(face)
                oriented.append(tuple(reversed(face)) if normal.dot(mid-center)<0 else face)
            faces=oriented
        if not bevel and axes[0].cross(axes[1]).dot(axes[2])<0:faces=[tuple(reversed(f)) for f in faces]
        self.poly(role,vertices,faces,material)

    def beam(self,role,start,end,width,depth,material,bevel=0):
        start,end=Vector(start),Vector(end);delta=end-start
        if delta.length<1e-6:return
        along=delta.normalized();across=along.cross(UP if abs(along.y)<.96 else Vector((1,0,0))).normalized();normal=across.cross(along).normalized()
        self.box(role,(start+end)/2,(width,delta.length,depth),material,(across,along,normal),bevel)

    def tube(self,role,start,end,radius,material,sides=12,end_radius=None):
        start,end=Vector(start),Vector(end);delta=end-start
        if delta.length<1e-6:return
        axis=delta.normalized();u=axis.cross(UP if abs(axis.y)<.96 else Vector((1,0,0))).normalized();v=axis.cross(u).normalized()
        vertices=[]
        for point,r in [(start,radius),(end,radius if end_radius is None else end_radius)]:
            vertices.extend(point+r*(u*math.cos(i*TAU/sides)+v*math.sin(i*TAU/sides)) for i in range(sides))
        self.poly(role,vertices,[(i,(i+1)%sides,(i+1)%sides+sides,i+sides) for i in range(sides)],material,True)
        self.poly(role,[vertices[i] for i in range(sides)], [tuple(range(sides-1,-1,-1))],material)
        self.poly(role,[vertices[i+sides] for i in range(sides)], [tuple(range(sides))],material)

    def finish(self,style):
        objects=[]
        for (role,material),part in self.parts.items():
            vertices=[(self.x+p[0]*self.c+p[2]*self.s,self.base+p[1],self.z-p[0]*self.s+p[2]*self.c) for p in part['v']]
            obj=self.ctx.mesh(self.name+'/'+role+'/'+material,vertices,part['f'],material)
            obj['architecture_family']=style;obj['building_id']=self.ctx.region+'/'+self.name;obj['component_role']=role
            for polygon,smooth in zip(obj.data.polygons,part['smooth']):polygon.use_smooth=smooth
            if self.ctx.materials[material].node_tree.nodes.get('Architecture_Surface_Normal'):
                # Box/planar projection uses actual local metres, so yaw and house
                # dimensions never stretch plaster grain or wood surface detail.
                uv=obj.data.uv_layers.new(name='Architecture_2m_UV')
                for polygon,face in zip(obj.data.polygons,part['f']):
                    p0,p1,p2=[Vector(part['v'][i]) for i in face[:3]];normal=(p1-p0).cross(p2-p0)
                    axis=max(range(3),key=lambda i:abs(normal[i]))
                    for loop,index in zip(polygon.loop_indices,face):
                        p=part['v'][index]
                        uv.data[loop].uv=((p[2],p[1]) if axis==0 else (p[0],p[2]) if axis==1 else (p[0],p[1]))
                        uv.data[loop].uv/=2
            objects.append(obj.name)
        return objects


class Face:
    def __init__(self,side,w,d):
        self.side=side
        self.origin,self.tangent,self.normal,self.length={
            'front':((0,0,d/2),(1,0,0),(0,0,1),w),
            'rear':((0,0,-d/2),(-1,0,0),(0,0,-1),w),
            'left':((-w/2,0,0),(0,0,1),(-1,0,0),d),
            'right':((w/2,0,0),(0,0,-1),(1,0,0),d),
        }[side]
        self.origin,self.tangent,self.normal=map(Vector,(self.origin,self.tangent,self.normal))

    def point(self,u,y,depth=0):return self.origin+self.tangent*u+UP*y+self.normal*depth
    def box(self,a,role,u,y,width,height,depth,offset,material,bevel=0):
        a.box(self.side+'/'+role,self.point(u,y,offset),(width,height,depth),material,(self.tangent,UP,self.normal),bevel)


def wall_segments(a,face,bottom,top,openings,material,thickness,timber=False,p=None):
    cuts=sorted(set([-face.length/2,face.length/2]+[max(-face.length/2,min(face.length/2,q)) for opening in openings for q in (opening['u']-opening['w']/2,opening['u']+opening['w']/2)]))
    for left,right in zip(cuts,cuts[1:]):
        midpoint=(left+right)/2;intervals=sorted((o['y'],o['y']+o['h']) for o in openings if o['u']-o['w']/2-1e-6<midpoint<o['u']+o['w']/2+1e-6)
        y=bottom
        for low,high in intervals+[(top,top)]:
            low=max(bottom,min(top,low));high=max(bottom,min(top,high))
            if low>y+1e-5:
                face.box(a,'structural-masonry',midpoint,(y+low)/2,right-left,low-y,thickness,-thickness/2,material)
                if timber:
                    courses=max(1,math.ceil((low-y)/.185))
                    for course in range(courses):
                        by=y+(course+.5)*(low-y)/courses
                        face.box(a,'overlap-timber-siding',midpoint,by,right-left-.008,(low-y)/courses-.013,.075,.026,p['oak_light'] if course%5==0 else p['oak'],.009)
            y=max(y,high)


def window(a,face,o,p,style,variant):
    u,y,w,h=o['u'],o['y'],o['w'],o['h'];role='storey-%02d/bay-%02d/'%(o['floor'],o['bay'])
    trim=p['oak_light'] if style=='chalet' else p['earth_pale'] if style=='adobe' else p['limestone'];frame=p['oak_dark'] if style=='adobe' else p['frame']
    face.box(a,role+'deep-shadow',u,y+h/2,w-.055,h-.045,.05,-.245,p['recess'])
    for sign in (-1,1):
        face.box(a,role+'stone-reveal',u+sign*(w/2-.035),y+h/2,.095,h+.07,.31,-.10,trim,.015)
        face.box(a,role+'frame-stile',u+sign*(w/2-.12),y+h/2,.095,h-.075,.11,-.075,frame,.008)
    for level in (y+.08,y+h-.08):face.box(a,role+'frame-rail',u,level,w-.11,.10,.12,-.064,frame,.008)
    face.box(a,role+'projecting-sill',u,y-.055,w+.27,.14,.49,.075,trim,.022)
    face.box(a,role+'lintel',u,y+h+.08,w+.29,.17,.35,.045,p['oak_dark'] if style=='adobe' else trim,.018)
    face.box(a,role+'mullion',u,y+h/2,.065,h-.15,.105,-.051,frame,.006)
    transom=y+h*.56;face.box(a,role+'transom',u,transom,w-.18,.058,.105,-.052,frame,.006)
    for col in (-1,1):
        for row in (0,1):
            yy=(y+.15+transom-.035)/2 if row==0 else (transom+.035+y+h-.14)/2
            hh=transom-.035-(y+.15) if row==0 else y+h-.14-(transom+.035)
            face.box(a,role+'individual-glass-pane',u+col*(w-.28)/4,yy,(w-.28)/2-.026,hh,.024,-.122,p['glass_sky'] if (variant+col+row)%4==0 else p['glass_deep'])
    include_shutters=style in ('cottage','mediterranean') and (o['bay']+variant+o['floor'])%4!=1
    if include_shutters:
        shutter=p[['shutter_sage','shutter_blue','shutter_olive'][variant%3]]
        sw=min(.50,w*.43)
        for sign in (-1,1):
            sx=u+sign*(w/2+sw/2+.09)
            face.box(a,role+'shutter-backing',sx,y+h/2,sw,h+.03,.075,.09,p['oak_dark'],.012)
            for k in range(max(7,math.ceil(h/.105))):
                yy=y+.045+k*(h-.075)/max(6,math.ceil(h/.105)-1)
                axes=(face.tangent,UP*math.cos(.28)+face.normal*math.sin(.28),face.normal*math.cos(.28)-UP*math.sin(.28))
                a.box(face.side+'/'+role+'angled-shutter-louvre',face.point(sx,yy,.145),(sw-.08,.073,.038),shutter,axes,.006)
            for edge in (-1,1):face.box(a,role+'shutter-stile',sx+edge*(sw/2-.03),y+h/2,.065,h+.08,.105,.135,shutter,.007)
            for yy in (y+.14,y+h-.14):face.box(a,role+'shutter-hinge',sx,yy,sw+.07,.035,.025,.203,p['iron'],.006)
    if style=='adobe':
        for k in (-1,0,1):face.box(a,role+'iron-window-grille',u+k*w*.25,y+h/2,.018,h+.10,.026,.08,p['iron'])
    # Fine sill runoff follows the structural opening rather than random wall noise.
    if o['floor']>0 and style!='chalet':
        for sign in (-1,1):
            center=u+sign*w*.34
            a.poly(face.side+'/'+role+'sill-runoff',[face.point(center-.025,y-.15,.003),face.point(center+.025,y-.15,.003),face.point(center+.015,y-.46,.003)],[(0,1,2)],p['runoff'])


def door(a,face,o,p,style,variant):
    u,y,w,h=o['u'],o['y'],o['w'],o['h'];role='entrance/'
    face.box(a,role+'recess',u,y+h/2,w,h,.045,-.25,p['recess'])
    dm=p['door_teal'] if style=='mediterranean' else p['oak']
    face.box(a,role+'solid-door',u,y+h/2,w-.16,h-.12,.11,-.16,dm,.018)
    planks=max(5,round(w/.14))
    for plank in range(planks):
        xx=u-w*.43+(plank+.5)*w*.86/planks
        face.box(a,role+'door-plank',xx,y+h/2,w*.86/planks-.014,h-.16,.038,-.085,dm,.005)
    for yy in (y+.2,y+h*.45,y+h-.18):face.box(a,role+'door-rail',u,yy,w-.2,.08,.045,-.047,p['oak_dark'],.008)
    for sign in (-1,1):face.box(a,role+'portal-jamb',u+sign*(w/2+.065),y+h/2,.20,h+.20,.43,.06,p['limestone'] if style!='adobe' else p['earth_light'],.027)
    face.box(a,role+'portal-lintel',u,y+h+.10,w+.42,.25,.46,.06,p['oak_dark'] if style in ('chalet','adobe') else p['limestone'],.025)
    face.box(a,role+'threshold',u,y+.015,w+.35,.12,.62,.14,p['limestone'],.018)
    for step in range(2):face.box(a,role+'approach-step',u,y-.045-step*.075,w+.55+step*.16,.15,.35,.55+step*.27,p['stone_mid'],.025)
    handle=face.point(u+w*.27,y+h*.48,.005)
    a.tube(face.side+'/'+role+'handle',handle-UP*.055,handle+UP*.055,.021,p['brass'],10)
    for yy in (.3,h-.35):face.box(a,role+'hinge-strap',u-w*.26,y+yy,w*.34,.04,.025,-.038,p['iron'],.005)


def masonry(a,face,openings,h,p,style,rng):
    def free(u,y,w,hh):
        return not any(abs(u-o['u'])<w/2+o['w']/2+.025 and y+hh/2>o['y']-.05 and y-hh/2<o['y']+o['h']+.06 for o in openings)
    course=.25 if style!='adobe' else .29
    for row in range(3):
        bottom=row*course;u=-face.length/2
        while u<face.length/2-.04:
            width=min(rng.uniform(.32,.61),face.length/2-u);center=u+width/2;u+=width
            if free(center,bottom+course/2,width,course):face.box(a,'foundation-stone-courses',center,bottom+course/2,width-.018,course-.017,.075,.033,p[['earth_dark','earth_light'][rng.randrange(2)]] if style=='adobe' else p[['stone_mid','stone_warm','limestone','stone_dark'][rng.randrange(4)]],.025)
    if style!='adobe':
        for side in (-1,1):
            quoin_height=min(h,3.0) if style=='chalet' else h
            for row in range(max(1,math.ceil(quoin_height/.39))):
                yy=min(quoin_height-.14,(row+.5)*.39);ww=.32 if row%2 else .5;uu=side*(face.length/2-ww/2)
                if free(uu,yy,ww,.36):face.box(a,'bonded-corner-quoins',uu,yy,ww,.36,.09,.035,p['stone_warm'] if row%3 else p['limestone'],.020)
    # Restrained connected exposed masonry close to the damp footing.
    scar_center=(-.31 if rng.random()<.5 else .31)*face.length
    for row in range(3):
        for column in range(4-row):
            uu=scar_center+(column-(3-row)/2)*.24;yy=.83+row*.18
            if abs(uu)<face.length/2-.35 and free(uu,yy,.24,.17):
                face.box(a,'plaster-loss-bond',uu,yy,.235,.165,.017,.009,p['earth_dark'] if style=='adobe' else p['stone_mid'],.008)


def roof_tile(a,center,across,downslope,normal,width,length,p,slate,rng,role='roof/tiles'):
    across,downslope,normal=map(Vector,(across,downslope,normal));center=Vector(center)
    if slate:
        a.box(role,center+normal*.025,(width,length,.04),p['slate'+str(rng.randrange(4))],(across,downslope,normal),.009)
    else:
        segments=6;verts=[]
        for depth in (0,-.023):
            for end in (-1,1):
                for i in range(segments+1):
                    xx=(i/segments-.5)*width;arch=math.sin(i/segments*math.pi)*.046
                    verts.append(center+across*xx+downslope*end*length/2+normal*(arch+depth))
        n=segments+1;faces=[]
        for i in range(segments):
            faces.extend([(i,i+1,n+i+1,n+i),(2*n+i,3*n+i,3*n+i+1,2*n+i+1),
                          (i,2*n+i,2*n+i+1,i+1),(n+i,n+i+1,3*n+i+1,3*n+i)])
        faces.extend([(0,n,3*n,2*n),(segments,2*n+segments,3*n+segments,n+segments)])
        a.poly(role,verts,faces,p['clay'+str(rng.randrange(5))],True)


def pitched_roof(a,w,d,h,p,style,variant,rng,dormers=True,chimney=True):
    ridge_x=style!='chalet';overhang=.58 if style!='chalet' else .62
    ridge_length=(w if ridge_x else d)+overhang*2;extent=(d if ridge_x else w)/2+overhang
    pitch=math.radians((33,37,40)[variant%3] if style!='chalet' else (36,40,43)[variant%3]);rise=extent*math.tan(pitch)
    R=Vector((1,0,0) if ridge_x else (0,0,1));S=Vector((0,0,1) if ridge_x else (1,0,0))
    slate=style=='chalet' or 'slate' in p['roof'];roof_base=Vector((0,h,0))
    def point(u,v):return R*u+S*v+UP*(h+rise*(1-abs(v)/extent))
    dormer_positions=[]
    if dormers and ridge_x and w>6 and h>4.6 and variant%3!=0:
        dormer_positions=[0] if w<10 or variant%2 else [-w*.24,w*.24]
    for sign in (-1,1):
        slope=(S*sign-UP*math.tan(pitch)).normalized();normal=(UP+S*sign*math.tan(pitch)).normalized()
        surface_length=extent/math.cos(pitch)
        a.box('roof/solid-deck',roof_base+UP*rise/2+S*sign*extent/2,(ridge_length,.115,surface_length),p['oak_dark'],(R,normal,slope))
        columns=math.ceil(ridge_length/(.285 if not slate else .32));rows=math.ceil(surface_length/.35)
        for row in range(rows):
            v=sign*(extent-(row+.46)*extent/rows)
            for column in range(columns+1):
                step=ridge_length/columns;u=-ridge_length/2+(column+.5)*step+(step*.5 if slate and row%2 else 0)
                left=max(-ridge_length/2,u-step/2);right=min(ridge_length/2,u+step/2)
                if right-left<.025:continue
                u=(left+right)/2
                if sign>0 and any(abs(u-dx)<1.00 and extent-2.10<v<extent-.53 for dx in dormer_positions):continue
                roof_tile(a,point(u,v)+normal*.082,R,slope,normal,right-left-.006,surface_length/rows+.092,p,slate,rng)
        for k in range(math.ceil(ridge_length/.85)+1):
            u=-ridge_length/2+.05+k*(ridge_length-.10)/math.ceil(ridge_length/.85)
            a.beam('roof/exposed-rafters',point(u,0)-UP*.14,point(u,sign*extent)-UP*.14,.11,.15,p['oak_light'],.012)
        a.beam('roof/fascia',point(-ridge_length/2,sign*extent)-UP*.08,point(ridge_length/2,sign*extent)-UP*.08,.18,.22,p['oak_dark'] if style=='chalet' else p['frame'],.018)
        gutter_start=point(-ridge_length/2,sign*(extent+.10))-UP*.025;gutter_end=point(ridge_length/2,sign*(extent+.10))-UP*.025
        a.tube('drainage/eaves-gutter',gutter_start,gutter_end,.067,p['zinc'],12)
        drain_top=point(ridge_length/2-.23,sign*(extent+.10))-UP*.03
        drain_neck=drain_top-S*sign*.38-UP*.28;drain_bottom=Vector((drain_neck.x,.28,drain_neck.z))
        a.tube('drainage/downpipe-elbow',drain_top,drain_neck,.045,p['zinc'],12)
        a.tube('drainage/downpipe',drain_neck,drain_bottom,.045,p['zinc'],12)
        a.tube('drainage/downpipe-outlet',drain_bottom,drain_bottom+S*sign*.19-UP*.09,.045,p['zinc'],12)
        for y in (.65,max(1,h*.5),h-.5):
            a.box('drainage/pipe-bracket',(drain_bottom.x,y,drain_bottom.z),(.13,.035,.13),p['iron'],bevel=.004)
    # Structural gables retain an actual attic aperture instead of a dark decal.
    gable_extent=(d if ridge_x else w)/2
    for sign in (-1,1):
        u=sign*(w if ridge_x else d)/2;thick=.30
        vent_low=h+.52;vent_high=h+1.38;vent_width=.76;gable_top=h+rise-.13
        has_vent=rise>1.8
        levels=[h,vent_low,vent_high,gable_top] if has_vent else [h,gable_top]
        for lo,hi in zip(levels,levels[1:]):
            rl=gable_extent*(1-(lo-h)/(gable_top-h));rh=gable_extent*(1-(hi-h)/(gable_top-h))
            strips=[(-rl,rl,-rh,rh)]
            if has_vent and abs(lo-vent_low)<1e-5:strips=[(-rl,-vent_width/2,-rh,-vent_width/2),(vent_width/2,rl,vent_width/2,rh)]
            for ll,lr,hl,hr in strips:
                outline=[(ll,lo),(lr,lo),(hr,hi)]
                if abs(hl-hr)>1e-6:outline.append((hl,hi))
                vertices=[R*(u+offset)+S*v+UP*y for offset in (0,-sign*thick) for v,y in outline];n=len(outline)
                faces=[tuple(range(n)),tuple(range(2*n-1,n-1,-1))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
                a.poly('roof/structural-gable',vertices,faces,p['oak'] if style=='chalet' else p['wall'])
        if has_vent:
            vf=Face('front',gable_extent*2,1);vf.origin=R*u;vf.tangent=S;vf.normal=R*sign
            vo={'u':0,'y':vent_low,'w':vent_width,'h':vent_high-vent_low,'floor':9,'bay':0}
            window(a,vf,vo,p,'chalet' if style=='chalet' else 'adobe',variant)
        for side in (-1,1):a.beam('roof/gable-bargeboard',point(sign*ridge_length/2,0)+UP*.025,point(sign*ridge_length/2,side*extent)+UP*.025,.17,.19,p['oak_light'] if style=='chalet' else p['frame'],.018)
        if style=='chalet':
            for k in range(-2,3):
                z=k*.5;height=max(.1,rise*(1-abs(z)/extent)-.3)
                start=h
                if has_vent and abs(z)<vent_width/2+.10:start=vent_high+.16
                if start<h+height:a.beam('roof/gable-timber',R*(u+sign*.04)+S*z+UP*start,R*(u+sign*.04)+S*z+UP*(h+height),.11,.10,p['oak_dark'],.012)
    for k in range(math.ceil(ridge_length/.34)):
        u=-ridge_length/2+(k+.5)*ridge_length/math.ceil(ridge_length/.34)
        a.tube('roof/individual-ridge-caps',point(u-.19,0)+UP*.095,point(u+.19,0)+UP*.095,.11,p['slate1'] if slate else p['clay2'],12)
    for dx in dormer_positions:dormer(a,dx,extent-1.25,h+rise*(1-(extent-.50)/extent),p,variant,rng)
    if chimney:
        u=-ridge_length*.25;v=-extent*.23;center=point(u,v);cw,cd=.68,.64
        a.box('chimney/shaft',center+UP*.54,(cw,1.70,cd),p['mortar'],bevel=.018)
        for course in range(7):
            y=center.y-.26+(course+.5)*.235
            for side in (-1,1):
                a.box('chimney/coursed-stone',(center.x+side*(cw/2+.012),y,center.z),(.045,.213,cd+.015),p['stone_warm'] if course%2 else p['limestone'],bevel=.01)
                a.box('chimney/coursed-stone',(center.x,y,center.z+side*(cd/2+.012)),(cw-.015,.213,.045),p['stone_mid'] if course%3 else p['limestone'],bevel=.01)
        a.box('chimney/coping',center+UP*1.465,(cw+.25,.17,cd+.24),p['limestone'],bevel=.026)
        for side in (-1,1):
            top=center+UP*1.80+R*side*.17
            a.tube('chimney/clay-flue',top-UP*.25,top,.095,p['clay2'],16)
            a.tube('chimney/dark-flue-opening',top+UP*.003,top+UP*.008,.073,p['recess'],16)
        a.box('chimney/flashing',center-UP*.17,(cw+.20,.04,cd+.20),p['zinc'])
    return {'type':'gable','axis':'X' if ridge_x else 'Z','eaves':h,'ridge':h+rise,'pitchDegrees':math.degrees(pitch),'overhang':overhang,'slopeExtent':extent,'attachments':'Roof positions are derived from the analytic roof plane.'}


def dormer(a,cx,cz,base,p,variant,rng):
    width,depth=1.85,1.42;top=base+1.40
    front=Face('front',width,depth);front.origin+=Vector((cx,0,cz))
    opening={'u':0,'y':base+.25,'w':.95,'h':.92,'floor':8,'bay':0}
    wall_segments(a,front,base,top,[opening],p['wall'],.25)
    window(a,front,opening,p,'cottage',variant)
    for sign in (-1,1):
        a.box('dormer/side-cheek',(cx+sign*(width/2-.12),base+.60,cz),(.25,1.2,depth),p['wall'])
    ridge=top+.61
    for sign in (-1,1):
        across=Vector((0,0,1));slope=Vector((sign, -.65,0)).normalized();normal=Vector((sign*.65,1,0)).normalized()
        for row in range(4):
            xx=sign*(row+.5)*.255
            for column in range(5):
                zz=cz-depth/2-.13+(column+.5)*(depth+.32)/5
                roof_tile(a,(cx+xx,ridge-abs(xx)*.65,zz),across,slope,normal,(depth+.32)/5+.025,.37,p,False,rng,'dormer/individual-tiles')
        a.beam('dormer/bargeboard',(cx,ridge+.015,cz+depth/2+.21),(cx+sign*1.05,top-.06,cz+depth/2+.21),.10,.12,p['frame'],.014)
    a.poly('dormer/gable',[(cx-width/2,top,cz+depth/2),(cx+width/2,top,cz+depth/2),(cx,ridge,cz+depth/2)],[(0,1,2)],p['wall'])


def balcony(a,face,floor,w,p,style):
    width=min(w-.55,5.6);projection=1.40
    face.box(a,'balcony/structural-deck',0,floor-.09,width,.20,projection,.65,p['oak_dark'] if style=='chalet' else p['limestone'],.023)
    for k in range(math.ceil(width/.19)):
        xx=-width/2+(k+.5)*width/math.ceil(width/.19)
        face.box(a,'balcony/deck-boards',xx,floor+.025,width/math.ceil(width/.19)-.012,.045,projection-.06,.65,p['oak'],.006)
    count=math.ceil(width/.20)
    for k in range(count+1):
        xx=-width/2+k*width/count
        face.box(a,'balcony/baluster',xx,floor+.56,.06 if style!='chalet' else .085,1.04,.065,1.34,p['iron'] if style!='chalet' else p['oak_light'],.008)
    face.box(a,'balcony/handrail',0,floor+1.10,width+.08,.095,.12,1.34,p['oak_dark'] if style=='chalet' else p['iron'],.014)
    for sign in (-1,1):
        a.beam('balcony/bearing-bracket',face.point(sign*width*.38,floor-.12,1.17),face.point(sign*width*.38,floor-.92,.03),.14,.16,p['oak_dark'],.016)
        for k in range(6):face.box(a,'balcony/return-baluster',sign*width/2,floor+.56,.075,1.04,.065,k*projection/5,p['oak_light'] if style=='chalet' else p['iron'],.008)
        a.beam('balcony/return-rail',face.point(sign*width/2,floor+1.10,0),face.point(sign*width/2,floor+1.10,1.40),.10,.10,p['oak_dark'] if style=='chalet' else p['iron'],.012)


def porch(a,face,door_u,p,style,variant,rng):
    width=2.4;outer=1.52;height=2.55
    for sign in (-1,1):
        if variant%2==0:
            face.box(a,'porch/post',door_u+sign*1.07,height/2,.13,height,.13,outer-.15,p['oak_light'],.018)
            face.box(a,'porch/post-foot',door_u+sign*1.07,.19,.25,.30,.25,outer-.15,p['stone_mid'],.02)
        a.beam('porch/diagonal-bracket',face.point(door_u+sign*.95,2.0,.08),face.point(door_u+sign*.95,2.51,outer-.12),.09,.10,p['oak_dark'],.012)
    for row in range(4):
        v=.08+(row+.5)*outer/4
        for col in range(8):
            u=door_u-width/2+(col+.5)*width/8
            roof_tile(a,face.point(u,height+.27-v*.17,v),face.tangent,(face.normal-UP*.17).normalized(),(UP+face.normal*.17).normalized(),width/8+.012,.47,p,style=='chalet',rng,'porch/individual-roof-tiles')
    face.box(a,'porch/fascia',door_u,height+.03,width+.1,.17,.10,outer+.08,p['oak_dark'] if style=='chalet' else p['frame'],.015)


def adobe_roof(a,w,d,h,p,variant,rng):
    a.box('roof/earthen-terrace',(0,h+.06,0),(w-.14,.20,d-.14),p['terrace'],bevel=.035)
    for side in (-1,1):
        a.box('roof/parapet-side',(side*(w/2-.12),h+.37,0),(.28,.62,d+.06),p['wall'],bevel=.055)
        a.box('roof/parapet-end',(0,h+.37,side*(d/2-.12)),(w-.05,.62,.28),p['wall'],bevel=.055)
        a.box('roof/parapet-coping',(side*(w/2-.12),h+.72,0),(.36,.11,d+.15),p['earth_light'],bevel=.032)
        a.box('roof/parapet-coping',(0,h+.72,side*(d/2-.12)),(w+.10,.11,.36),p['earth_light'],bevel=.032)
        for k in range(max(3,math.ceil(w/.75))):
            xx=-w/2+.38+k*(w-.76)/max(2,math.ceil(w/.75)-1)
            a.beam('roof/exposed-viga',(xx,h-.18,side*(d/2-.20)),(xx,h-.18,side*(d/2+.34)),.14,.16,p['oak_dark'],.022)
    if variant%3==1 and min(w,d)>6:
        rw=min(2.6,w*.32);rd=min(2.5,d*.32);cx=-w*.24;cz=-d*.24
        a.box('roof/raised-stair-pavilion',(cx,h+.87,cz),(rw,1.64,rd),p['earth_light'],bevel=.07)
        a.box('roof/pavilion-coping',(cx,h+1.76,cz),(rw+.14,.17,rd+.14),p['earth_pale'],bevel=.04)
        a.box('roof/pavilion-door',(cx,h+.78,cz+rd/2+.01),(.82,1.42,.07),p['oak_dark'],bevel=.018)
        for j in range(6):a.box('roof/pavilion-door-plank',(cx-.35+(j+.5)*.7/6,h+.78,cz+rd/2+.055),(.10,1.38,.045),p['oak'],bevel=.006)
    return {'type':'terrace','eaves':h,'ridge':h+.79+(1.10 if variant%3==1 else 0),'parapetHeight':.79,'overhang':.18}


def build_building(ctx,name,x,z,w,d,h,material,roofmat,yaw=0,style='mediterranean'):
    if min(w,d,h)<=1.5:raise ValueError('Building envelopes must have positive architectural dimensions above 1.5 metres.')
    style={'desert':'adobe','rural':'cottage','farmhouse':'cottage','merchant':'mediterranean','townhouse':'mediterranean','warehouse':'mediterranean'}.get(style,style)
    if style not in ('cottage','mediterranean','chalet','adobe'):style='mediterranean'
    seed=int(hashlib.sha256((ctx.region+'/'+name).encode()).hexdigest()[:8],16);variant=seed%12;rng=random.Random(seed)
    base=ctx.ground(x,z);p=palette(ctx,material,roofmat);a=Assembly(ctx,name,x,z,base,yaw)
    corners=[(x+xx*math.cos(yaw)+zz*math.sin(yaw),z-xx*math.sin(yaw)+zz*math.cos(yaw)) for xx in (-w/2,w/2) for zz in (-d/2,d/2)]
    lowest=min(-.15,min(ctx.ground(*point) for point in corners)-base-.15)
    a.box('foundation/continuous-footing',(0,(lowest+.14)/2,0),(w+.18,.14-lowest,d+.18),p['stone_dark'],bevel=.028)
    floor_count=max(1,round(h/(3.12 if style!='adobe' else 3.0)));floor_height=h/floor_count;opening_registry=[]
    has_balcony=floor_count>1 and (style=='chalet' or style=='mediterranean' and variant%3==1)
    for side in ('front','rear','left','right'):
        face=Face(side,w,d);length=face.length
        positions,step,door_bay=facade_bays(length)
        openings=[]
        for storey in range(floor_count):
            bottom=storey*floor_height;storey_openings=[]
            for bay,u in enumerate(positions):
                entrance=side=='front' and storey==0 and bay==door_bay
                rear_door=side=='rear' and storey==0 and bay==door_bay and variant%3==0
                balcony_door=has_balcony and side=='front' and storey==1 and bay==door_bay
                width=min(1.34 if entrance or rear_door else (1.30 if style=='cottage' else 1.03 if style=='adobe' else 1.42),step-.48)
                sill=.10 if entrance or rear_door or balcony_door else .85
                height=min(2.25 if entrance or rear_door or balcony_door else 1.23 if style=='adobe' else 1.48,floor_height-sill-.32)
                opening={'u':u,'y':bottom+sill,'w':width,'h':height,'floor':storey,'bay':bay,'door':entrance or rear_door,'balconyDoor':balcony_door}
                storey_openings.append(opening);openings.append(opening)
                if opening['door']:door(a,face,opening,p,style,variant)
                else:window(a,face,opening,p,style,variant)
                opening_registry.append({'face':side,**opening,'wallThickness':.32,'glassRecess':.122})
            timber=style=='chalet' and storey>0
            wall_segments(a,face,bottom,bottom+floor_height,storey_openings,p['oak_dark'] if timber else p['wall'],.32,timber,p)
            if storey>0:face.box(a,'storey-band',0,bottom+.005,length+.07,.15,.17,.045,p['oak_dark'] if style=='chalet' else p['earth_light'] if style=='adobe' else p['limestone'],.015)
        masonry(a,face,openings,h,p,style,rng)
        if style=='chalet':
            for u in (-length/2+.13,length/2-.13):face.box(a,'structural-timber-post',u,h*.52,.16,h*.96,.17,.035,p['oak_dark'],.015)
        if side=='front':
            if has_balcony:balcony(a,face,floor_height,w,p,style)
            elif style!='adobe':porch(a,face,positions[door_bay],p,style,variant,rng)
        if side=='front' and style=='adobe':
            # Supported shade lattice sits next to the entrance, leaving its approach open.
            shade_u=-length*.24 if positions[door_bay]>=0 else length*.24;shade_w=min(2.5,length*.36)
            for sign in (-1,1):face.box(a,'shade/verandah-post',shade_u+sign*shade_w/2,1.28,.12,2.56,.12,1.35,p['oak_dark'],.018)
            for j in range(math.ceil(shade_w/.14)):
                face.box(a,'shade/individual-lath',shade_u-shade_w/2+(j+.5)*shade_w/math.ceil(shade_w/.14),2.58,shade_w/math.ceil(shade_w/.14)-.035,.07,1.52,.74,p['oak_light'],.010)
    roof=adobe_roof(a,w,d,h,p,variant,rng) if style=='adobe' else pitched_roof(a,w,d,h,p,style,variant,rng)
    objects=a.finish(style)
    door_width=next(o['w'] for o in opening_registry if o['face']=='front' and o['door'])
    entry={'id':ctx.region+'/'+name,'center':[x,z],'dimensions':[w,h,d],'yaw':yaw,'ground':base,'enterable':False,'frontage':'local +Z','doorWidth':door_width,
        'entryAnchor':entry_anchor(x,z,w,d,yaw),'doorCenter':entry_anchor(x,z,w,d,yaw,0),
        'family':style,'variant':variant,'floorCount':floor_count,'floorHeight':floor_height,'wallThickness':.32,'roof':roof,
        'projections':{'side':.80,'rear':.80,'front':1.65},'openings':opening_registry,'editableComponents':objects,'constructionPieces':a.component_count,
        'construction':'Real segmented masonry voids; physically dimensioned roof tiles; source-preserving editable component batches.'}
    ctx.buildings.append(entry)
    return entry
