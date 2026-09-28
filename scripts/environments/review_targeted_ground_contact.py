"""Isolated in-memory verification; never saves or exports production sources."""
import argparse
import bpy
import json
import sys
from pathlib import Path
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).parent))
from build_world import OUT, DEFINITIONS, camera
from finish_landscape import context_from_scene
from targeted_ground_contact_fixes import apply_targeted_ground_contact_fixes, finish_alpine_contact_supports
from terrain_fit_paths import fit_ground_routes
from scene_kit import ground

parser = argparse.ArgumentParser()
parser.add_argument('--biome', choices=['alpine-lake', 'sunstone-oasis'], required=True)
parser.add_argument('--render', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
directory = OUT / args.biome
bpy.ops.wm.open_mainfile(filepath=str(directory / ('Four_Horizons_' + args.biome.replace('-', '_') + '.blend')))
registry = json.loads((directory / 'asset_registry.json').read_text())
definition = next(item for item in DEFINITIONS if item['id'] == args.biome)
ctx = context_from_scene(definition['region'], registry)
terrain = fit_ground_routes(ctx)
result = apply_targeted_ground_contact_fixes(ctx, args.biome)
result['supportSupplement'] = finish_alpine_contact_supports(ctx, args.biome)
if args.biome == 'alpine-lake':
    repeated = finish_alpine_contact_supports(ctx, args.biome)
    assert repeated['alpineContactSupportSupplement'] == []
    result['supportSupplement']['repeatChangedObjects'] = 0
if args.biome == 'alpine-lake':
    names = ['REG_ALPINE/ALP_Village_MainLane',
             'REG_ALPINE/Network/HL_Alpine/EastTerrace/ValleyApproach/surface']
    trees = []
    for name in names:
        obj = bpy.data.objects[name]
        vertices = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
        trees.append(BVHTree.FromPolygons(vertices, [list(p.vertices) for p in obj.data.polygons if p.normal.z > .1]))
    maximum = 0
    for ix in range(81):
        for iz in range(81):
            x, z = 145 + ix * .25, 1220 + iz * .25
            hits = [tree.ray_cast(Vector((x, -z, 500)), Vector((0, 0, -1)), 1000)[0] for tree in trees]
            if all(hit is not None for hit in hits):
                maximum = max(maximum, abs(hits[0].z - hits[1].z))
    result['maximumOldNewCarriagewayStepMeters'] = maximum
    assert maximum < .012, maximum
    result['degenerateMeshes'] = []
    for record in result['alpineJunction'].get('objects', []) + result['supportSupplement'].get('alpineContactSupportSupplement', []):
        data = bpy.data.objects[record['id']].data
        data.calc_loop_triangles()
        bad = [tri for tri in data.loop_triangles if tri.area < 1e-12]
        if bad:
            result['degenerateMeshes'].append(record['id'])
            print('CONTACT_DEGENERATE_DETAIL', record['id'], [(tri.area, [tuple(data.vertices[i].co) for i in tri.vertices]) for tri in bad[:8]], flush=True)
    assert not result['degenerateMeshes'], result['degenerateMeshes']
else:
    again = apply_targeted_ground_contact_fixes(ctx, args.biome)
    result['repeatMovedObjects'] = again['oasisPalms']['objectsMoved']
    assert result['repeatMovedObjects'] == 0
result['sourceSaved'] = False
result['sourceExported'] = False
(directory / 'targeted_contact_in_memory_validation.json').write_text(json.dumps(result, indent=2))
print('TARGETED_CONTACT_VALIDATED', args.biome, flush=True)
if args.render:
    scene = bpy.context.scene
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for device in prefs.devices:
            device.use = device.type != 'CPU'
        if any(device.use for device in prefs.devices):
            scene.cycles.device = 'GPU'
    except Exception:
        pass
    if args.biome == 'alpine-lake':
        eye, target = [167, ground(167, 1210) + 35, 1210], [162, ground(162, 1232) + .7, 1232]
        scene.camera = camera('CONTACT_REVIEW', eye, target, 36)
        scene.render.filepath = str(directory / 'comparisons' / 'landuse-targeted-contact-refinement.png')
    else:
        scene.camera = bpy.data.objects['CAM_shore']
        scene.render.filepath = str(directory / 'comparisons' / 'oasis-root-contact-refinement.png')
    bpy.ops.render.render(write_still=True)
