"""Subdivide original ground routes against the exact terrain, without dependencies.

The pure functions use world Y-up coordinates. Blender is imported only by the
adapter. No source objects, identities, materials or positive-area route surfaces
are removed; the old plane is a lower bound, preserving raised contact ramps.
"""
import json
import math
import struct


def _area(a, b, c):
    return ((b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]))/2


def _f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def _clip(polygon, nx, nz, limit):
    """Sutherland-Hodgman clipping, carrying original triangle barycentrics."""
    if not polygon:
        return []
    result=[]
    previous=polygon[-1]
    old=previous[0]*nx+previous[2]*nz-limit
    for current in polygon:
        new=current[0]*nx+current[2]*nz-limit
        if (old <= 0) != (new <= 0):
            t=old/(old-new)
            point=tuple(a+(b-a)*t for a,b in zip(previous,current))
            # Exact clipping-plane coordinates prevent duplicate grid slivers.
            if nx and not nz:point=(limit/nx,point[1],point[2],*point[3:])
            elif nz and not nx:point=(point[0],point[1],limit/nz,*point[3:])
            else:point=(point[0],point[1],(limit-nx*point[0])/nz,*point[3:])
            result.append(point)
        if new <= 0:result.append(current)
        previous,old=current,new
    clean=[]
    for point in result:
        if not clean or (point[0],point[2]) != (clean[-1][0],clean[-1][2]):clean.append(point)
    if len(clean)>1 and (clean[0][0],clean[0][2]) == (clean[-1][0],clean[-1][2]):clean.pop()
    return clean


def fit_triangle(triangle, ground, minimum_lift=.08, cell_size=10, origin=-800, fixed_lift=None):
    """Return full terrain-cell fragments, preserving source barycentric bindings.

    A fragment lies in one terrain plane. Linear interpolation of the maximum of
    that plane and the original plane cannot descend below either plane. Thus
    checking fragment vertices proves contact over the entire continuous face.
    """
    original_area=abs(_area(*triangle))
    if original_area==0:
        return {'vertices':[tuple(p) for p in triangle], 'weights':[(1,0,0),(0,1,0),(0,0,1)],
                'faces':[(0,1,2)],'sourceArea':0,'resultArea':0,'previousPenetration':0,
                'minimumLift':0,'minimumClearance':None,'preservedZeroProjection':True}
    lift=(max(minimum_lift,min(p[1]-ground(p[0],p[2]) for p in triangle))
          if fixed_lift is None else fixed_lift)
    polygon=[(*p,*[float(i==j) for j in range(3)]) for i,p in enumerate(triangle)]
    xs=[p[0] for p in triangle];zs=[p[2] for p in triangle]
    gx0=math.floor((min(xs)-origin)/cell_size);gx1=math.floor((max(xs)-origin)/cell_size)
    gz0=math.floor((min(zs)-origin)/cell_size);gz1=math.floor((max(zs)-origin)/cell_size)
    vertices=[];weights=[];faces=[];previous_penetration=0;minimum_clearance=math.inf
    orientation=1 if _area(*triangle)>0 else -1
    for gx in range(gx0,gx1+1):
        x0=origin+gx*cell_size
        for gz in range(gz0,gz1+1):
            z0=origin+gz*cell_size
            cell=polygon
            for nx,nz,limit in ((-1,0,-x0),(1,0,x0+cell_size),(0,-1,-z0),(0,1,z0+cell_size)):
                cell=_clip(cell,nx,nz,limit)
                if len(cell)<3:break
            if len(cell)<3:continue
            diagonal=x0+z0+cell_size
            for side in (1,-1):
                fragment=_clip(cell,side,side,side*diagonal)
                if len(fragment)<3:continue
                # A fan partitions the convex clipped polygon without overlap.
                local_faces=[]
                for i in range(1,len(fragment)-1):
                    area=_area(fragment[0],fragment[i],fragment[i+1])
                    if area==0:continue
                    local_faces.append((0,i,i+1) if area*orientation>0 else (0,i+1,i))
                if not local_faces:continue
                offset=len(vertices)
                for p in fragment:
                    terrain=ground(p[0],p[2])
                    previous_penetration=max(previous_penetration,terrain-p[1])
                    y=max(p[1],terrain+lift)
                    vertices.append((p[0],y,p[2]));weights.append(p[3:])
                    minimum_clearance=min(minimum_clearance,y-terrain)
                faces.extend(tuple(offset+i for i in f) for f in local_faces)
    result_area=sum(abs(_area(*(vertices[i] for i in f))) for f in faces)
    if abs(result_area-original_area)>max(1e-8,original_area*1e-9):
        raise ValueError('Terrain clipping changed positive route area: '+repr((original_area,result_area)))
    return {'vertices':vertices,'weights':weights,'faces':faces,'sourceArea':original_area,
            'resultArea':result_area,'previousPenetration':previous_penetration,
            'minimumLift':lift,'minimumClearance':minimum_clearance}


