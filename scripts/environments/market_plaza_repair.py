"""Restore a strict, continuous sand-path datum across the canyon market square."""
import json
import math
import struct

PLAZA = 'REG_CANYON/CAN_Market_PublicSquare'
PATH = 'REG_CANYON/CAN_Oasis_Access'
MARKER = 'market_plaza_contact_v1'


def area(poly):
    return abs(sum(a[0] * b[2] - a[2] * b[0] for a, b in zip(poly, poly[1:] + poly[:1]))) / 2


def intersection(a, b):
    from terrain_fit_paths import _clip, _area
    result = list(a)
    sign = 1 if _area(*b) > 0 else -1
    for p, q in zip(b, b[1:] + b[:1]):
        dx, dz = q[0] - p[0], q[2] - p[2]
        result = _clip(result, sign * dz, -sign * dx, sign * (dz * p[0] - dx * p[2]))
        if len(result) < 3:
            return []
    return result if area(result) > 1e-9 else []


def height(triangle, x, z):
    a, b, c = triangle
    den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den
    v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den
    return u * a[1] + v * b[1] + (1 - u - v) * c[1]


def bbox(t):
    return min(p[0] for p in t), min(p[2] for p in t), max(p[0] for p in t), max(p[2] for p in t)


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def contact_audit(path_triangles, plaza_triangles):
    records = []
    plaza_bounds = [bbox(t) for t in plaza_triangles]
    minimum, maximum, total_area = math.inf, -math.inf, 0
    for index, triangle in enumerate(path_triangles):
        bounds = bbox(triangle)
        for plaza, pb in zip(plaza_triangles, plaza_bounds):
            if not overlaps(bounds, pb):
                continue
            polygon = intersection(triangle, plaza)
            if not polygon:
                continue
            values = [height(triangle, p[0], p[2]) - height(plaza, p[0], p[2]) for p in polygon]
            minimum, maximum = min(minimum, *values), max(maximum, *values)
            total_area += area(polygon)
            records.append(index)
    return {'minimumGapMeters': minimum, 'maximumGapMeters': maximum,
            'intersectingTrianglePairs': len(records), 'summedIntersectionAreaM2': total_area,
            'overlappingPathTriangles': sorted(set(records))}


def segment_distance(x, z, a, b):
    dx, dz = b[0] - a[0], b[2] - a[2]
    den = dx * dx + dz * dz
    t = max(0, min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / den)) if den else 0
    return math.hypot(x - a[0] - dx * t, z - a[2] - dz * t)


def repair_geometry(vertices, triangles, plaza_triangles, raise_meters=.02, blend_meters=6):
    path_triangles = [tuple(vertices[i] for i in t) for t in triangles]
    before = contact_audit(path_triangles, plaza_triangles)
    if not before['overlappingPathTriangles']:
        raise RuntimeError('The expected market crossing is absent.')
    plateau = [path_triangles[i] for i in before['overlappingPathTriangles']]
    plateau_points = {(p[0], p[2]) for t in plateau for p in t}
    moved = []
    for x, y, z in vertices:
        if (x, z) in plateau_points:
            delta = raise_meters
        else:
            distance = min(segment_distance(x, z, a, b) for t in plateau for a, b in zip(t, t[1:] + t[:1]))
            t = max(0, min(1, 1 - distance / blend_meters))
            delta = raise_meters * t * t * (3 - 2 * t)
        # Source meshes store Float32 positions; prove separation after that storage.
        moved.append((x, struct.unpack('<f', struct.pack('<f', y + delta))[0], z))
    after = contact_audit([tuple(moved[i] for i in t) for t in triangles], plaza_triangles)
    if after['minimumGapMeters'] < .015:
        raise RuntimeError('The repaired crossing is not strictly separated: ' + repr(after))
    deltas = [b[1] - a[1] for a, b in zip(vertices, moved)]
    return moved, {'before': before, 'after': after, 'maximumRaiseMeters': max(deltas),
                   'minimumRaiseMeters': min(deltas), 'movedVertices': sum(d > 1e-7 for d in deltas),
                   'totalVertices': len(vertices), 'triangles': len(triangles),
                   'blendMeters': blend_meters, 'verticesAdded': 0, 'trianglesAdded': 0}


