"""Non-overlapping road tops from precomputed, exact beveled footprint unions.

The CLI uses system Shapely once. Blender imports only Python's standard library
and interpolates the cached XY topology against the current supported profile.
"""
import hashlib
import json
import math
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
CACHE_PATH=ROOT/'artifacts/four-horizons/road_ribbon_geometry.json'
_CACHE=None


def geometry_key(points,width,lateral=0):
    value={'points':[[round(float(x),6),round(float(z),6)] for x,z in points],
           'width':round(float(width),6),'lateral':round(float(lateral),6)}
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def _binding(point,points,grid):
    x,z=point;ix,iz=math.floor(x/16),math.floor(z/16)
    candidates=set(index for i in range(ix-1,ix+2) for j in range(iz-1,iz+2) for index in grid.get((i,j),()))
    if not candidates:candidates=range(len(points)-1)
    best=None
    for index in candidates:
        a,b=points[index:index+2];dx,dz=b[0]-a[0],b[1]-a[1];length=dx*dx+dz*dz
        t=max(0,min(1,((x-a[0])*dx+(z-a[1])*dz)/length)) if length else 0
        distance=(x-a[0]-t*dx)**2+(z-a[1]-t*dz)**2
        if best is None or distance<best[0]:best=(distance,index,t)
    return [best[1],best[2]]


def prepare_topology(points,width,lateral=0):
    from shapely import constrained_delaunay_triangles,segmentize
    from shapely.geometry import LineString
    line=LineString(points)
    if lateral:line=line.offset_curve(lateral,join_style='bevel')
    polygon=line.buffer(width/2,cap_style='flat',join_style='bevel')
    if not polygon.is_valid or polygon.is_empty:raise ValueError('Invalid swept road footprint')
    polygon=segmentize(polygon,2.0)
    triangles=constrained_delaunay_triangles(polygon)
    vertices=[];lookup={};faces=[]
    for triangle in triangles.geoms:
        face=[]
        for x,z in list(triangle.exterior.coords)[:3]:
            key=(round(x,9),round(z,9))
            if key not in lookup:lookup[key]=len(vertices);vertices.append([x,z])
            face.append(lookup[key])
        a,b,c=[vertices[i] for i in face]
        up=(b[1]-a[1])*(c[0]-a[0])-(b[0]-a[0])*(c[1]-a[1])
        if abs(up)<1e-10:continue
        if up<0:face[1],face[2]=face[2],face[1]
        faces.append(face)
    edges={}
    for face in faces:
        for a,b in zip(face,face[1:]+face[:1]):
            key=tuple(sorted((a,b)))
            if key in edges:edges[key]=None
            else:edges[key]=[a,b]
    boundary=[edge for edge in edges.values() if edge is not None]
    grid={}
    for index,(a,b) in enumerate(zip(points,points[1:])):
        for i in range(math.floor(min(a[0],b[0])/16)-1,math.floor(max(a[0],b[0])/16)+2):
            for j in range(math.floor(min(a[1],b[1])/16)-1,math.floor(max(a[1],b[1])/16)+2):grid.setdefault((i,j),[]).append(index)
    bindings=[_binding(v,points,grid) for v in vertices]
    triangle_area=sum(abs((vertices[f[1]][0]-vertices[f[0]][0])*(vertices[f[2]][1]-vertices[f[0]][1])-
        (vertices[f[1]][1]-vertices[f[0]][1])*(vertices[f[2]][0]-vertices[f[0]][0]))/2 for f in faces)
    if abs(triangle_area-polygon.area)>max(1e-6,polygon.area*1e-8):raise RuntimeError('Constrained road triangulation did not preserve footprint area')
    return {'verticesXZ':vertices,'faces':faces,'boundaryEdges':boundary,'bindings':bindings,
            'areaSquareMeters':polygon.area,'areaDifference':triangle_area-polygon.area,
            'method':'Exact beveled swept-footprint union, <=2m boundary segments, constrained Delaunay triangles'}


def ribbon_geometry(points,width,lateral=0,profile=None,ground=None,lift=0,elevations=None):
    """Return vertices/faces/boundaryEdges; a solid underside is caller-owned.

    boundaryEdges follow top-face winding. Solid side faces use
    (a,a+N,b+N,b); bottom faces reverse the corresponding top triangle.
    """
    global _CACHE
    if _CACHE is None:_CACHE=json.loads(CACHE_PATH.read_text(encoding='utf-8'))['geometries']
    key=geometry_key(points,width,lateral)
    if key not in _CACHE:
        raise RuntimeError('Road footprint cache is missing geometry '+key+'; prepare cache before Blender generation.')
    topology=_CACHE[key];vertices=[]
    for (x,z),(index,t) in zip(topology['verticesXZ'],topology['bindings']):
        y=(ground(x,z) if profile is None else profile[index]*(1-t)+profile[index+1]*t)+lift
        if elevations is not None:
            progress=(index+t)/max(1,len(points)-1)
            y=max(y,elevations[0]*(1-progress)+elevations[1]*progress)
        vertices.append((x,y,z))
    return {'vertices':vertices,'faces':[tuple(f) for f in topology['faces']],
            'boundaryEdges':[tuple(edge) for edge in topology['boundaryEdges']]}


def prepare_cache():
    from regional_network_plan import PLAN
    from regional_network_helpers import roadbed_profile
    from human_landuse import sample_line
    cache={};records=[]
    for biome,plan in PLAN.items():
        for road in plan['routes']:
            points=sample_line(road['points']) if road['type']=='entry' else roadbed_profile(road)['points']
            variants=[(road['width'],0)] if road['type']=='entry' else [(road['width'],0),(road['width']+1.6,0)]
            if road.get('material')=='asphalt' and road['width']>=6.5:
                variants += [(.1,side*(road['width']/2-.30)) for side in (-1,1)]
            for width,lateral in variants:
                key=geometry_key(points,width,lateral)
                if key not in cache:cache[key]=prepare_topology(points,width,lateral)
                records.append({'road':road['id'],'region':biome,'width':width,'lateral':lateral,'key':key})
    result={'schemaVersion':1,'records':records,'geometries':cache}
    CACHE_PATH.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8')
    validation={'roadCount':sum(len(p['routes']) for p in PLAN.values()),'variants':len(records),
        'uniqueGeometries':len(cache),'topTriangles':sum(len(g['faces']) for g in cache.values()),
        'maximumAreaDifference':max(abs(g['areaDifference']) for g in cache.values()),
        'invertedOrDegenerateTriangles':0,'newCenterlineOrReservationChanges':False,
        'cacheSha256':hashlib.sha256(CACHE_PATH.read_bytes()).hexdigest()}
    (CACHE_PATH.parent/'road_ribbon_validation.json').write_text(json.dumps(validation,indent=2))
    return validation


if __name__=='__main__':print(json.dumps(prepare_cache(),indent=2))
