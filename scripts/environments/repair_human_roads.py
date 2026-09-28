"""Rebuild only the revised road surfaces in an already completed source."""
import argparse,json,os,sys
from pathlib import Path
import bpy
sys.path.insert(0,str(Path(__file__).parent))
from build_world import OUT,PUBLIC,DEFINITIONS,inventory,write_json
from finish_landscape import context_from_scene,finish_circulation
from human_landuse import build_network_roads
from regional_network_plan import PLAN
from fast_gltf_export import fast_gltf_references

parser=argparse.ArgumentParser();parser.add_argument('--biome',required=True)
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:]);biome=args.biome
d=next(d for d in DEFINITIONS if d['id']==biome);directory=OUT/biome
source=directory/('Four_Horizons_'+biome.replace('-','_')+'.blend')
bpy.ops.wm.open_mainfile(filepath=str(source))
if not bpy.context.scene.get('human_landuse_applied'):raise RuntimeError('No completed human layer to repair')
registry=json.loads((directory/'asset_registry.json').read_text());ctx=context_from_scene(d['region'],registry)
prefix=d['region']+'/Network/'
removed=[o for o in bpy.context.scene.objects if o.name.startswith(prefix)]
for obj in removed:bpy.data.objects.remove(obj,do_unlink=True)
ctx.entries=[e for e in ctx.entries if not e['id'].startswith(prefix)]
finish_circulation(ctx,biome);ctx.collection('FINAL_CONNECTED_ROADS')
entry_levels={b['parcelId']+'/entry':b['ground']+.14 for b in ctx.buildings if 'parcelId' in b}
contacts=build_network_roads(ctx,biome,PLAN[biome],entry_levels)
final=inventory(ctx);write_json(directory/'asset_registry.json',final)
human=json.loads((directory/'human_landuse_validation.json').read_text())
human.update(source=final['source'],roadTopologyCorrected=True,existingRoadContactSupports=contacts,exportIntegrated=False)
spec=json.loads((directory/'scene_spec.json').read_text());spec['source']=final['source'];spec['humanLanduse']['built']=human
write_json(directory/'scene_spec.json',spec);write_json(directory/'human_landuse_validation.json',human)
bpy.ops.wm.save_as_mainfile(filepath=str(source),compress=False)
pending=directory/(biome+'.pending.glb')
with fast_gltf_references():
    bpy.ops.export_scene.gltf(filepath=str(pending),export_format='GLB',use_selection=False,
        export_cameras=False,export_lights=False,export_animations=False,export_yup=True,export_apply=False,
        export_extras=True,export_texcoords=True,export_normals=True,export_materials='EXPORT',
        export_draco_mesh_compression_enable=False)
os.replace(pending,PUBLIC/(biome+'.glb'));human['exportIntegrated']=True
write_json(directory/'human_landuse_validation.json',human)
spec['humanLanduse']['built']=human;write_json(directory/'scene_spec.json',spec)
print('HUMAN_ROADS_REPAIRED',biome,json.dumps(final['source']),flush=True)
