"""A narrow, grounded closure for the measured meadow/harbor cap mismatch.

Preparation reads the two exported surfaces, preserving their actual datums.
Blender consumes the small prepared geometry with standard-library imports only.
Existing source objects and their route geometry remain unchanged.
"""
import json
import math
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
PLAN_PATH=ROOT/'artifacts/four-horizons/regional_joint_cap_plan.json'
IDENTITY='HCON_MEADOW_PORT'


def cap_top(width,center,incoming,outgoing,incoming_height,outgoing_height):
    """Triangle between the two north cap corners and the shared center.

    The clockwise turn has a small outer wedge on its north side. The south
    side already overlaps and receives no additional face.
    """
    def corner(direction):
        dx,dz=direction;length=math.hypot(dx,dz)
        return [center[0]-dz/length*width/2,center[1]+dx/length*width/2]
    a=corner(incoming);b=corner(outgoing)
    return [[center[0],max(incoming_height,outgoing_height),center[1]],
            [a[0],incoming_height,a[1]],[b[0],outgoing_height,b[1]]]


def solid_cap(top,ground):
    vertices=[tuple(v) for v in top]+[(v[0],ground(v[0],v[2])-.06,v[2]) for v in top]
    faces=[(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)]
    return vertices,faces


def prepare_caps():
    from audit_built_network import GLB,_sha
    from regional_network_helpers import ground_function
    from regional_network_plan import PLAN
    source={};center=[800,-60]
    identities={'verdant-airfield':('REG_MEADOW','HL_Meadow/PortRoad'),
                'azure-port':('REG_PORT','HL_Port/MeadowJoin')}
    for biome,(region,identity) in identities.items():
        path=ROOT/'public/environments'/f'{biome}.glb';reader=GLB(path)
        try:
            route=next(r for r in PLAN[biome]['routes'] if r['id']==identity)
            a,b=route['points'][-2:] if biome=='verdant-airfield' else route['points'][:2]
            tangent=[b[0]-a[0],b[1]-a[1]];name=region+'/Network/'+identity
            source[biome]={'road':name+'/surface','verge':name+'/graded-verge','width':route['width'],
                'tangent':tangent,'surfaceHeight':reader.height(name+'/surface',center),
                'vergeHeight':reader.height(name+'/graded-verge',center),
                'evidence':{'path':path.relative_to(ROOT).as_posix(),'sha256':_sha(path)}}
            for role,width in (('surface',route['width']),('graded-verge',route['width']+1.6)):
                length=math.hypot(*tangent)
                corner=[center[0]-tangent[1]/length*width/2,center[1]+tangent[0]/length*width/2]
                actual=min((v for triangle in reader.surface(name+'/'+role)['triangles'] for v in triangle),
                           key=lambda v:(v[0]-corner[0])**2+(v[2]-corner[1])**2)
                assert math.hypot(actual[0]-corner[0],actual[2]-corner[1])<.001
                source[biome][role+'LeftCorner']=list(actual)
        finally:reader.close()
    incoming=source['verdant-airfield'];outgoing=source['azure-port'];pieces=[]
    for role,width,material,key in [('graded-verge',8.6,'gravel','vergeHeight'),('surface',7,'asphalt','surfaceHeight')]:
        top=cap_top(width,center,incoming['tangent'],outgoing['tangent'],incoming[key],outgoing[key])
        # Use exact existing float32 corners, so the new source shares the actual
        # exported boundaries rather than analytically equivalent rounded lines.
        top[1]=incoming[role+'LeftCorner'];top[2]=outgoing[role+'LeftCorner']
        vertices,faces=solid_cap(top,ground_function())
        area=abs((top[1][0]-top[0][0])*(top[2][2]-top[0][2])-(top[1][2]-top[0][2])*(top[2][0]-top[0][0]))/2
        assert area>0
        pieces.append({'role':role,'material':material,'width':width,'top':top,'projectedAreaSquareMeters':area,
                       'vertices':vertices,'faces':faces,'portDatumMeters':outgoing[key]})
    report={'id':IDENTITY,'owner':'azure-port','center':center,'sourceRoads':source,'pieces':pieces,
            'reason':'Measured outer gap between [70,5] incoming and [10,0] outgoing flat route caps',
            'preservesAllExistingObjects':True,'objectsAdded':2}
    PLAN_PATH.write_text(json.dumps(report,indent=2),encoding='utf-8')
    return report


def add_regional_joint_caps(ctx,biome):
    if biome!='azure-port':return {'objectsAdded':0,'applicable':False}
    import bpy
    plan=json.loads(PLAN_PATH.read_text(encoding='utf-8'))
    object_index={obj.name:obj for obj in bpy.context.scene.objects}
    created=[];existing=[]
    for piece in plan['pieces']:
        local='Network/RegionalJoint/'+IDENTITY+'/'+piece['role'];name=ctx.region+'/'+local
        if name in object_index:existing.append(name);continue
        source_name=plan['sourceRoads']['azure-port']['road' if piece['role']=='surface' else 'verge']
        source=object_index[source_name]
        cap=[]
        for vertex in source.data.vertices:
            world=source.matrix_world@vertex.co
            if abs(world.x-800)<.001 and abs(-world.y+60)<piece['width']/2+.001:cap.append(world.z)
        if not cap or abs(max(cap)-piece['portDatumMeters'])>.001:
            raise ValueError('Prepared cap does not match actual port source datum: '+source_name)
        obj=ctx.mesh(local,piece['vertices'],piece['faces'],piece['material'])
        obj.data.materials.clear()
        for material in source.data.materials:obj.data.materials.append(material)
        obj['ground_route']=True;obj['regional_joint']=IDENTITY;obj['route_width_meters']=piece['width']
        obj['road_topology']='Exact outer cap wedge; original route surfaces preserved; grounded solid underside'
        obj['ground_contact_repair']='Measured meadow-port cap closure'
        created.append(obj.name)
    return {'applicable':True,'id':IDENTITY,'objectsAdded':len(created),'created':created,'alreadyPresent':existing,
            'objectsRemoved':0,'originalRouteObjectsModified':0,
            'surfaceAreaSquareMeters':next(p['projectedAreaSquareMeters'] for p in plan['pieces'] if p['role']=='surface'),
            'sourceDatums':{region:{key:record[key] for key in ('surfaceHeight','vergeHeight')} for region,record in plan['sourceRoads'].items()}}


if __name__=='__main__':
    print(json.dumps(prepare_caps(),indent=2))
