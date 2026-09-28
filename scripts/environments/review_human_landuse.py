"""Inspect a real architecture clone, rural road and trellised crop assembly."""
from pathlib import Path
import sys
import bpy
sys.path.insert(0,str(Path(__file__).parent))
from scene_kit import Context,terrain
from build_world import camera,lighting,OUT
from human_landuse import build_human_landuse

bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
ctx=Context('FIXTURE');ctx.collection('Source')
ctx.building('SourceHouse',345,-120,10.5,9,6.3,'plaster_ivory','roof_terracotta',style='cottage')
terrain(ctx,[-800,-800])
plan={'routes':[{'id':'country-road','points':[[310,-200],[325,-155],[333,-110],[350,-80]],'width':7,'type':'primary'},
                {'id':'vineyard-access','points':[[325,-155],[355,-161],[370,-159]],'width':2.6,'type':'path'},
                {'id':'house-entry','points':[[355,-148.1],[355,-161]],'width':1.8,'type':'entry'}],
      'settlements':[{'id':'Farmstead','center':[355,-145],'buildings':[{'id':'Farmhouse','center':[355,-143],
                      'prototypeId':'FIXTURE/SourceHouse','yaw':3.14,'entryRoute':'house-entry'}]}],
      'fields':[{'id':'Vineyard','center':[374,-133],'width':24,'depth':38,'yaw':.1,'crop':'vineyard'},
                {'id':'Grain','center':[346,-190],'width':22,'depth':24,'yaw':-.15,'crop':'wheat'}]}
build_human_landuse(ctx,'fixture',plan)
clones=[obj for obj in bpy.context.scene.objects if obj.get('source_prototype')=='FIXTURE/SourceHouse']
for obj in clones:
    old=bpy.data.objects['FIXTURE/SourceHouse'+obj.name[len('FIXTURE/Settlement/Farmhouse'):]]
    assert obj.data is old.data, 'Full component mesh was changed instead of shared'
assert clones, 'No actual full-detail building copy'
print('COMPLETE_HOUSE_COMPONENTS_SHARED',len(clones),flush=True)
lighting();directory=OUT/'comparisons/human-landuse';directory.mkdir(parents=True,exist_ok=True)
for name,p,t in [('aerial',[409,60,-213],[350,3,-146]),('vineyard',[362,2,-157],[374,1,-141]),
                 ('street',[329,2,-174],[347,3,-136])]:
    cam=camera('REVIEW_'+name,p,t,36);bpy.context.scene.camera=cam
    bpy.context.scene.render.filepath=str(directory/(name+'.png'));bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(directory/'landuse-assemblies.blend'),compress=False)
print('HUMAN_LANDUSE_FIXTURE_COMPLETE',flush=True)
