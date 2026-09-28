"""Authored settlement and agricultural assemblies from the shared regional network.

Existing complete houses are rigidly instanced with every editable component and
material intact. New support foundations follow the receiving parcel. Crop kits
are actual stems, leaves, fruit and trellises, shared without reduced variants.
"""
import copy
import hashlib
import math
import random


def local_point(center, u, v, yaw=0):
    c, s = math.cos(yaw), math.sin(yaw)
    return [center[0]+u*c+v*s, center[1]-u*s+v*c]


def relocate_intact_props(ctx, plan):
    """Move explicitly planned loose props; preserve their complete mesh data."""
    import bpy
    from mathutils import Vector
    entries = {entry['id']: entry for entry in ctx.entries}
    report = []
    for item in plan.get('relocations', []):
        obj = bpy.data.objects.get(item['id'])
        if obj is None or obj.type != 'MESH' or item['id'] not in entries:
            raise RuntimeError('Missing planned intact prop: ' + item['id'])
        old = obj.matrix_world.translation.copy()
        old_position = [old.x, old.z, -old.y]
        x, z = item['destination']
        embedding = old.z - ctx.ground(old.x, -old.y)
        new_position = [x, ctx.ground(x, z) + embedding, z]
        data = obj.data
        vertices, polygons = len(data.vertices), len(data.polygons)
        transform = obj.matrix_world.copy()
        transform.translation = Vector((x, -z, new_position[1]))
        obj.matrix_world = transform
        entries[item['id']]['position'] = new_position
        obj['landuse_relocated'] = True
        obj['landuse_relocation_reason'] = item['reason']
        assert obj.data.as_pointer() == data.as_pointer() and len(data.vertices) == vertices and len(data.polygons) == polygons
        report.append({'id': obj.name, 'oldPosition': old_position, 'newPosition': new_position,
                       'reason': item['reason'], 'mesh': data.name, 'verticesPreserved': vertices,
                       'polygonsPreserved': polygons, 'groundEmbeddingPreserved': embedding})
    return report


def sample_line(points, spacing=2):
    points=[p for i,p in enumerate(points) if i==0 or math.dist(p,points[i-1])>1e-7]
    if len(points)<2:raise ValueError('A road needs two distinct points')
    result = []
    for a, b in zip(points, points[1:]):
        n = max(1, math.ceil(math.dist(a, b)/spacing))
        result.extend([[a[0]+(b[0]-a[0])*i/n, a[1]+(b[1]-a[1])*i/n] for i in range(n)])
    return result+[list(points[-1])]


def ribbon(ctx, name, points, width, material, lift=.1, lateral=0, elevations=None, solid=False, profile=None):
    """Exact non-overlapping beveled footprint with a grounded solid underside."""
    from road_ribbons import ribbon_geometry
    if profile is None:points = sample_line(points)
    geometry=ribbon_geometry(points,width,lateral,profile,ctx.ground,lift,elevations)
    vertices,faces=geometry['vertices'],geometry['faces']
    if solid:
        size=len(vertices)
        vertices.extend((x,ctx.ground(x,z)-.06,z) for x,y,z in vertices[:])
        faces.extend(tuple(size+i for i in reversed(f)) for f in faces[:])
        faces.extend((a,a+size,b+size,b) for a,b in geometry['boundaryEdges'])
    obj=ctx.mesh(name,vertices,faces,material)
    obj['ground_route']=True;obj['route_width_meters']=width
    obj['route_centerline']=str(points)
    obj['road_topology']='Exact beveled swept-footprint union; constrained triangles; grounded boundary sides'
    return obj


