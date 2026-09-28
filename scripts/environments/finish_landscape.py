"""Add landscape strata to existing editable sources without rebuilding architecture."""
import argparse
import json
import math
from pathlib import Path
import sys
import bpy

sys.path.insert(0, str(Path(__file__).parent))
from scene_kit import Context, ground, PALETTE
from build_world import OUT, PUBLIC, DEFINITIONS, inventory, write_json


def context_from_scene(region, registry):
    ctx = Context.__new__(Context)
    ctx.region = region
    ctx.meshes = {}
    ctx.materials = {material.name: material for material in bpy.data.materials}
    for name, colour in PALETTE.items():
        if name not in ctx.materials: ctx.material(name, colour, .8 if name != 'water' else .2,
                                                  .15 if name in ('metal', 'glass', 'water') else 0)
    ctx.entries = registry['objects']
    ctx.buildings = registry['buildings']
    ctx._botanical_prototypes = {}
    for style in ('oak', 'pine', 'cypress', 'palm'):
        for variant in range(3):
            wood = bpy.data.meshes.get(f'BOT_{style}_{variant}_BranchingWood')
            leaves = bpy.data.meshes.get(f'BOT_{style}_{variant}_ArticulatedFoliage')
            if wood is not None and leaves is not None:
                height = max(max(vertex.co.z for vertex in mesh.vertices) for mesh in (wood, leaves))
                ctx._botanical_prototypes[('detailed_tree', style, variant)] = (wood, leaves, height)
    for kind in ('fern', 'grass', 'reed', 'lavender', 'daisy', 'rose', 'shrub', 'leaf_litter'):
        for variant in range(3):
            mesh = bpy.data.meshes.get(f'BOT_{kind}_{variant}_WholePlant')
            if mesh is not None: ctx._botanical_prototypes[('botanical', kind, variant)] = mesh
    ctx.collection('OPEN_LANDSCAPE')
    return ctx


def finish_circulation(ctx, biome):
    """Replay all routes once, preserving their exact order and surface layers."""
    from build_meadow_harbor import build_meadow, build_harbor
    from build_alpine_canyon import build_alpine, build_canyon
    builders = {'verdant-airfield': build_meadow, 'azure-port': build_harbor,
                'alpine-lake': build_alpine, 'sunstone-oasis': build_canyon}
    class Routes:
        ground = staticmethod(ground)
        def __init__(self): self.routes = []
        def path(self, *args, **kwargs): self.routes.append((args, kwargs))
        def __getattr__(self, name):
            if name.startswith('_') or name in ('meshes', 'materials'): raise AttributeError(name)
            return lambda *a, **kw: None
    capture = Routes()
    builders[biome](capture)
    names = {ctx.region + '/' + args[0] for args, _ in capture.routes}
    ctx.entries = [entry for entry in ctx.entries if entry['id'] not in names]
    for name in names:
        obj = bpy.data.objects.get(name)
        if obj: bpy.data.objects.remove(obj, do_unlink=True)
    ctx.collection('FINAL_CIRCULATION')
    for args, kwargs in capture.routes: ctx.path(*args, **kwargs)
    if biome == 'verdant-airfield':
        obj = bpy.data.objects.get(ctx.region + '/Meadow_Windmill_Foundation')
        if obj:
            x, z = obj.location.x, -obj.location.y
            bottom = min(ground(x + math.cos(i*math.tau/40)*11, z + math.sin(i*math.tau/40)*11) for i in range(40)) - .05
            top = ground(x,z) + 1.1
            obj.location.z = (bottom+top)/2
            obj.scale.z = top-bottom
    if biome == 'azure-port':
        for i, z in enumerate((30,36,60,66,72)):
            old_z = 29+i*9
            objects = [o for o in bpy.context.scene.objects if o.name.startswith(ctx.region + f'/Harbor_Market{i}/')]
            table = bpy.data.objects.get(ctx.region + f'/Harbor_Market{i}/table')
            if table:
                old_z = -table.location.y
                for obj in objects: obj.location.y -= z-old_z


