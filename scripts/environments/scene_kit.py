"""Editable, shared full-detail geometry for the Four Horizons Blender source."""
import bpy, math, random
from mathutils import Vector

PALETTE = {
    'plaster_ivory':'e8ddbd','plaster_ochre':'d9ad66','plaster_rose':'c78168',
    'stone':'a5a89a','roof_terracotta':'a84f35','roof_slate':'516772',
    'timber':'78543a','bark':'5a4938','leaf_green':'477147','leaf_light':'769553',
    'pine':'305e52','asphalt':'3b4549','gravel':'b2a589','concrete':'bdb7a5',
    'cream':'f3e8ca','metal':'708383','glass':'356574','water':'268f99',
    'sand':'cdb478','sandstone':'b66a40','rock':'727e7b','snow':'e4eee9',
    'grass':'77904e','crop_gold':'b5a554',
}
def smooth(a,b,x):
    t=max(0,min(1,(x-a)/(b-a))); return t*t*(3-2*t)
def mix(a,b,t): return a*(1-t)+b*t
def rectmask(x,z,x0,x1,z0,z1,margin):
    return (1-smooth(0,margin,max(x0-x,x-x1,0)))*(1-smooth(0,margin,max(z0-z,z-z1,0)))
def raw_ground(x,z):
    meadow=4+8*math.sin(x*.005)*math.cos(z*.0035)+5*math.sin(z*.008+x*.002)
    meadow=mix(-.245,meadow,smooth(400,620,max(abs(x),abs(z))))
    coast=1840+35*math.sin(z*.006)
    harbor=mix(9+2*math.sin(x*.006)*math.sin(z*.009),-14,smooth(coast-35,coast+90,x))
    harbor=mix(harbor,9,rectmask(x,z,1280,1790,-310,310,80))
    alpine=47+14*math.sin(x*.006)*math.sin(z*.007)
    alpine+=235*math.exp(-((x+495)/210)**2-((z-1760)/425)**2)
    alpine+=265*math.exp(-((x-140)/470)**2-((z-2110)/240)**2)
    alpine+=110*math.exp(-((x-620)/230)**2-((z-1820)/390)**2)
    lakeangle=math.atan2((z-1510)/175,(x+100)/240)
    lake=math.sqrt(((x+100)/240)**2+((z-1510)/175)**2)/(1+.095*math.sin(lakeangle*3)+.055*math.cos(lakeangle*5))
    alpine=mix(22,alpine,smooth(.78,1.14,lake))
    alpine=mix(alpine,48,rectmask(x,z,170,450,1270,1570,65))
    alpine+=smooth(65,190,alpine)*(7*math.sin(x*.037+z*.016)+4*math.sin(x*.071-z*.029))
    canyon=30+12*math.sin(x*.012+z*.005)+8*math.sin(z*.014)
    canyon+=115*math.exp(-((x-2110)/210)**2-((z-1760)/580)**2)
    canyon+=85*math.exp(-((x-1650)/440)**2-((z-2140)/160)**2)
    oasisangle=math.atan2((z-1450)/105,(x-1510)/150)
    oasis=math.sqrt(((x-1510)/150)**2+((z-1450)/105)**2)/(1+.07*math.sin(oasisangle*4)+.06*math.cos(oasisangle*3))
    canyon=mix(max(canyon,25),canyon,smooth(1.8,2.5,oasis))
    canyon=mix(12,canyon,smooth(.76,1.17,oasis))
    canyon=mix(canyon,30,rectmask(x,z,1280,1450,1600,1830,50))
    tx=smooth(650,950,x);tz=smooth(650,950,z)
    h=mix(mix(meadow,harbor,tx),mix(alpine,canyon,tx),tz)
    edge=min(x+800,2400-x,z+800,2400-z)
    return mix(-18,h,smooth(0,135,edge))
def ground(x,z):
    # Same 10 m triangulation as the exported render surface and flight contact.
    gx=math.floor((x+800)/10);gz=math.floor((z+800)/10)
    vx=gx*10-800;vz=gz*10-800;tx=(x-vx)/10;tz=(z-vz)/10
    a=raw_ground(vx,vz);b=raw_ground(vx,vz+10);d=raw_ground(vx+10,vz)
    if tx+tz<=1:return a+(d-a)*tx+(b-a)*tz
    c=raw_ground(vx+10,vz+10);return c+(b-c)*(1-tx)+(d-c)*(1-tz)