def surface_layer(ctx,route):
    from repair_routes import _area,_intersection,_bounds,_bbox_overlap
    if not hasattr(ctx,'_human_road_layers'):ctx._human_road_layers=[]
    half=route['width']/2+.8;polygons=[]
    for a,b in zip(route['points'],route['points'][1:]):
        length=math.dist(a,b)
        if length<.001:continue
        nx,nz=-(b[1]-a[1])/length*half,(b[0]-a[0])/length*half
        poly=[(a[0]-nx,a[1]-nz),(a[0]+nx,a[1]+nz),(b[0]+nx,b[1]+nz),(b[0]-nx,b[1]-nz)]
        polygons.append((poly,_bounds(poly)))
    forbidden=set()
    for old_polygons,layer in ctx._human_road_layers:
        if any(_bbox_overlap(bb,ob) and abs(_area(_intersection(p,q)))>1e-6
               for p,bb in polygons for q,ob in old_polygons):forbidden.add(layer)
    layer=0
    while layer in forbidden:layer+=1
    ctx._human_road_layers.append((polygons,layer))
    return layer


def road(ctx, route):
    name='Network/'+route['id'];points=route['points'];w=route['width'];kind=route['type']
    from regional_network_helpers import roadbed_profile
    section=roadbed_profile(route);points=section['points'];heights=section['heights']
    paved=kind in ('primary','regional','express','highway','town','road','secondary')
    material=route.get('material','asphalt' if paved else 'gravel')
    if material not in ctx.materials:material='gravel'
    paved=material=='asphalt'
    delta=surface_layer(ctx,route)*.009
    ribbon(ctx,name+'/graded-verge',points,w+1.6,'gravel',.065+delta,solid=True,profile=heights)
    surface=ribbon(ctx,name+'/surface',points,w,material,.145+delta,solid=True,profile=heights)
    surface['junction_separation_meters']=delta
    if paved and w>=6.5:
        for side in (-1,1):
            ribbon(ctx,name+f'/edge-line-{side}',points,.10,'network_road_mark',.163+delta,side*(w/2-.30),profile=heights)
        # Dashes follow the same sampled centreline; joint distances are global.
        vertices,faces=[],[];distance=0
        for index,(a,b) in enumerate(zip(points,points[1:])):
            length=math.dist(a,b)
            if int((distance+length/2)/4)%2==0:
                dx,dz=b[0]-a[0],b[1]-a[1];nx,nz=-dz/length*.06,dx/length*.06
                k=len(vertices)
                vertices.extend((x,heights[index+(j>=2)]+.169+delta,z) for j,(x,z) in enumerate(
                                ((a[0]-nx,a[1]-nz),(a[0]+nx,a[1]+nz),(b[0]+nx,b[1]+nz),(b[0]-nx,b[1]-nz))))
                faces.append((k,k+1,k+2,k+3))
            distance+=length
        ctx.mesh(name+'/center-dashes',vertices,faces,'network_road_mark')


def blend_existing_contacts(ctx,biome):
    """Join old source roads to the new supported network, preserving their faces."""
    import bpy,json
    from pathlib import Path
    from regional_network_helpers import _segment_intersections,roadbed_profile
    from regional_network_plan import PLAN
    directory=Path(__file__).resolve().parents[2]/'artifacts/four-horizons'/biome
    source=directory/'landscape_reservations_before_human_layer.json'
    if not source.exists():return []
    old_routes=json.loads(source.read_text())['paths']
    new_routes=[r for region in PLAN.values() for r in region['routes'] if r['type']!='entry']
    profiles={};report=[]
    for old in old_routes:
        obj=bpy.data.objects.get(old['id'])
        if obj is None or obj.type!='MESH':continue
        contacts=[]
        for new in new_routes:
            hits=[p for a,b in zip(old['points'],old['points'][1:]) for c,d in zip(new['points'],new['points'][1:])
                  for p in _segment_intersections(a,b,c,d)]
            if not hits:continue
            if new['id'] not in profiles:profiles[new['id']]=roadbed_profile(new)
            profile=profiles[new['id']]
            for p in hits:
                index=min(range(len(profile['points'])),key=lambda i:math.dist(p,profile['points'][i]))
                contacts.append((p,profile['heights'][index]+.151,new['width']/2+1))
        if not contacts:continue
        before=[tuple(v.co) for v in obj.data.vertices];moved=0;maximum=0
        for v in obj.data.vertices:
            x,z=v.co.x,-v.co.y;target=v.co.z
            for p,height,radius in contacts:
                distance=math.dist((x,z),p)
                if distance>=radius+12:continue
                t=max(0,min(1,(radius+12-distance)/12));t=t*t*(3-2*t)
                target=max(target,v.co.z+(height-v.co.z)*t)
            if target-v.co.z>1e-6:maximum=max(maximum,target-v.co.z);moved+=1;v.co.z=target
        if not moved:continue
        obj.data.update();obj['supported_network_contact']=True
        edges={}
        for face in obj.data.polygons:
            vv=list(face.vertices)
            for a,b in zip(vv,vv[1:]+vv[:1]):
                key=tuple(sorted((a,b)));edges[key]=edges.get(key,0)+1
        verts=[];faces=[]
        for (a,b),count in edges.items():
            if count!=1:continue
            va,vb=obj.data.vertices[a].co,obj.data.vertices[b].co
            if max(va.z-before[a][2],vb.z-before[b][2])<1e-6:continue
            k=len(verts)
            verts.extend([(va.x,va.z,-va.y),(vb.x,vb.z,-vb.y),
                          (vb.x,ctx.ground(vb.x,-vb.y)-.05,-vb.y),
                          (va.x,ctx.ground(va.x,-va.y)-.05,-va.y)])
            faces.append((k,k+1,k+2,k+3))
        if faces:ctx.mesh('Network/ExistingContactSupport/'+old['id'].split('/',1)[1],verts,faces,'stone')
        report.append({'id':old['id'],'verticesRaised':moved,'maximumRaiseMeters':maximum,'contacts':len(contacts)})
    return report