def fit_mesh(vertices, triangles, ground, minimum_lift=.08):
    """Pure full-mesh repair, returning source-corner bindings for every vertex."""
    output=[];faces=[];bindings=[];sources=[];before_area=0;after_area=0
    max_penetration=0;minimum_clearance=math.inf;source_plane_loss=0
    zero_before=0;zero_after=0;f32_zero=0;f32_inverted=0;float32_min=math.inf
    # One datum for the entire original road keeps neighboring source triangles
    # continuous, including where a supported contact ramp has raised vertices.
    lift=max(minimum_lift,min((p[1]-ground(p[0],p[2]) for p in vertices),default=minimum_lift))
    for source_index,indices in enumerate(triangles):
        triangle=[vertices[i] for i in indices]
        fitted=fit_triangle(triangle,ground,minimum_lift,fixed_lift=lift)
        offset=len(output);output.extend(fitted['vertices'])
        bindings.extend((source_index,w) for w in fitted['weights'])
        faces.extend(tuple(offset+i for i in f) for f in fitted['faces'])
        sources.extend([source_index]*len(fitted['faces']))
        before_area+=fitted['sourceArea'];after_area+=fitted['resultArea']
        max_penetration=max(max_penetration,fitted['previousPenetration'])
        zero_before+=int(fitted['sourceArea']==0)
        if fitted['minimumClearance'] is not None:minimum_clearance=min(minimum_clearance,fitted['minimumClearance'])
        for p,w in zip(fitted['vertices'],fitted['weights']):
            original_y=sum(v[1]*k for v,k in zip(triangle,w))
            source_plane_loss=max(source_plane_loss,original_y-p[1])
            q=tuple(_f32(v) for v in p)
            float32_min=min(float32_min,q[1]-ground(q[0],q[2]))
        for face in fitted['faces']:
            vv=[fitted['vertices'][i] for i in face]
            zero_after+=int(_area(*vv)==0)
            q=[tuple(_f32(v) for v in p) for p in vv]
            # Full 3D cross product, because original vertical surfaces are legal.
            ab=[q[1][i]-q[0][i] for i in range(3)];ac=[q[2][i]-q[0][i] for i in range(3)]
            normal=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]]
            f32_zero+=int(all(v==0 for v in normal))
            f32_inverted+=int(_area(*q)*_area(*triangle)<0)
    report={'sourceTriangles':len(triangles),'resultTriangles':len(faces),
            'addedTriangles':len(faces)-len(triangles),'sourceProjectedArea':before_area,
            'resultProjectedArea':after_area,'projectedAreaDifference':after_area-before_area,
            'maxPreviousPenetrationMeters':max_penetration,'minimumClearanceMeters':minimum_clearance,
            'float32MinimumVertexClearanceMeters':float32_min,'maxOriginalPlaneLossMeters':source_plane_loss,
            'sourceZeroProjectionTriangles':zero_before,'resultZeroProjectionTriangles':zero_after,
            'float32ZeroAreaTriangles':f32_zero,'facesDropped':0,
            'float32InvertedTriangles':f32_inverted,'maxRemainingPenetrationMeters':max(0,-minimum_clearance),
            'preservedRouteLiftMeters':lift,
            'continuousContactProven':minimum_clearance>=minimum_lift-1e-9 and zero_before==0}
    return {'vertices':output,'faces':faces,'bindings':bindings,'sourceTriangles':sources,'report':report}