def source_geometry(obj):
    vertices = []
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        vertices.append((p.x, p.z, -p.y))
    obj.data.calc_loop_triangles()
    return vertices, [tuple(t.vertices) for t in obj.data.loop_triangles]


def repair_market_plaza():
    import bpy
    from mathutils import Vector
    objects = {o.name: o for o in bpy.context.scene.objects}
    path, plaza = objects[PATH], objects[PLAZA]
    vertices, triangles = source_geometry(path)
    pv, pt = source_geometry(plaza)
    plaza_triangles = [tuple(pv[i] for i in t) for t in pt]
    if path.get(MARKER):
        report = json.loads(path['market_plaza_contact_report'])
        current = contact_audit([tuple(vertices[i] for i in t) for t in triangles], plaza_triangles)
        if current['minimumGapMeters'] < .015:
            raise RuntimeError('A marked market contact has lost its verified separation.')
        return {**report, 'idempotent': True, 'currentContact': current}
    if path.data.users != 1:
        raise RuntimeError('The target path unexpectedly shares editable mesh data.')
    moved, report = repair_geometry(vertices, triangles, plaza_triangles)
    inverse = path.matrix_world.inverted()
    for vertex, (x, y, z) in zip(path.data.vertices, moved):
        vertex.co = inverse @ Vector((x, -z, y))
    path.data.update()
    report.update(id=MARKER, target=PATH, plaza=PLAZA,
                  scope='Only oasis-access vertex elevations; topology, UVs, materials and identities preserved.')
    path[MARKER] = True
    path['market_plaza_contact_report'] = json.dumps(report, separators=(',', ':'))
    return report


def audit_export(path):
    from audit_built_network import GLB
    reader = GLB(path)
    try:
        report = contact_audit(reader.surface(PATH)['triangles'], reader.surface(PLAZA)['triangles'])
        report.update(target=PATH, plaza=PLAZA, passes=report['minimumGapMeters'] >= .015)
        return report
    finally:
        reader.close()


def compare_unaffected_export(before_path, after_path):
    """Compare actual exported accessor bytes once per mesh, preserving all other art."""
    import hashlib
    from audit_built_network import GLB
    readers = [GLB(before_path), GLB(after_path)]
    try:
        before, after = readers
        if set(before.nodes) != set(after.nodes):
            raise RuntimeError('Export changed world object identities.')
        caches = [{}, {}]
        def mesh_signature(reader, index, cache):
            if index in cache:
                return cache[index]
            def accessor_signature(index):
                a = reader.doc['accessors'][index]
                v = reader.doc['bufferViews'][a['bufferView']]
                count = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
                size = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[a['componentType']] * count
                stride = v.get('byteStride', size)
                start = reader.binary + v.get('byteOffset', 0) + a.get('byteOffset', 0)
                digest = hashlib.sha256()
                if size == stride:
                    digest.update(reader.data[start:start + size * a['count']])
                else:
                    for i in range(a['count']):
                        digest.update(reader.data[start + i * stride:start + i * stride + size])
                return a['type'], a['componentType'], a['count'], digest.hexdigest()
            value = []
            for p in reader.doc['meshes'][index]['primitives']:
                value.append({'attributes': {k: accessor_signature(v) for k, v in p['attributes'].items()},
                              'indices': accessor_signature(p['indices']), 'mode': p.get('mode', 4),
                              'material': reader.doc['materials'][p['material']]})
            cache[index] = value
            return value
        compared = 0
        for name in before.nodes:
            a = before.doc['nodes'][before.nodes[name]]
            b = after.doc['nodes'][after.nodes[name]]
            for key in ('translation', 'rotation', 'scale', 'matrix'):
                if a.get(key) != b.get(key):
                    raise RuntimeError('Export changed object placement: ' + name)
            if name == PATH:
                if before.triangle_count(a['mesh']) != after.triangle_count(b['mesh']):
                    raise RuntimeError('Target path triangle count changed.')
                continue
            if mesh_signature(before, a['mesh'], caches[0]) != mesh_signature(after, b['mesh'], caches[1]):
                raise RuntimeError('Unaffected geometry/material export changed: ' + name)
            compared += 1
        return {'passes': True, 'unchangedOtherObjects': compared,
                'objectIdentitiesPreserved': len(before.nodes), 'allObjectTransformsPreserved': True,
                'otherGeometryAttributesIndicesMaterialsByteIdentical': True}
    finally:
        for reader in readers:
            reader.close()