def clone_building(ctx, parcel, originals):
    import bpy
    from mathutils import Matrix, Vector
    from layout_datums import entry_anchor
    from detailed_architecture import Assembly
    original=originals[parcel['prototypeId']]
    x,z=parcel.get('center',[parcel.get('x'),parcel.get('z')]);yaw=parcel['yaw']
    w,h,d=original['dimensions'];corners=[local_point([x,z],u,v,yaw) for u in (-w/2,w/2) for v in (-d/2,d/2)]
    if 'w' in parcel and any(abs(a-b)>1e-8 for a,b in zip((w,h,d),(parcel['w'],parcel['h'],parcel['d']))):
        raise ValueError('Parcel dimensions differ from its intact architecture prototype')
    base=max(ctx.ground(*p) for p in corners)+.04
    lowest=min(ctx.ground(*p) for p in corners)-.14
    ox,oz=original['center'];obase=original['ground'];oyaw=original['yaw']
    transform=Matrix.Translation((x,-z,base)) @ Matrix.Rotation(-yaw+oyaw,4,'Z') @ Matrix.Translation((-ox,oz,-obase))
    name='Settlement/'+parcel['id'];prefix=ctx.region+'/'+name
    components=[];triangles=0;material='stone'
    for oldname in original['editableComponents']:
        old=bpy.data.objects.get(oldname)
        if old is None:raise RuntimeError('Missing full-detail building component: '+oldname)
        role=old.get('component_role','')
        if role.startswith('foundation/'):
            if old.data.materials:
                material=old.data.materials[0].name
            continue
        obj=old.copy();obj.data=old.data
        obj.name=prefix+oldname[len(original['id']):]
        ctx.current.objects.link(obj);obj.matrix_world=transform @ old.matrix_world
        obj['semantic_id']=obj.name;obj['building_id']=prefix;obj['source_prototype']=original['id']
        obj['parcel_id']=parcel['id'];components.append(obj.name)
        ctx.entries.append({'id':obj.name,'mesh':obj.data.name,'material':obj.get('material_role','architecture'),
                            'position':[x,base,z],'prototype':original['id'],'components':role})
    a=Assembly(ctx,name,x,z,base,yaw)
    a.box('foundation/continuous-footing',(0,(lowest-base+.14)/2,0),(w+.18,base+.14-lowest,d+.18),material,bevel=.028)
    components+=a.finish(original['family'])
    record=copy.deepcopy(original)
    record.update(id=prefix,center=[x,z],yaw=yaw,ground=base,editableComponents=components,
                  prototypeId=original['id'],parcelId=parcel['id'],
                  entryAnchor=entry_anchor(x,z,w,d,yaw),doorCenter=entry_anchor(x,z,w,d,yaw,0))
    ctx.buildings.append(record)
    return record


