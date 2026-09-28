"""Count complete evaluated collection instances without expanding shared meshes."""
import bpy


def evaluated_master_inventory():
    graph = bpy.context.evaluated_depsgraph_get()
    mesh_triangles = {}
    regions = {}
    names = set()
    object_count = triangle_count = 0
    for instance in graph.object_instances:
        obj = instance.object
        if obj.type != 'MESH':
            continue
        name = obj.original.name
        if name in names:
            raise RuntimeError(f'Duplicate evaluated world instance: {name}')
        names.add(name)
        mesh = obj.data
        key = mesh.as_pointer()
        if key not in mesh_triangles:
            mesh.calc_loop_triangles()
            mesh_triangles[key] = len(mesh.loop_triangles)
        triangles = mesh_triangles[key]
        object_count += 1
        triangle_count += triangles
        region = regions.setdefault(name.split('/', 1)[0], {'objects': 0, 'triangles': 0})
        region['objects'] += 1
        region['triangles'] += triangles
    return {
        'objects': object_count,
        'triangles': triangle_count,
        'uniqueMeshes': len(mesh_triangles),
        'regions': regions,
        'directSceneMeshObjects': sum(o.type == 'MESH' for o in bpy.context.scene.objects),
        'collectionInstances': sum(o.instance_type == 'COLLECTION' for o in bpy.context.scene.objects),
        'countMethod': 'Evaluated dependency-graph mesh instances; exact tessellation cached once per shared mesh.',
    }


def validate_master_inventory(inventory, expected):
    for key in ('objects', 'triangles'):
        if inventory[key] != expected[key]:
            raise RuntimeError(f'Master {key} mismatch: {inventory[key]} != {expected[key]}')
    for region, region_expected in expected.get('regions', {}).items():
        actual = inventory['regions'].get(region)
        if actual != region_expected:
            raise RuntimeError(f'Master region inventory mismatch: {region}: {actual} != {region_expected}')
