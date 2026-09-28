"""Bounded architectural construction/export checks, without world rendering."""
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scene_kit import Context
from layout_datums import entry_anchor


def main():
    output = Path(__file__).resolve().parents[2] / 'artifacts/four-horizons/architecture-prototypes'
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    ctx = Context('ARCH_CONSTRUCTION_CHECKS')
    ctx.ground = lambda x, z: .03 * x - .025 * z
    definitions = [
        ('Low_Farmhouse', 0, 0, 9.0, 8.0, 3.3, 'plaster_ivory', 'roof_terracotta', 1.83, 'farmhouse'),
        ('Tall_Merchant', 22, 0, 12.0, 11.0, 12.2, 'plaster_rose', 'roof_terracotta', -2.13, 'merchant'),
        ('Rotated_Chalet', 45, 0, 8.0, 7.0, 5.8, 'plaster_ivory', 'roof_slate', 2.42, 'chalet'),
        ('Rotated_Adobe', 64, 0, 7.0, 11.0, 7.0, 'plaster_ochre', 'sandstone', -.94, 'adobe'),
    ]
    for definition in definitions:
        building = ctx.building(*definition)
        _, x, z, w, d, h, _, _, yaw, _ = definition
        assert building['entryAnchor'] == entry_anchor(x, z, w, d, yaw)
        for opening in building['openings']:
            length = w if opening['face'] in ('front', 'rear') else d
            assert abs(opening['u']) + opening['w'] / 2 < length / 2
            assert opening['y'] >= 0 and opening['y'] + opening['h'] < h
        assert building['floorCount'] * building['floorHeight'] == h
        assert building['roof']['ridge'] > h

    objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    triangles = 0
    uv_objects = 0
    tiny_triangles = []
    for obj in objects:
        assert len(obj.data.vertices) and len(obj.data.polygons)
        assert all(math.isfinite(component) for vertex in obj.data.vertices for component in vertex.co)
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
        for triangle in obj.data.loop_triangles:
            a, b, c = [obj.data.vertices[index].co for index in triangle.vertices]
            if (b - a).cross(c - a).length < 1e-9:
                tiny_triangles.append(obj.name)
        assert all(polygon.normal.length > .99 for polygon in obj.data.polygons), obj.name
        material = obj.data.materials[0]
        if material.node_tree.nodes.get('Architecture_Surface_Normal'):
            assert obj.data.uv_layers.active, obj.name
            uv_objects += 1
            assert all(math.isfinite(component) for loop in obj.data.uv_layers.active.data for component in loop.uv)
    assert not tiny_triangles, sorted(set(tiny_triangles))

    blend_path = output / 'Construction_Checks.blend'
    glb_path = output / 'Construction_Checks.glb'
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), compress=False)
    bpy.ops.export_scene.gltf(filepath=str(glb_path), export_format='GLB', export_cameras=False,
        export_lights=False, export_animations=False, export_yup=True, export_apply=False,
        export_extras=True, export_texcoords=True, export_normals=True, export_materials='EXPORT',
        export_draco_mesh_compression_enable=False)
    data = glb_path.read_bytes()
    length, kind = struct.unpack_from('<II', data, 12)
    assert kind == 0x4E4F534A
    gltf = json.loads(data[20:20 + length])
    exported_triangles = sum(gltf['accessors'][primitive['indices']]['count'] // 3
        for node in gltf['nodes'] if 'mesh' in node
        for primitive in gltf['meshes'][node['mesh']]['primitives'])
    assert exported_triangles == triangles, (triangles, exported_triangles)
    normal_materials = [material for material in gltf['materials'] if 'normalTexture' in material]
    assert normal_materials
    assert all(image.get('mimeType') == 'image/png' and 'bufferView' in image for image in gltf['images'])
    assert all('KHR_draco_mesh_compression' not in primitive.get('extensions', {})
        for mesh in gltf['meshes'] for primitive in mesh['primitives'])
    report = {'sourceObjects': len(objects), 'sourceTriangles': triangles,
        'exportedTriangles': exported_triangles, 'trianglePreservation': exported_triangles == triangles,
        'nondegenerateGeometry': not tiny_triangles, 'finiteUVObjects': uv_objects,
        'normalMappedMaterials': len(normal_materials), 'embeddedLosslessPNGs': len(gltf['images']),
        'textureRepeatMeters': 2, 'buildingFamilies': [building['family'] for building in ctx.buildings],
        'testedYawRadians': [definition[8] for definition in definitions],
        'testedEavesHeights': [definition[5] for definition in definitions],
        'buildings': ctx.buildings}
    (output / 'construction_checks.json').write_text(json.dumps(report, indent=2))
    print('ARCHITECTURE_CONSTRUCTION_CHECKS_PASS', json.dumps({key: value for key, value in report.items() if key != 'buildings'}), flush=True)


if __name__ == '__main__':
    main()