def crop_prototype(ctx, crop, variant=0):
    import bpy
    from mathutils import Vector
    import detailed_vegetation as bot
    bot._runtime()
    key=('landuse-crop',crop,variant)
    if key in ctx.meshes:return ctx.meshes[key]
    rng=random.Random(52017+variant)
    mesh=bot.Mesh()
    if crop=='orchard':
        mats=[ctx.materials[x] for x in ('timber','network_olive_leaf','leaf_light','network_grape')]
        mesh.tube([(0,0,0),(.06,.03,.8),(-.06,0,1.7),(.03,0,2.4)],[.15,.12,.09,.04],10,0)
        for branch in range(9):
            angle=branch*2.3999;h=1.5+(branch%3)*.4
            mid=Vector((math.cos(angle)*.65,math.sin(angle)*.65,h+.35))
            tip=Vector((math.cos(angle)*1.25,math.sin(angle)*1.25,h+.9))
            mesh.tube([(0,0,h),mid,tip],[.065,.041,.013],8,0)
            for twig in range(7):
                aa=angle+twig*1.61;start=mid.lerp(tip,twig/7)
                end=start+Vector((math.cos(aa)*.52,math.sin(aa)*.52,.38))
                mesh.tube([start,end],[.012,.003],6,0)
                for leaf in range(55):
                    p=end+Vector((rng.uniform(-.32,.32),rng.uniform(-.32,.32),rng.uniform(-.23,.23)))
                    mesh.leaf(p,(math.cos(aa+leaf),math.sin(aa+leaf),.25),rng.uniform(.065,.095),.027,.1,1+leaf%2)
    elif crop in ('pasture','hay'):
        mats=[ctx.materials[x] for x in ('leaf_green','leaf_light','network_stalk','grass')]
        for j in range(85):
            mesh.blade((rng.uniform(-.49,.49),rng.uniform(-.49,.49),0),rng.random()*math.tau,
                       rng.uniform(.20,.48),.012,rng.uniform(.06,.19),j%4,9)
    elif crop=='vineyard':
        mats=[ctx.materials[x] for x in ('timber','network_vine_leaf','leaf_light','network_grape')]
        mesh.tube([(0,0,0),(.025,.02,.48),(-.02,0,1.15)],[.035,.029,.022],8,0)
        for sign in (-1,1):
            branch=[(-.02,0,1.12),(sign*.32,.01,1.24),(sign*.71,.015,1.25)]
            mesh.tube(branch,[.021,.014,.007],7,0)
            for i in range(8):
                px=sign*(.07+i*.085);side=-1 if i%2 else 1;shoot=rng.uniform(.40,.77)
                bend=rng.uniform(-.13,.13)
                mesh.tube([(px,0,1.22),(px+bend,side*.10,1.22+shoot*.52),
                           (px+bend*.6,side*.14,1.22+shoot)],[.008,.005,.0025],6,0)
                for leaf in range(6):
                    t=.20+leaf*.13;angle=i*2.399+leaf*2.7+variant*.45
                    axis=Vector((math.cos(angle),math.sin(angle),rng.uniform(-.35,.40)))
                    anchor=Vector((px+bend*t,side*.14*t,1.22+shoot*t))
                    mesh.tube([anchor,anchor+axis*.095],[.003,.0016],5,0)
                    mesh.leaf(anchor+axis*.17,axis,.27+rng.random()*.07,.26+rng.random()*.08,
                              rng.uniform(-.5,.5),1+(i+leaf)%2,True)
            for bunch in range(2):
                xx=sign*(.23+bunch*.25)
                for level in range(4):
                    for j in range(5-level):
                        angle=j*math.tau/(5-level)+level*.31
                        cx,cy,cz=xx+math.cos(angle)*(.045-level*.007),math.sin(angle)*(.045-level*.007),1.18-level*.035
                        # Individual round grape berries with a full closed shell.
                        verts=[(cx+math.sin(a*math.pi/4)*math.cos(b*math.tau/7)*.025,
                                cy+math.sin(a*math.pi/4)*math.sin(b*math.tau/7)*.025,
                                cz+math.cos(a*math.pi/4)*.025) for a in range(1,4) for b in range(7)]
                        verts.extend([(cx,cy,cz+.025),(cx,cy,cz-.025)])
                        faces=[(21,b,(b+1)%7) for b in range(7)]+[(22,14+(b+1)%7,14+b) for b in range(7)]
                        faces += [(a*7+b,a*7+(b+1)%7,(a+1)*7+(b+1)%7,(a+1)*7+b) for a in range(2) for b in range(7)]
                        mesh.add(verts,faces,3,True)
    else:
        mats=[ctx.materials[x] for x in ('network_stalk','crop_gold','leaf_green','leaf_light')]
        for j in range(45):
            x,y=rng.uniform(-.48,.48),rng.uniform(-.48,.48);height=rng.uniform(.55,.92)
            if crop not in ('wheat','barley','grain','hay'):height=rng.uniform(.12,.22)
            mesh.tube([(x,y,0),(x+.025,y,height*.5),(x+.065,y+.015,height)],[.007,.004,.002],5,0)
            for sign in (-1,1):mesh.blade((x,y,height*.24),j+sign,height*.45,.023,.19,2+j%2,7)
            if crop in ('wheat','barley','grain','hay'):
                for level in range(7):
                    side=(-1)**level
                    mesh.leaf((x+.065+side*.025,y,height+.017*level),(side*.6,0,1),.065,.025,0,1)
            else:
                for leaf in range(5):
                    angle=leaf*2.3999
                    mesh.leaf((x+math.cos(angle)*.10,y+math.sin(angle)*.10,.16+leaf*.02),
                              (math.cos(angle),math.sin(angle),.35),.28,.16,0,2+leaf%2,True)
    data=mesh.finish('Landuse/'+crop+f'/variant-{variant}',mats);ctx.meshes[key]=data
    return data