def linear(v): return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
def color(hexcolor):
    if isinstance(hexcolor,(list,tuple)):return tuple(linear(v) for v in hexcolor[:3])
    s=hexcolor.lstrip('#');return tuple(linear(int(s[i:i+2],16)/255) for i in (0,2,4))
def xyz(v):return (v[0],-v[2],v[1])

class Context:
    def __init__(self,region):
        self.region=region;self.meshes={};self.materials={};self.entries=[];self.buildings=[]
        self.current=bpy.data.collections.new(region);bpy.context.scene.collection.children.link(self.current)
        for name,c in PALETTE.items():self.material(name,c,.8 if name!='water' else .2,.15 if name in ('metal','glass','water') else 0)
    def collection(self,name):
        c=bpy.data.collections.new(self.region+'/'+name);bpy.context.scene.collection.children.link(c);self.current=c;return c
    def material(self,name,hexcolor,roughness=.8,metallic=0):
        if name in self.materials:return name
        m=bpy.data.materials.new(name);m.diffuse_color=(*color(hexcolor),1);m.use_nodes=True
        bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=m.diffuse_color
        bs.inputs['Roughness'].default_value=roughness;bs.inputs['Metallic'].default_value=metallic
        m.use_backface_culling=False;self.materials[name]=m;return name
    def _object(self,name,data,material,pos=(0,0,0),scale=(1,1,1),yaw=0):
        key=(data.name,material)
        if key not in self.meshes:
            cp=data.copy();cp.name=data.name+'/'+material;cp.materials.clear();cp.materials.append(self.materials[material]);self.meshes[key]=cp
        o=bpy.data.objects.new(self.region+'/'+name,self.meshes[key]);self.current.objects.link(o)
        o.location=xyz(pos);o.scale=(scale[0],scale[2],scale[1]);o.rotation_euler.z=-yaw
        o['semantic_id']=self.region+'/'+name;o['material_role']=material
        self.entries.append({'id':o.name,'mesh':o.data.name,'material':material,'position':list(pos)})
        return o
    def mesh(self,name,vertices,faces,material):
        data=bpy.data.meshes.new(name);data.from_pydata([xyz(v) for v in vertices],[],faces);data.update()
        return self._object(name,data,material)
    def box(self,name,x,y,z,w,h,d,material,yaw=0):
        if '_box' not in self.meshes:
            verts=[(a/2,b/2,c/2) for a,b,c in [(-1,-1,-1),(-1,-1,1),(-1,1,-1),(-1,1,1),(1,-1,-1),(1,-1,1),(1,1,-1),(1,1,1)]]
            faces=[(0,4,6,2),(1,3,7,5),(0,1,5,4),(2,6,7,3),(0,2,3,1),(4,5,7,6)]
            data=bpy.data.meshes.new('UnitBlock');data.from_pydata([xyz(v) for v in verts],[],[tuple(reversed(f)) for f in faces]);data.update();self.meshes['_box']=data
        return self._object(name,self.meshes['_box'],material,(x,y,z),(w,h,d),yaw)
    def cyl(self,name,x,y,z,radius,height,material,vertices=12,top=None):
        ratio=1 if top is None else top/radius;key=('cylinder',vertices,round(ratio,5))
        if key not in self.meshes:
            verts=[(math.cos(i*math.tau/vertices)*r,h,math.sin(i*math.tau/vertices)*r) for h,r in [(-.5,1),(.5,ratio)] for i in range(vertices)]
            faces=[tuple(range(vertices)),tuple(range(vertices*2-1,vertices-1,-1))]+[(i,i+vertices,(i+1)%vertices+vertices,(i+1)%vertices) for i in range(vertices)]
            if ratio==0:
                verts=verts[:vertices]+[(0,.5,0)]
                faces=[tuple(range(vertices))]+[(i,vertices,(i+1)%vertices) for i in range(vertices)]
            data=bpy.data.meshes.new('Cylinder');data.from_pydata([xyz(v) for v in verts],[],faces);data.update();self.meshes[key]=data
        return self._object(name,self.meshes[key],material,(x,y,z),(radius,height,radius))
    def beam(self,name,a,b,r,material):
        a=Vector(xyz(a));b=Vector(xyz(b));delta=b-a
        o=self.cyl(name,0,0,0,r,delta.length,material,8);o.location=(a+b)/2;o.rotation_euler=delta.to_track_quat('Z','Y').to_euler();return o
    ground=staticmethod(ground)
    def path(self,name,points,width,material,lift=.08):
        from repair_routes import RouteSurfaceLayers
        import json
        vertices=[];faces=[]
        segments=[]
        for seg in range(len(points)-1):
            a=points[seg];b=points[seg+1];dx=b[0]-a[0];dz=b[1]-a[1];length=math.hypot(dx,dz)
            if length<.01:continue
            count=max(1,math.ceil(length/5));nx=-dz/length*width/2;nz=dx/length*width/2
            offset=len(vertices);face_offset=len(faces)
            for i in range(count+1):
                x=a[0]+dx*i/count;z=a[1]+dz*i/count
                for sign in (-1,1):
                    px=x+nx*sign;pz=z+nz*sign;vertices.append((px,ground(px,pz)+lift,pz))
            for i in range(count):
                k=offset+i*2;faces.extend([(k,k+1,k+2),(k+1,k+3,k+2)])
            segments.append((offset,len(vertices),face_offset,len(faces)))
        if not hasattr(self,'_route_surface_layers'):self._route_surface_layers=RouteSurfaceLayers()
        vertices,overlaps=self._route_surface_layers.apply(name,vertices,faces,segments)
        obj=self.mesh(name,vertices,faces,material)
        obj['route_surface_offsets']=json.dumps({str(item['segment']):item['offsetMeters'] for item in overlaps if item['offsetMeters']},sort_keys=True)
        obj['route_surface_repair']='Positive-area coplanar overlap graph; 4.3 mm per surface layer'
        layers=[self._route_surface_layers.groups[len(self._route_surface_layers.groups)-len(segments)+i]['layer'] for i in range(len(segments))]
        obj['ground_route']=True;obj['route_layer']=max(layers,default=0);obj['route_segment_layers']=layers
        return obj
    def rock(self,name,x,z,size,material='rock'):
        key=('_rock',int(abs(x+z))%4)
        if key not in self.meshes:
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=1);o=bpy.context.object
            r=random.Random(key[1]+74)
            for v in o.data.vertices:v.co*=r.uniform(.83,1.13)
            data=o.data;bpy.data.objects.remove(o,do_unlink=True);self.meshes[key]=data
        return self._object(name,self.meshes[key],material,(x,ground(x,z)+size*.31,z),(size,size*.6,size*.82),x+z)
    def tree(self,name,x,z,height,style='oak'):
        from detailed_vegetation import tree
        return tree(self,name,x,z,height,style)
    def building(self,name,x,z,w,d,h,material,roofmat,yaw=0,style='mediterranean'):
        from detailed_architecture import build_building
        return build_building(self,name,x,z,w,d,h,material,roofmat,yaw,style)


