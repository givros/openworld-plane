"""Build and inspect the four architectural families without exporting the world."""
import sys,math,json
from pathlib import Path
import bpy
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
from scene_kit import Context,xyz
from build_world import lighting,camera

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/four-horizons/architecture-prototypes'

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    ctx=Context('ARCH_PROTOTYPES');ctx.ground=lambda x,z:0
    definitions=[
        ('Willow_Cottage',-18,0,9.4,8.3,6.25,'plaster_ivory','roof_terracotta',0,'cottage'),
        ('Port_Townhouse',-3,0,9.2,8.1,9.35,'plaster_rose','roof_terracotta',-.08,'mediterranean'),
        ('Mountain_Chalet',13,0,10.2,8.4,6.45,'plaster_ivory','roof_slate',.12,'chalet'),
        ('Oasis_Courtyard',28,0,9.3,8.8,6.0,'plaster_ochre','sandstone',-.05,'adobe'),
    ]
    for data in definitions:ctx.building(*data)
    ctx.collection('Shared_Architecture_Court')
    ctx.box('court-ground',5,-.23,0,86,.36,42,'gravel')
    for i in range(43):
        for j in range(7):
            x=-37+i*1.95;z=6.2+j*.77
            ctx.box('court-paving',x,-.029,z,1.91,.12,.73,'concrete')
    lighting();scene=bpy.context.scene
    scene.cycles.samples=32;scene.render.resolution_x=1500;scene.render.resolution_y=980
    scene.view_settings.exposure=0
    cameras=[
        ('front',[-35,12,24],[-18,4.8,0],42),
        ('reverse',[-1,12,-23],[-18,4.8,0],42),
        ('roof-detail',[-20,11,9],[-18,7.8,.7],52),
        ('integrated',[44,22,35],[3.5,4.0,0],41),
        ('chalet',[26,12,24],[13,5.0,0],43),
        ('adobe',[43,10,21],[28,3.7,0],43),
        ('port',[-18,15,25],[-3,6.0,0],43),
    ]
    for name,position,target,lens in cameras:
        cam=camera('CAM_Architecture_'+name,position,target,lens)
        scene.camera=cam
        scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'Detailed_Architecture_Prototypes.blend'),compress=False)
    mesh_objects=[obj for obj in scene.objects if obj.type=='MESH'];triangles=0
    for obj in mesh_objects:obj.data.calc_loop_triangles();triangles+=len(obj.data.loop_triangles)
    report={'buildings':ctx.buildings,'objects':len(mesh_objects),'triangles':triangles,'normalMaps':[image.name for image in bpy.data.images if 'Normal' in image.name],
        'referenceImages':['E:/Dev/forest-lake-test-with-skill-test/artifacts/givros_test/willowmere/renders/architecture_fixture.png','E:/Dev/city-skill/artifacts/verdant_city/renders/pass_03/CAM_08_Garden.png'],
        'scope':'Isolated four-family architectural fixture; no whole-region exports.'}
    (OUT/'architecture_validation.json').write_text(json.dumps(report,indent=2))
    print('ARCHITECTURE_PROTOTYPES_COMPLETE',json.dumps({'objects':len(mesh_objects),'triangles':triangles}),flush=True)

if __name__=='__main__':main()