def place_crop(ctx,name,data,x,z,yaw=0):
    import bpy
    obj=bpy.data.objects.new(ctx.region+'/'+name,data);ctx.current.objects.link(obj)
    obj.location=(x,-z,ctx.ground(x,z)+.06);obj.rotation_euler.z=-yaw
    obj['semantic_id']=obj.name;obj['material_role']='agriculture';obj['full_geometry_shadow']=True
    ctx.entries.append({'id':obj.name,'mesh':data.name,'material':'agriculture','position':[x,obj.location.z,z]})
    return obj


def crop_tile(ctx,crop,variant):
    import bpy
    key=('landuse-crop-tile',crop,variant)
    if key in ctx.meshes:return ctx.meshes[key]
    proto=crop_prototype(ctx,crop,variant);vertices=[];faces=[];slots=[];smooth=[]
    for iz in range(5):
        for ix in range(5):
            offset=len(vertices)
            vertices.extend((v.co.x+ix-2,v.co.y+iz-2,v.co.z) for v in proto.vertices)
            faces.extend(tuple(offset+i for i in f.vertices) for f in proto.polygons)
            slots.extend(f.material_index for f in proto.polygons);smooth.extend(f.use_smooth for f in proto.polygons)
    data=bpy.data.meshes.new(f'Landuse/{crop}/25-complete-patches-{variant}')
    data.from_pydata(vertices,[],faces)
    for mat in proto.materials:data.materials.append(mat)
    for f,slot,sm in zip(data.polygons,slots,smooth):f.material_index=slot;f.use_smooth=sm
    data.update();ctx.meshes[key]=data
    return data


