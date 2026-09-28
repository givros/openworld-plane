"""Isolated CPU-only comparison; never opens or overwrites production sources."""
import bpy
import hashlib
import json
import math
import sys
import time
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / 'artifacts/four-horizons/comparisons/master-packaging-fixture'
OUT.mkdir(parents=True, exist_ok=True)


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def signature():
    digest = hashlib.sha256()
    objects = sorted((o for o in bpy.context.scene.objects if o.type == 'MESH'), key=lambda o: o.name)
    meshes = {o.data.name: o.data for o in objects}
    for o in objects:
        digest.update(json.dumps([o.name, o.data.name, list(o.location), list(o.scale), list(o.rotation_euler), o['semantic_id'], o['material_role']], sort_keys=True).encode())
    for name, mesh in sorted(meshes.items()):
        digest.update(json.dumps([name, [list(v.co) for v in mesh.vertices], [list(p.vertices) for p in mesh.polygons], [list(v.uv) for v in mesh.uv_layers['UVMap'].data], [list(v.color) for v in mesh.color_attributes['Col'].data], [m.name for m in mesh.materials]], sort_keys=True).encode())
    return {'objects': len(objects), 'uniqueMeshes': len(meshes), 'triangles': sum(len(o.data.polygons) for o in objects), 'sha256': digest.hexdigest(), 'linkedObjects': sum(o.library is not None for o in objects), 'linkedMeshes': sum(m.library is not None for m in meshes.values()), 'linkedMaterials': sum(m.library is not None for m in bpy.data.materials), 'libraries': len(bpy.data.libraries)}


def prepare(count):
    files = []
    expected = []
    for region in range(4):
        clear()
        prefix = f'REG_{region}'
        collections = [bpy.data.collections.new(f'{prefix}/Group_{i}') for i in range(6)]
        for collection in collections:
            bpy.context.scene.collection.children.link(collection)
        mat = bpy.data.materials.new(prefix + '/Material')
        mat.use_nodes = True
        mat['semantic_role'] = 'fixture_plaster'
        meshes = []
        for j in range(max(1, count // 4)):
            mesh = bpy.data.meshes.new(f'{prefix}/Mesh_{j:05d}')
            mesh.from_pydata([(0, 0, 0), (1 + j * .0001, 0, 0), (0, 1, 0), (0, 0, 1)], [], [(0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)])
            mesh.materials.append(mat)
            uv = mesh.uv_layers.new(name='UVMap')
            for i, v in enumerate(uv.data):
                v.uv = ((i % 2), ((i // 2) % 2))
            attr = mesh.color_attributes.new(name='Col', type='FLOAT_COLOR', domain='CORNER')
            for v in attr.data:
                v.color = (.2, .5, .7, 1)
            meshes.append(mesh)
        for i in range(count):
            obj = bpy.data.objects.new(f'{prefix}/Object_{i:06d}', meshes[i % len(meshes)])
            obj.location = (region * 1600 + i % 100, (i // 100) * 2, math.sin(i * .03))
            obj.rotation_euler.z = (i % 30) * .02
            obj.scale = (1, 1, 1 + (i % 7) * .1)
            obj['semantic_id'] = obj.name
            obj['material_role'] = 'fixture_plaster'
            collections[i % len(collections)].objects.link(obj)
        expected.append(signature())
        path = OUT / f'fixture_{count}_{region}.blend'
        bpy.ops.wm.save_as_mainfile(filepath=str(path), compress=False)
        files.append(path)
    return files, expected


def run_case(files, count, method):
    clear()
    timings = {}
    start = time.perf_counter()
    for path in files:
        with bpy.data.libraries.load(str(path), link=(method == 'link_make_local')) as (source, target):
            target.collections = [name for name in source.collections if name.startswith('REG_')]
        for collection in target.collections:
            bpy.context.scene.collection.children.link(collection)
    timings['loadAndLinkSeconds'] = time.perf_counter() - start
    if method == 'link_make_local':
        start = time.perf_counter()
        bpy.ops.object.make_local(type='ALL')
        timings['makeLocalSeconds'] = time.perf_counter() - start
    before = signature()
    destination = OUT / f'master_{count}_{method}.blend'
    start = time.perf_counter()
    bpy.ops.wm.save_as_mainfile(filepath=str(destination), compress=False)
    timings['saveSeconds'] = time.perf_counter() - start
    start = time.perf_counter()
    bpy.ops.wm.open_mainfile(filepath=str(destination))
    timings['reopenSeconds'] = time.perf_counter() - start
    after = signature()
    result = {'objectsPerRegion': count, 'method': method, 'timings': timings, 'before': before, 'after': after, 'reopenPreserved': all(before[k] == after[k] for k in before if k != 'libraries'), 'standalone': after['linkedObjects'] == after['linkedMeshes'] == after['linkedMaterials'] == 0, 'fileBytes': destination.stat().st_size}
    print('PACKAGING_CASE', json.dumps(result), flush=True)
    return result


if __name__ == '__main__':
    results = []
    for count in (250, 1000):
        files, expected = prepare(count)
        pair = [run_case(files, count, method) for method in ('link_make_local', 'direct_append')]
        pair[0]['methodsIdentical'] = pair[1]['methodsIdentical'] = pair[0]['after']['sha256'] == pair[1]['after']['sha256']
        pair[0]['sourceObjectCountPreserved'] = pair[1]['sourceObjectCountPreserved'] = pair[0]['after']['objects'] == pair[1]['after']['objects'] == sum(s['objects'] for s in expected)
        results.extend(pair)
        (OUT / 'comparison.json').write_text(json.dumps({'blender': bpy.app.version_string, 'scope': 'Synthetic four-region CPU-only fixture; geometry, topology, UVs, vertex colors, materials, transforms, semantic custom properties, shared mesh count, standalone status and save/reopen preservation are compared. Real source timing is not inferred.', 'cases': results}, indent=2) + '\n', encoding='utf8')
    print('PACKAGING_BENCHMARK_COMPLETE', str(OUT / 'comparison.json'), flush=True)
