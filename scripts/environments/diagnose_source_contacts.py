"""Read-only source geometry evidence for route seams and palm root contact."""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).parent))
from build_world import OUT
from scene_kit import ground


def route_junction():
    directory = OUT / 'alpine-lake'
    bpy.ops.wm.open_mainfile(filepath=str(directory / 'Four_Horizons_alpine_lake.blend'))
    trees = {}
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not obj.get('ground_route'):
            continue
        bounds = [obj.matrix_world @ Vector(v) for v in obj.bound_box]
        if min(v.x for v in bounds) > 172 or max(v.x for v in bounds) < 138:
            continue
        if min(-v.y for v in bounds) > 1247 or max(-v.y for v in bounds) < 1213:
            continue
        vertices = [obj.matrix_world @ v.co for v in obj.data.vertices]
        faces = [list(p.vertices) for p in obj.data.polygons if p.normal.z > .1]
        if faces:
            trees[obj.name] = BVHTree.FromPolygons(vertices, faces)
    pairs = {}
    samples = []
    for ix in range(121):
        for iz in range(121):
            x, z = 140 + ix * .25, 1215 + iz * .25
            hits = []
            for name, tree in trees.items():
                hit, normal, index, distance = tree.ray_cast(Vector((x, -z, 500)), Vector((0, 0, -1)), 1000)
                if hit is not None:
                    hits.append((name, hit.z))
            if len(hits) > 1:
                for i, first in enumerate(hits):
                    for second in hits[i + 1:]:
                        if ('/Network/' in first[0]) == ('/Network/' in second[0]):
                            continue
                        gap = abs(first[1] - second[1])
                        key = first[0] + ' | ' + second[0]
                        record = {'objects': [first[0], second[0]], 'gapMeters': gap,
                                  'point': [x, z], 'heights': [first[1], second[1]],
                                  'terrainHeight': ground(x, z)}
                        if key not in pairs or pairs[key]['gapMeters'] < gap:
                            pairs[key] = record
                        if math.dist((x, z), (155, 1230)) < 5 and gap > .02:
                            samples.append(record)
    report = {'readOnly': True, 'junction': [155, 1230], 'objects': list(trees),
              'pairMaximumGaps': sorted(pairs.values(), key=lambda r: -r['gapMeters']),
              'innerJunctionSamplesOver2cm': sorted(samples, key=lambda r: -r['gapMeters'])[:30]}
    (directory / 'junction_contact_diagnosis.json').write_text(json.dumps(report, indent=2))
    print('JUNCTION_CONTACT_DIAGNOSIS', json.dumps(report['pairMaximumGaps']), flush=True)


def palm_roots():
    directory = OUT / 'sunstone-oasis'
    bpy.ops.wm.open_mainfile(filepath=str(directory / 'Four_Horizons_sunstone_oasis.blend'))
    records = []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or obj.get('asset_role') != 'branching_wood' or not str(obj.get('prototype_id', '')).startswith('palm/'):
            continue
        # The shared palm starts with its authored twelve-vertex trunk base ring.
        ring = [obj.matrix_world @ obj.data.vertices[i].co for i in range(12)]
        exposure = max(v.z - ground(v.x, -v.y) for v in ring)
        if exposure <= .04:
            continue
        center = obj.matrix_world.translation
        radius = math.hypot((center.x - 1510) / 150, (-center.y - 1450) / 105)
        if radius > 1.8:
            continue
        identity = obj.name.rsplit('/', 1)[0]
        assembly = [obj.name, identity + '/articulated-foliage']
        assert all(bpy.data.objects.get(name) for name in assembly)
        records.append({'id': identity, 'objects': assembly,
                        'center': [center.x, center.z, -center.y],
                        'maximumBaseExposureMeters': exposure,
                        'buryTranslationY': -(exposure + .025),
                        'shoreRadius': radius,
                        'meshIds': [bpy.data.objects[name].data.name for name in assembly]})
    records.sort(key=lambda r: -r['maximumBaseExposureMeters'])
    report = {'readOnly': True, 'method': 'Exact transformed twelve-vertex palm trunk base ring compared to rendered terrain triangulation',
              'scope': 'Oasis palms within normalized radius1.8; only base exposure above4cm',
              'preservation': 'Proposed move applies equally to branching wood and articulated foliage; no vertex, scale, yaw or material change',
              'assemblies': records}
    (directory / 'palm_root_contact_diagnosis.json').write_text(json.dumps(report, indent=2))
    print('PALM_ROOT_CONTACT_DIAGNOSIS', len(records), json.dumps(records[:8]), flush=True)


route_junction()
palm_roots()