def field(ctx, item):
    from ground_detail import crops
    name='Agriculture/'+item['id'];center=item['center'];w,d=item['width'],item['depth'];yaw=item.get('yaw',0)
    crop=item['crop'];vertices,faces=[],[]
    # Fine height samples retain the actual terrain profile across each parcel.
    nx,nz=math.ceil(w/2),math.ceil(d/2)
    for j in range(nz+1):
        for i in range(nx+1):
            x,z=local_point(center,-w/2+w*i/nx,-d/2+d*j/nz,yaw)
            vertices.append((x,ctx.ground(x,z)+.045,z))
    for j in range(nz):
        for i in range(nx):
            a=j*(nx+1)+i;b=a+nx+1
            faces.extend([(a,b,a+1),(a+1,b,b+1)])
    boundary=list(range(nx+1))+[j*(nx+1)+nx for j in range(1,nz+1)]+[nz*(nx+1)+i for i in range(nx-1,-1,-1)]+[j*(nx+1) for j in range(nz-1,0,-1)]
    bottom=len(vertices)
    vertices.extend((vertices[i][0],ctx.ground(vertices[i][0],vertices[i][2])-.04,vertices[i][2]) for i in boundary)
    for index,vertex in enumerate(boundary):
        next_index=(index+1)%len(boundary)
        faces.append((vertex,boundary[next_index],bottom+next_index,bottom+index))
    soil=ctx.mesh(name+'/cultivated-soil',vertices,faces,'network_soil')
    uv=soil.data.uv_layers.new(name='FieldMeters')
    for loop in soil.data.loops:
        v=soil.data.vertices[loop.vertex_index];uv.data[loop.index].uv=(v.co.x/2,-v.co.y/2)
    if item.get('waterStrategy'):
        x,z=local_point(center,-w/2+2.7,-d/2+3,yaw);g=ctx.ground(x,z)
        ctx.cyl(name+'/water-store/base',x,g+.05,z,1.48,.26,'stone',vertices=24)
        rings=[]
        for radius,height in ((1.4,.14),(1.4,1.55),(1.12,1.55),(1.12,.20)):
            rings.extend((x+math.cos(i*math.tau/24)*radius,g+height,z+math.sin(i*math.tau/24)*radius) for i in range(24))
        faces=[(ring*24+i,ring*24+(i+1)%24,(ring+1)*24+(i+1)%24,(ring+1)*24+i) for ring in range(3) for i in range(24)]
        ctx.mesh(name+'/water-store/masonry-wall',rings,faces,'stone')
        ctx.cyl(name+'/water-store/collected-water',x,g+.98,z,1.1,.02,'water',vertices=24)
        for side in (-1,1):ctx.box(name+f'/water-store/gantry-{side}',x+side*1.42,g+1.16,z,.14,2.32,.14,'timber')
        ctx.beam(name+'/water-store/crossbeam',(x-1.60,g+2.32,z),(x+1.60,g+2.32,z),.12,'timber')
        ctx.beam(name+'/water-store/rope',(x,g+2.32,z),(x,g+1.02,z),.022,'timber')
    if crop=='orchard':
        count=0
        for j in range(int((d-10)/6)):
            for i in range(int((w-10)/6)):
                x,z=local_point(center,-w/2+5+(i+.5)*6,-d/2+5+(j+.5)*6,yaw)
                place_crop(ctx,name+f'/olive-{i}-{j}',crop_prototype(ctx,crop,(i+j)%3),x,z,yaw+(i+j)*.8)
                count+=1
        return {'id':item['id'],'crop':crop,'trees':count}
    if crop=='vineyard':
        row_count=int((w-8)/3.1);plant_count=int((d-12)/1.65)
        for row in range(row_count):
            u=(row-(row_count-1)/2)*3.1
            for i in range(plant_count):
                v=(i-(plant_count-1)/2)*1.65;x,z=local_point(center,u,v,yaw)
                place_crop(ctx,name+f'/vine-{row}-{i}',crop_prototype(ctx,crop,i%3),x,z,yaw+math.pi/2)
            posts=[]
            for i in range(math.ceil((d-8)/6)+1):
                v=-d/2+4+min(d-8,i*6);x,z=local_point(center,u,v,yaw);g=ctx.ground(x,z)
                ctx.box(name+f'/trellis-{row}-{i}',x,g+.95,z,.115,1.9,.115,'timber',yaw)
                posts.append((x,g,z))
            for i,(a,b) in enumerate(zip(posts,posts[1:])):
                for h in (1.05,1.7):
                    ctx.beam(name+f'/wire-{row}-{i}-{h}',(a[0],a[1]+h,a[2]),(b[0],b[1]+h,b[2]),.008,'metal')
        return {'id':item['id'],'crop':crop,'rows':row_count,'plants':row_count*plant_count}
    # Crop patches have actual stems, curved leaves and ears, densely sown.
    step=5.0;count=0
    for j in range(int((d-6)/step)):
        for i in range(int((w-6)/step)):
            x,z=local_point(center,-w/2+3+(i+.5)*step,-d/2+3+(j+.5)*step,yaw)
            obj=place_crop(ctx,name+f'/crop-{i}-{j}',crop_tile(ctx,crop,(i+j)%3),x,z,yaw)
            from mathutils import Vector, Quaternion
            gx=(ctx.ground(x+2,z)-ctx.ground(x-2,z))/4;gz=(ctx.ground(x,z+2)-ctx.ground(x,z-2))/4
            obj.rotation_mode='QUATERNION'
            obj.rotation_quaternion=Vector((0,0,1)).rotation_difference(Vector((-gx,gz,1)).normalized()) @ Quaternion((0,0,1),-yaw)
            count+=(85 if crop in ('pasture','hay') else 45)*25
    return {'id':item['id'],'crop':crop,'modeledStemsOrBlades':count}


