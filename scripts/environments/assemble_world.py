"""Full-detail master: edit placement/lighting here and geometry in regional files.

Keep Four_Horizons.blend beside its four regional folders. The complete source
collections are linked at identity through four editable collection instances.
"""
import bpy
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_world import OUT, DEFINITIONS, lighting, camera, write_json
from master_inventory import evaluated_master_inventory, validate_master_inventory

if '--standalone' in sys.argv:
    raise RuntimeError('Use the collection-instance master; all geometry is editable in the four included regional sources.')

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
expected = {'objects': 0, 'triangles': 0, 'regions': {}}
sources = []
started = time.perf_counter()
for definition in DEFINITIONS:
    biome, prefix = definition['id'], definition['region']
    source_path = OUT / biome / ('Four_Horizons_' + biome.replace('-', '_') + '.blend')
    spec = json.loads((OUT / biome / 'scene_spec.json').read_text())
    counts = {key: spec['source'][key] for key in ('objects', 'triangles')}
    expected['regions'][prefix] = counts
    for key in counts:
        expected[key] += counts[key]
    print('LINKING_REGION', biome, flush=True)
    with bpy.data.libraries.load(str(source_path), link=True, relative=True) as (source, target):
        target.collections = [name for name in source.collections if name.startswith(prefix)]
    if not target.collections or any(c is None for c in target.collections):
        raise RuntimeError('Missing complete source collections: ' + biome)
    # The wrapper is not a scene child: only its identity instance gets a base.
    wrapper = bpy.data.collections.new(prefix + '_CompleteWorldRegion')
    target_pointers = {c.as_pointer() for c in target.collections}
    nested = {child.as_pointer() for c in target.collections for child in c.children if child.as_pointer() in target_pointers}
    for collection in target.collections:
        if collection.as_pointer() not in nested:
            wrapper.children.link(collection)
    instance = bpy.data.objects.new(prefix + '_WorldPlacement', None)
    instance.instance_type = 'COLLECTION'
    instance.instance_collection = wrapper
    instance['region_id'] = biome
    instance['source_file'] = source_path.relative_to(OUT).as_posix()
    bpy.context.scene.collection.objects.link(instance)
    actual = sum(obj.type == 'MESH' for obj in wrapper.all_objects)
    if actual != counts['objects']:
        raise RuntimeError(f'Linked region object mismatch: {biome}: {actual} != {counts["objects"]}')
    sources.append({'biome': biome, 'path': instance['source_file'], 'bytes': source_path.stat().st_size, **counts})
    print('REGION_INSTANCED', biome, actual, flush=True)

lighting()
scene = bpy.context.scene
scene.camera = camera('CAM_FourHorizons', [3800, 2850, -3050], [770, 35, 930], 45)
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
destination, pending = OUT / 'Four_Horizons.blend', OUT / 'Four_Horizons.pending.blend'
print('SAVING_COLLECTION_INSTANCE_MASTER', flush=True)
bpy.ops.wm.save_as_mainfile(filepath=str(pending), compress=False)
print('REOPENING_COLLECTION_INSTANCE_MASTER', flush=True)
bpy.ops.wm.open_mainfile(filepath=str(pending))
inventory = evaluated_master_inventory()
validate_master_inventory(inventory, expected)
if inventory['collectionInstances'] != 4 or inventory['directSceneMeshObjects'] != 0:
    raise RuntimeError('The master must contain exactly four complete region instances.')
pending.replace(destination)
description = 'Complete full-detail collection-instance master. Edit world placement, lighting and camera here; edit every source object, mesh and material in the four included regional Blender files. Keep the master beside those four regional folders.'
registry = {
    'objects': inventory['objects'], 'triangles': inventory['triangles'],
    'biomes': [d['id'] for d in DEFINITIONS], 'source': description,
    'standalone': False, 'packaging': 'four-linked-collection-instances',
    'compression': False, 'regionSources': sources,
}
write_json(OUT / 'asset_registry.json', registry)
defer_render = '--defer-render' in sys.argv
if not defer_render:
    bpy.context.scene.render.filepath = str(OUT / 'renders/master-overview.png')
    bpy.ops.render.render(write_still=True)
write_json(OUT / 'master_validation.json', {
    'status': 'verified', 'reopened': True, **inventory,
    'linkedLibraries': len(bpy.data.libraries), 'standalone': False,
    'packaging': 'four-linked-collection-instances', 'regionSources': sources,
    'source': description, 'masterBytes': destination.stat().st_size,
    'assemblyAndReopenSeconds': time.perf_counter() - started,
    'render': None if defer_render else 'renders/master-overview.png',
    'renderStatus': 'pending' if defer_render else 'complete',
})
print('MASTER_VERIFIED', json.dumps(registry), flush=True)
