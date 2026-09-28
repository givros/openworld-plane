"""Small isolated Blender adapter fixture; never opens or saves a world source."""
import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import bpy
from mathutils import Matrix

sys.path.insert(0,str(Path(__file__).parent))
from terrain_fit_paths import fit_ground_routes
from regional_network_helpers import ARTIFACTS,ground_function

bpy.ops.wm.read_factory_settings(use_empty=True)
ground=ground_function()
points=[(658,1808),(683,1816),(666,1841),(690,1830)]
vertices=[(x,-z,ground(x,z)+.08+(1.8 if index==3 else 0)) for index,(x,z) in enumerate(points)]
mesh=bpy.data.meshes.new('FixtureRoadMesh');mesh.from_pydata(vertices,[],[(0,2,1),(1,2,3)])
obj=bpy.data.objects.new('REG_FIXTURE/OriginalPath',mesh);bpy.context.scene.collection.objects.link(obj)
obj['ground_route']=True;obj['semantic_id']='fixture-preserved';obj['supported_network_contact']=True
material=bpy.data.materials.new('FixtureRoadMaterial');mesh.materials.append(material)
uv=mesh.uv_layers.new(name='RoadUV')
for loop in mesh.loops:uv.data[loop.index].uv=(loop.vertex_index*.25,loop.vertex_index*.125)
point_color=mesh.color_attributes.new(name='PointColor',type='FLOAT_COLOR',domain='POINT')
for index,item in enumerate(point_color.data):item.color=(index*.2,.4,.6,1)
corner_color=mesh.color_attributes.new(name='CornerColor',type='FLOAT_COLOR',domain='CORNER')
for index,item in enumerate(corner_color.data):item.color=(index*.1,.7,.3,1)
mesh.color_attributes.active_color_name='CornerColor'
# Exercise non-identity object coordinates without changing the world geometry.
transform=Matrix.Translation((8,-12,3))@Matrix.Rotation(.23,4,'Z')
inverse=transform.inverted()
for vertex in mesh.vertices:vertex.co=inverse@vertex.co
obj.matrix_world=transform
network=obj.copy();network.data=mesh.copy();network.name='REG_FIXTURE/Network/ProtectedRoad'
bpy.context.scene.collection.objects.link(network)
network_before=[tuple(v.co) for v in network.data.vertices]
before_count=len(bpy.context.scene.objects);identity=obj.as_pointer()
ctx=SimpleNamespace(ground=ground)
dry=fit_ground_routes(ctx,dry_run=True)
assert len(obj.data.polygons)==2 and before_count==len(bpy.context.scene.objects)
report=fit_ground_routes(ctx)
assert len(bpy.context.scene.objects)==before_count and obj.as_pointer()==identity
assert obj['semantic_id']=='fixture-preserved' and obj['supported_network_contact']
assert obj.data.materials[0]==material
assert obj.data.uv_layers.get('RoadUV') and len(obj.data.color_attributes)==2
assert obj.data.color_attributes['PointColor'].domain=='POINT'
assert obj.data.color_attributes['CornerColor'].domain=='CORNER'
assert obj.data.color_attributes.active_color.name=='CornerColor'
assert [tuple(v.co) for v in network.data.vertices]==network_before
obj.data.calc_loop_triangles()
zero=[];minimum=math.inf
for triangle in obj.data.loop_triangles:
    vv=[obj.matrix_world@obj.data.vertices[i].co for i in triangle.vertices]
    if (vv[1]-vv[0]).cross(vv[2]-vv[0]).length_squared==0:zero.append(triangle.index)
    for weights in ((1/3,1/3,1/3),(.7,.2,.1),(.1,.7,.2),(.2,.1,.7)):
        x,y,z=[sum(p[c]*w for p,w in zip(vv,weights)) for c in range(3)]
        minimum=min(minimum,z-ground(x,-y))
assert not zero,zero
assert minimum>.0798,minimum
polygons=len(obj.data.polygons)
again=fit_ground_routes(ctx)
assert len(obj.data.polygons)==polygons and again['routes'][0]['alreadyFitted']
report.update(passes=True,uvLayersPreserved=True,colorDomainsPreserved=True,materialsPreserved=True,
              objectIdentityPreserved=True,networkRoadUnchanged=True,idempotent=True,
              actualBlenderInteriorMinimumClearanceMeters=minimum,actualBlenderZeroAreaTriangles=len(zero))
out=ARTIFACTS/'terrain_route_fit_blender_fixture.json';out.write_text(json.dumps(report,indent=2),encoding='utf-8')
print('TERRAIN_ROUTE_FIXTURE_PASS',json.dumps(report),flush=True)