def clear_planned_landuse(ctx, biome, plan):
    """Reassign vegetation only where new occupied land use now has priority."""
    from open_landscape import Reservations
    from regional_network_helpers import entry_anchor
    from human_landuse import local_point
    exclusions={'buildings':[], 'fields':[], 'paths':[], 'structures':[], 'water':[]}
    for settlement in plan['settlements']:
        for b in settlement['buildings']:
            exclusions['buildings'].append({'id':b['id'],'center':b.get('center',[b.get('x'),b.get('z')]),
                 'dimensions':[b['w'],b['h'],b['d']],'yaw':b['yaw']})
    for f in plan['fields']:
        exclusions['fields'].append({'id':f['id'],'polygon':[local_point(f['center'],u,v,f.get('yaw',0))
             for u,v in [(-f['width']/2,-f['depth']/2),(f['width']/2,-f['depth']/2),
                         (f['width']/2,f['depth']/2),(-f['width']/2,f['depth']/2)]]})
    exclusions['paths']=[{**r,'width':r['width']+1.6} for r in plan['routes']]
    reserved=Reservations(exclusions,biome)
    removals=[]
    for obj in list(bpy.context.scene.objects):
        role=obj.get('asset_role','')
        if obj.type!='MESH' or not (role in ('tree_foliage','branching_wood') or role.startswith('botanical_')):continue
        x,z=obj.location.x,-obj.location.y
        radius=max(obj.dimensions.x,obj.dimensions.y)*.5 if role=='tree_foliage' else .45
        if reserved.blocked(x,z,radius):removals.append(obj)
    # A tree's foliage and branching wood are a single source assembly.
    tree_prefixes={obj.name.rsplit('/',1)[0] for obj in removals if obj.get('asset_role') in ('tree_foliage','branching_wood')}
    reservations=json.loads((OUT/biome/'landscape_reservations.json').read_text())
    tree_prefixes.update(reservations.get('removedPlantingIds',[]))
    remove_names={obj.name for obj in removals}
    for obj in bpy.context.scene.objects:
        if obj.name in tree_prefixes or obj.name.rsplit('/',1)[0] in tree_prefixes:remove_names.add(obj.name)
    for name in remove_names:bpy.data.objects.remove(bpy.data.objects[name],do_unlink=True)
    ctx.entries=[entry for entry in ctx.entries if entry['id'] not in remove_names]
    reservations['trees']=[record for record in reservations['trees'] if record['id'] not in tree_prefixes]
    reservations['removedPlantingIds']=sorted(tree_prefixes)
    write_json(OUT/biome/'landscape_reservations.json',reservations)
    return {'reason':'New occupied road corridors, settlement envelopes and agricultural parcels replace overlapping previous planting.',
            'removedObjects':len(remove_names),'treeAssemblies':sorted(tree_prefixes),'objects':sorted(remove_names)}


