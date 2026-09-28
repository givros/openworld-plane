"""Bounded actual-surface closure and isolated Blender adapter validation."""
import json
import math
import struct
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).parent))
from regional_joint_caps import PLAN_PATH,ROOT,add_regional_joint_caps


def closure_audit():
    from audit_built_network import GLB
    plan=json.loads(PLAN_PATH.read_text());readers={};records=[]
    try:
        for biome in plan['sourceRoads']:readers[biome]=GLB(ROOT/'public/environments'/f'{biome}.glb')
        for piece in plan['pieces']:
            key='road' if piece['role']=='surface' else 'verge';top=[tuple(v) for v in piece['top']]
            virtual='AUDIT_ONLY/'+piece['role'];readers['azure-port'].geometry[virtual]={'triangles':[top],'grid':{}}
            before=0;after=0
            for index in range(41):
                lateral=(-.49+.98*index/40)*piece['width'];original=[]
                for biome,source in plan['sourceRoads'].items():
                    original+=readers[biome].section_intervals(source[key],plan['center'],[1,0],lateral)
                extra=readers['azure-port'].section_intervals(virtual,plan['center'],[1,0],lateral)
                def largest_gap(intervals):
                    cursor=-.5;gap=0
                    for a,b in sorted(intervals):
                        gap=max(gap,a-cursor);cursor=max(cursor,b)
                    return max(gap,.5-cursor)
                before=max(before,largest_gap(original));after=max(after,largest_gap(original+extra))
            assert after<.0002,(piece['role'],after)
            quantized=[tuple(struct.unpack('<f',struct.pack('<f',v))[0] for v in point) for point in piece['vertices']]
            incidence={};zero=0
            for face in piece['faces']:
                for a,b in zip(face,face[1:]+face[:1]):incidence[tuple(sorted((a,b)))]=incidence.get(tuple(sorted((a,b))),0)+1
                for i in range(1,len(face)-1):
                    a,b,c=[quantized[k] for k in (face[0],face[i],face[i+1])]
                    u=[b[k]-a[k] for k in range(3)];v=[c[k]-a[k] for k in range(3)]
                    cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
                    zero+=int(all(x==0 for x in cross))
            assert zero==0 and all(v==2 for v in incidence.values())
            records.append({'role':piece['role'],'beforeGapMeters':before,'afterGapMeters':after,
                            'sampledSections':41,'float32ZeroAreaTriangles':zero,'closedSolid':True,
                            'areaSquareMeters':piece['projectedAreaSquareMeters']})
        report={'passes':True,'readOnlyActualExports':True,'method':'Actual GLB carriageway/verge triangles plus explicit proposed cap; 41 exact seam line intersections per layer',
                'pieces':records}
        (ROOT/'artifacts/four-horizons/regional_joint_cap_validation.json').write_text(json.dumps(report,indent=2))
        print('REGIONAL_JOINT_CAP_GEOMETRY_PASS',json.dumps(report),flush=True)
    finally:
        for reader in readers.values():reader.close()


def blender_fixture():
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    plan=json.loads(PLAN_PATH.read_text());entries=[];materials={}
    for name in ('asphalt','gravel'):materials[name]=bpy.data.materials.new(name)
    def mesh(name,vertices,faces,material):
        data=bpy.data.meshes.new(name);data.from_pydata([(x,-z,y) for x,y,z in vertices],[],faces)
        data.materials.append(materials[material]);obj=bpy.data.objects.new('REG_PORT/'+name,data)
        bpy.context.scene.collection.objects.link(obj);entries.append({'id':obj.name,'mesh':data.name,'material':material})
        return obj
    ctx=SimpleNamespace(region='REG_PORT',mesh=mesh,entries=entries)
    original=[]
    for piece in plan['pieces']:
        name=plan['sourceRoads']['azure-port']['road' if piece['role']=='surface' else 'verge'].split('/',1)[1]
        half=piece['width']/2;y=piece['portDatumMeters']
        obj=mesh(name,[(800,y,-60-half),(801,y,-60-half),(801,y,-60+half),(800,y,-60+half)],[(0,3,2,1)],piece['material'])
        original.append((obj,[tuple(v.co) for v in obj.data.vertices]))
    report=add_regional_joint_caps(ctx,'azure-port')
    assert report['objectsAdded']==2 and len(entries)==4 and len(bpy.context.scene.objects)==4
    assert all(before==[tuple(v.co) for v in obj.data.vertices] for obj,before in original)
    assert add_regional_joint_caps(ctx,'azure-port')['objectsAdded']==0
    assert add_regional_joint_caps(ctx,'alpine-lake')['objectsAdded']==0
    report.update(passes=True,originalObjectsUnchanged=True,entriesAdded=2,idempotent=True)
    (ROOT/'artifacts/four-horizons/regional_joint_cap_blender_fixture.json').write_text(json.dumps(report,indent=2))
    print('REGIONAL_JOINT_CAP_BLENDER_PASS',json.dumps(report),flush=True)


if __name__=='__main__':
    if '--blender-fixture' in sys.argv:blender_fixture()
    else:closure_audit()