def terrain(ctx,bounds):
    x0,z0=bounds;N=161;vertices=[];faces=[];colors=[]
    for iz in range(N):
        for ix in range(N):
            x=x0+ix*10;z=z0+iz*10;h=raw_ground(x,z);vertices.append((x,h,z))
            tx=smooth(650,950,x);tz=smooth(650,950,z)
            base=[mix(mix(a,b,tx),mix(c,d,tx),tz) for a,b,c,d in zip(color('718947'),color('a39c77'),color('697b62'),color('bd8250'))]
            if tz>.5 and tx<.5:
                snow=smooth(160,225,h);base=[mix(v,s,snow) for v,s in zip(base,color('e1e8df'))]
            if h<1:base=[mix(v,s,smooth(2,-10,h)) for v,s in zip(base,color('bdb090'))]
            variation=1+.065*math.sin(x*.19)*math.cos(z*.23)+.07*math.sin(x*.035+math.cos(z*.042)*2)
            colors.append((*[max(0,v*variation) for v in base],1))
    for iz in range(N-1):
        for ix in range(N-1):
            a=iz*N+ix;b=a+N;d=a+1;c=b+1;faces.extend([(a,b,d),(d,b,c)])
    o=ctx.mesh('continuous-terrain',vertices,faces,'cream');m=o.data.materials[0].copy();m.name='TerrainVertexColor';o.data.materials[0]=m
    m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(1,1,1,1)
    node=m.node_tree.nodes.new('ShaderNodeVertexColor');node.layer_name='Color';m.node_tree.links.new(node.outputs['Color'],m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
    attr=o.data.color_attributes.new(name='Color',type='FLOAT_COLOR',domain='POINT')
    for item,col in zip(attr.data,colors):item.color=col
    for p in o.data.polygons:p.use_smooth=True
    from ground_detail import terrain_finish
    terrain_finish(o)
    return o