def run(biome, restore=False):
    definition = next(item for item in DEFINITIONS if item['id'] == biome)
    directory = OUT / biome
    source = directory / ('Four_Horizons_' + biome.replace('-', '_') + '.blend')
    checkpoint=directory/'checkpoints/before-open-landscape.blend'
    registry_path=directory/'asset_registry.json'
    if restore:
        import shutil
        if not checkpoint.exists():raise RuntimeError('No pre-landscape source available to revise')
        preserved=directory/'checkpoints/landscape-only-pilot.blend'
        if not preserved.exists():shutil.copy2(source,preserved)
        source_input=checkpoint;registry_path=directory/'checkpoints/before-open-landscape-registry.json'
    else:source_input=source
    bpy.ops.wm.open_mainfile(filepath=str(source_input))
    registry = json.loads(registry_path.read_text())
    if bpy.context.scene.get('open_landscape_applied'):
        raise RuntimeError('Landscape already applied: reopen the pre-landscape checkpoint for a deliberate revision.')
    if not checkpoint.exists():
        bpy.ops.wm.save_as_mainfile(filepath=str(checkpoint), compress=False)
        write_json(directory/'checkpoints/before-open-landscape-registry.json', registry)
    # BEGIN CANYON GEOLOGY REFINEMENT: preserve all other validated assemblies.
    if biome == 'sunstone-oasis':
        from build_alpine_canyon import refresh_canyon_geology
        geology = refresh_canyon_geology(bpy.context.scene)
        replacements = geology.pop('objects')
        replaced_ids = {entry['id'] for entry in replacements}
        registry['objects'] = [entry for entry in registry['objects'] if entry['id'] not in replaced_ids] + replacements
        registry['source']['objects'] += geology['objectsAfter'] - geology['objectsBefore']
        registry['source']['triangles'] += geology['trianglesAfter'] - geology['trianglesBefore']
        write_json(directory/'geology_refresh_validation.json', geology)
        print('CANYON_GEOLOGY_REFINED', json.dumps(geology), flush=True)
    # END CANYON GEOLOGY REFINEMENT.
    ctx = context_from_scene(definition['region'], registry)
    finish_circulation(ctx, biome)
    print('CIRCULATION_READY', biome, flush=True)
    from regional_network_plan import PLAN
    from human_landuse import build_human_landuse, relocate_intact_props
    plan=PLAN[biome]
    # Planned loose rocks move intact before clearing or constructing parcels.
    relocations=relocate_intact_props(ctx,plan)
    clearance=clear_planned_landuse(ctx,biome,plan)
    human=build_human_landuse(ctx,biome,plan)
    human['intactPropRelocations']=relocations
    human['clearance']=clearance
    import hashlib
    human['planSha256']=hashlib.sha256(json.dumps(plan,sort_keys=True).encode()).hexdigest()
    human['sourceApplied']=False;human['exportIntegrated']=False
    write_json(directory/'human_landuse_validation.json',human)
    print('HUMAN_LANDUSE_READY',biome,human['buildings'],human['routes'],flush=True)
    from open_landscape import dress_open_landscape, audit_open_landscape
    reservations = json.loads((directory/'landscape_reservations.json').read_text())
    ctx.collection('OPEN_LANDSCAPE')
    report = dress_open_landscape(ctx, biome, reservations)
    report['placementAudit'] = audit_open_landscape(ctx, biome, reservations, report)
    if not report['placementAudit']['passes']:
        raise RuntimeError('Landscape placement audit failed: ' + json.dumps(report['placementAudit']['violations'][:10]))
    bpy.context.scene['open_landscape_applied'] = True
    bpy.context.scene['human_landuse_applied'] = True
    bpy.context.scene['human_landuse_plan_sha256']=human['planSha256']
    final = inventory(ctx)
    write_json(directory/'asset_registry.json', final)
    spec = json.loads((directory/'scene_spec.json').read_text())
    spec['source'] = final['source']
    spec['openLandscape'] = report
    spec['humanLanduse']={**plan,'built':human}
    write_json(directory/'scene_spec.json', spec)
    write_json(directory/'open_landscape_validation.json', report)
    print('LANDSCAPE_READY', biome, json.dumps(final['source']), flush=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(source), compress=False)
    human['sourceApplied']=True;human['source']=final['source']
    write_json(directory/'human_landuse_validation.json',human)
    from fast_gltf_export import fast_gltf_references
    pending = directory / (biome + '.pending.glb')
    with fast_gltf_references():
        bpy.ops.export_scene.gltf(filepath=str(pending), export_format='GLB',
            use_selection=False, export_cameras=False, export_lights=False, export_animations=False,
            export_yup=True, export_apply=False, export_extras=True, export_texcoords=True,
            export_normals=True, export_materials='EXPORT', export_draco_mesh_compression_enable=False)
    import os
    os.replace(pending, PUBLIC/(biome+'.glb'))
    human['exportIntegrated']=True
    write_json(directory/'human_landuse_validation.json',human)
    spec['humanLanduse']['built']=human
    write_json(directory/'scene_spec.json',spec)
    print('LANDSCAPE_EXPORTED', biome, flush=True)


if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--biome', required=True)
    parser.add_argument('--restore-before-landscape',action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    run(args.biome,args.restore_before_landscape)