def fit_ground_routes(ctx, dry_run=False):
    """Fit original source route meshes in place, preserving objects and attributes.

    New leveled /Network/ roads and their solid supports are deliberately excluded.
    With dry_run=True no Blender datablock or source file is modified.
    """
    import bpy
    from mathutils import Vector
    ground=ctx.ground
    reports=[]
    objects=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.get('ground_route')
             and '/Network/' not in o.name]
    for obj in objects:
        if obj.get('terrain_route_fit'):
            reports.append({'id':obj.name,**json.loads(obj['terrain_route_fit_report']),'alreadyFitted':True})
            continue
        mesh=obj.data;mesh.calc_loop_triangles()
        loops=list(mesh.loop_triangles)
        world=[obj.matrix_world@v.co for v in mesh.vertices]
        vertices=[(v.x,v.z,-v.y) for v in world]
        triangles=[tuple(t.vertices) for t in loops]
        result=fit_mesh(vertices,triangles,ground)
        report={'id':obj.name,**result['report']}
        reports.append(report)
        if dry_run:continue
        if report['float32ZeroAreaTriangles'] or report['float32InvertedTriangles']:
            raise ValueError('Terrain route subdivision has invalid float32 faces: '+obj.name+' '+str(report))
        replacement=bpy.data.meshes.new(mesh.name+'/TerrainContact')
        inverse=obj.matrix_world.inverted()
        local=[inverse@Vector((x,-z,y)) for x,y,z in result['vertices']]
        replacement.from_pydata(local,[],result['faces'])
        for material in mesh.materials:replacement.materials.append(material)
        for key in mesh.keys():replacement[key]=mesh[key]
        for face,index in zip(replacement.polygons,result['sourceTriangles']):
            original=mesh.polygons[loops[index].polygon_index]
            face.material_index=original.material_index;face.use_smooth=original.use_smooth
        # Preserve every source UV layer with original-corner interpolation.
        for layer in mesh.uv_layers:
            target=replacement.uv_layers.new(name=layer.name)
            for loop in replacement.loops:
                source,weights=result['bindings'][loop.vertex_index]
                corners=loops[source].loops
                target.data[loop.index].uv=tuple(sum(layer.data[i].uv[c]*w for i,w in zip(corners,weights)) for c in range(2))
        # Route color layers may be POINT or CORNER; retain their original domain.
        for attribute in mesh.color_attributes:
            if attribute.domain not in ('POINT','CORNER'):continue
            target=replacement.color_attributes.new(name=attribute.name,type=attribute.data_type,domain=attribute.domain)
            elements=range(len(replacement.vertices)) if attribute.domain=='POINT' else range(len(replacement.loops))
            for i in elements:
                vertex=i if attribute.domain=='POINT' else replacement.loops[i].vertex_index
                source,weights=result['bindings'][vertex]
                corners=triangles[source] if attribute.domain=='POINT' else loops[source].loops
                target.data[i].color=tuple(sum(attribute.data[j].color[c]*w for j,w in zip(corners,weights)) for c in range(4))
        if mesh.uv_layers.active and replacement.uv_layers:
            replacement.uv_layers.active_index=mesh.uv_layers.active_index
        if mesh.color_attributes.active_color:
            replacement.color_attributes.active_color_name=mesh.color_attributes.active_color.name
        replacement.update()
        obj.data=replacement
        obj['terrain_route_fit']='Exact terrain-cell and diagonal clipping; original plane preserved'
        obj['terrain_route_fit_report']=json.dumps(report,separators=(',',':'))
        if mesh.users==0:bpy.data.meshes.remove(mesh)
    return {'method':'Exact 10m terrain triangle clipping; maximum of original plane and ground plus original lift (minimum 0.08m)',
            'dryRun':dry_run,'objects':len(reports),'objectsAdded':0,'objectsRemoved':0,
            'addedTriangles':sum(r['addedTriangles'] for r in reports),
            'maxPreviousPenetrationMeters':max((r['maxPreviousPenetrationMeters'] for r in reports),default=0),
            'maxAreaDifferenceSquareMeters':max((abs(r['projectedAreaDifference']) for r in reports),default=0),
            'float32ZeroAreaTriangles':sum(r['float32ZeroAreaTriangles'] for r in reports),
            'maxRemainingPenetrationMeters':max((r['maxRemainingPenetrationMeters'] for r in reports),default=0),
            'routes':reports}