def build_network_roads(ctx,biome,plan,entry_levels):
    for route in plan['routes']:
        if route['type']!='entry':road(ctx,route)
    for route in plan['routes']:
        if route['type']=='entry':
            points=route['points'];start=entry_levels.get(route['id'],ctx.ground(*points[0])+.14)
            from regional_network_helpers import roadbed_profile
            end=roadbed_profile(route)['heights'][-1]+.145
            ribbon(ctx,'Network/'+route['id']+'/entry-ramp',points,route['width'],'gravel',.12,
                   elevations=[start,end],solid=True)
    return blend_existing_contacts(ctx,biome)


def build_human_landuse(ctx, biome, plan):
    ctx.collection('CONNECTED_SETTLEMENTS_AND_FARMLAND')
    for key,colour,roughness in [('network_road_mark','dedbd0',.87),('network_vine_leaf','406b35',.86),
                                ('network_grape','45405d',.45),('network_soil','72563b',.98),('network_stalk','a89556',.88),
                                ('network_olive_leaf','687653',.89)]:
        ctx.material(key,colour,roughness)
    from detailed_architecture import textured_material
    soil=textured_material(ctx,'network_soil','stone')
    # Keep the named soil slot linked to the packed physical-scale source texture.
    ctx.materials['network_soil']=ctx.materials[soil]
    originals={entry['id']:entry for entry in ctx.buildings}
    built=[];routes=plan.get('routes',[]);entry_levels={}
    for settlement in plan.get('settlements',[]):
        for parcel in settlement['buildings']:
            record=clone_building(ctx,parcel,originals);built.append(record)
            if parcel.get('entryRoute'):entry_levels[parcel['entryRoute']]=record['ground']+.14
        print('SETTLEMENT_BUILT',biome,settlement['id'],len(settlement['buildings']),flush=True)
    contacts=build_network_roads(ctx,biome,plan,entry_levels)
    fields=[field(ctx,item) for item in plan.get('fields',[])]
    return {'settlements':[{'id':s['id'],'center':s['center'],'buildings':len(s['buildings'])} for s in plan.get('settlements',[])],
            'buildings':len(built),'routes':len(routes),'routeLengthMeters':sum(sum(math.dist(a,b) for a,b in zip(r['points'],r['points'][1:])) for r in routes),
            'fields':fields,'houseGeometry':'All above-ground components rigidly shared from full-detail source; foundations fitted to destination parcel',
            'buildingIds':[b['id'] for b in built],'existingRoadContactSupports':contacts}
