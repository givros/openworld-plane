"""Four collection instances, exact synthetic-source content, no rendering."""
import bpy
import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from benchmark_master_packaging import OUT, clear
from master_inventory import evaluated_master_inventory, validate_master_inventory


def content_signature(objects):
    digest = hashlib.sha256()
    objects = sorted(objects, key=lambda o: o.name)
    meshes = {o.data.name: o.data for o in objects}
    for o in objects:
        digest.update(json.dumps([o.name, o.data.name, list(o.location), list(o.scale), list(o.rotation_euler), o['semantic_id'], o['material_role']], sort_keys=True).encode())
    for name, mesh in sorted(meshes.items()):
        digest.update(json.dumps([name, [list(v.co) for v in mesh.vertices], [list(p.vertices) for p in mesh.polygons], [list(v.uv) for v in mesh.uv_layers['UVMap'].data], [list(v.color) for v in mesh.color_attributes['Col'].data], [m.name for m in mesh.materials]], sort_keys=True).encode())
    return {'objects': len(objects), 'uniqueMeshes': len(meshes), 'triangles': sum(len(o.data.polygons) for o in objects), 'sha256': digest.hexdigest()}


def evaluated_signature():
    started = time.perf_counter()
    dg = bpy.context.evaluated_depsgraph_get()
    transform_records = []
    objects = []
    for inst in dg.object_instances:
        if inst.object.type == 'MESH':
            original = inst.object.original
            objects.append(original)
            transform_records.append([original.name, [list(row) for row in inst.matrix_world]])
    transform_records.sort(key=lambda row: row[0])
    result = content_signature(objects)
    result['worldTransformSha256'] = hashlib.sha256(json.dumps(transform_records).encode()).hexdigest()
    result['evaluationSeconds'] = time.perf_counter() - started
    return result


args = sys.argv[sys.argv.index('--') + 1:]
count = int(args[0])
mode = args[1]
destination = OUT / f'master_{count}_collection_instances.blend'
report_path = OUT / f'instances_{count}.json'
clear()
if mode == 'build':
    start = time.perf_counter()
    for region in range(4):
        source_path = OUT / f'fixture_{count}_{region}.blend'
        with bpy.data.libraries.load(str(source_path), link=True, relative=True) as (source, target):
            target.collections = [name for name in source.collections if name.startswith(f'REG_{region}')]
        wrapper = bpy.data.collections.new(f'REG_{region}_Complete')
        for collection in target.collections:
            wrapper.children.link(collection)
        instance = bpy.data.objects.new(f'Region_{region}', None)
        instance.instance_type = 'COLLECTION'
        instance.instance_collection = wrapper
        bpy.context.scene.collection.objects.link(instance)
    assembly_seconds = time.perf_counter() - start
    signature = evaluated_signature()
    # The baseline direct-source scene uses the same transformed objects directly.
    source_world = sorted([[o.name, [list(row) for row in o.matrix_world]] for o in bpy.data.objects if o.type == 'MESH'], key=lambda r: r[0])
    source_hash = hashlib.sha256(json.dumps(source_world).encode()).hexdigest()
    baseline = content_signature([o for o in bpy.data.objects if o.type == 'MESH'])
    start = time.perf_counter()
    bpy.ops.wm.save_as_mainfile(filepath=str(destination), compress=False)
    report = {'objectsPerRegion': count, 'assemblySeconds': assembly_seconds, 'saveSeconds': time.perf_counter() - start, 'masterBytes': destination.stat().st_size, 'directSceneObjects': len(bpy.context.scene.objects), 'evaluated': signature, 'source': baseline, 'instanceGeometryMatchesSource': all(signature[k] == baseline[k] for k in baseline), 'instanceTransformsMatchSource': signature['worldTransformSha256'] == source_hash, 'freshReopen': 'pending'}
else:
    report = json.loads(report_path.read_text())
    start = time.perf_counter()
    bpy.ops.wm.open_mainfile(filepath=str(destination))
    report['freshReopenSeconds'] = time.perf_counter() - start
    signature = evaluated_signature()
    report['reopenedEvaluated'] = signature
    report['freshReopen'] = all(signature[k] == report['evaluated'][k] for k in signature if k != 'evaluationSeconds')
    report['directSceneObjectsReopened'] = len(bpy.context.scene.objects)
inventory = evaluated_master_inventory()
validate_master_inventory(inventory, {'objects': count * 4, 'triangles': count * 16})
assert inventory['collectionInstances'] == 4 and inventory['directSceneMeshObjects'] == 0
report['productionInventoryHelper'] = inventory
report_path.write_text(json.dumps(report, indent=2) + '\n')
print('COLLECTION_INSTANCE_RESULT', json.dumps(report), flush=True)
