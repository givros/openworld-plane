"""Apply the final terrain contact corrections without rebuilding regional assets."""
import argparse
import json
import os
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).parent))
from build_world import DEFINITIONS, OUT, PUBLIC, inventory, write_json
from finish_landscape import context_from_scene
from fast_gltf_export import fast_gltf_references
from terrain_fit_paths import fit_ground_routes


def finalize(biome, supplemental=False):
    definition = next(d for d in DEFINITIONS if d['id'] == biome)
    directory = OUT / biome
    source = directory / ('Four_Horizons_' + biome.replace('-', '_') + '.blend')
    bpy.ops.wm.open_mainfile(filepath=str(source))
    already_applied = bool(bpy.context.scene.get('final_ground_contacts_applied'))
    if already_applied and not supplemental:
        raise RuntimeError('Final ground contacts are already applied.')
    registry = json.loads((directory / 'asset_registry.json').read_text())
    human = json.loads((directory / 'human_landuse_validation.json').read_text())
    if not human.get('sourceApplied') or not human.get('exportIntegrated'):
        raise RuntimeError('A completed inhabited landscape is required.')
    ctx = context_from_scene(definition['region'], registry)
    report = (json.loads((directory / 'ground_contact_validation.json').read_text())
              if already_applied else fit_ground_routes(ctx))
    print('TERRAIN_ROUTES_FITTED', biome, report['objects'], report['addedTriangles'], flush=True)
    if not already_applied and biome in ('alpine-lake', 'sunstone-oasis'):
        from targeted_ground_contact_fixes import apply_targeted_ground_contact_fixes
        report['targetedContacts'] = apply_targeted_ground_contact_fixes(ctx, biome)
        print('TARGETED_CONTACTS_FITTED', biome, flush=True)
    if biome == 'alpine-lake' and supplemental:
        from targeted_ground_contact_fixes import finish_alpine_contact_supports
        report['supportSupplement'] = finish_alpine_contact_supports(ctx, biome)
        print('JUNCTION_SUPPORTS_FINISHED', biome, flush=True)
    if biome == 'azure-port' and supplemental:
        from regional_joint_caps import add_regional_joint_caps
        report['regionalJointCaps'] = add_regional_joint_caps(ctx, biome)
        print('REGIONAL_JOINTS_FITTED', biome, flush=True)
    if biome == 'sunstone-oasis':
        from market_plaza_repair import repair_market_plaza
        report['marketPlazaContact'] = repair_market_plaza()
        print('MARKET_PLAZA_CONTACT_FITTED', biome, flush=True)
    report.setdefault('sourceBefore', registry['source'])
    # Keep registry mesh references synchronized with the corrected editable data.
    objects_by_name = {obj.name: obj for obj in bpy.context.scene.objects}
    for entry in ctx.entries:
        obj = objects_by_name.get(entry['id'])
        if obj is not None and obj.type == 'MESH':
            entry['mesh'] = obj.data.name
            entry['position'] = [obj.location.x, obj.location.z, -obj.location.y]
    final = inventory(ctx)
    report['sourceAfter'] = final['source']
    human.update(source=final['source'], exportIntegrated=False, groundContactsCorrected=True)
    spec = json.loads((directory / 'scene_spec.json').read_text())
    spec['source'] = final['source']
    spec['humanLanduse']['built'] = human
    bpy.context.scene['final_ground_contacts_applied'] = True
    bpy.ops.wm.save_as_mainfile(filepath=str(source), compress=False)
    write_json(directory / 'asset_registry.json', final)
    write_json(directory / 'ground_contact_validation.json', report)
    write_json(directory / 'human_landuse_validation.json', human)
    write_json(directory / 'scene_spec.json', spec)
    print('GROUND_CONTACTS_SAVED', biome, json.dumps(final['source']), flush=True)
    pending = directory / (biome + '.pending.glb')
    with fast_gltf_references():
        bpy.ops.export_scene.gltf(
            filepath=str(pending), export_format='GLB', use_selection=False,
            export_cameras=False, export_lights=False, export_animations=False,
            export_yup=True, export_apply=False, export_extras=True,
            export_texcoords=True, export_normals=True, export_materials='EXPORT',
            export_draco_mesh_compression_enable=False)
    os.replace(pending, PUBLIC / (biome + '.glb'))
    human['exportIntegrated'] = True
    write_json(directory / 'human_landuse_validation.json', human)
    spec['humanLanduse']['built'] = human
    write_json(directory / 'scene_spec.json', spec)
    print('GROUND_CONTACTS_EXPORTED', biome, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--biome', required=True)
    parser.add_argument('--supplemental', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    finalize(args.biome, args.supplemental)
