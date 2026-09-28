"""Separate only positively overlapping coplanar route strips without retessellation.

The geometry planner is dependency-free and is also used by Context.path. Running
this file in Blender repairs one existing biome source and its faithful GLB export.
"""
import math

SEPARATION = .0043
COPLANAR_TOLERANCE = .000025


def _area(poly):
    return sum(a[0] * b[1] - a[1] * b[0] for a, b in zip(poly, poly[1:] + poly[:1])) * .5


def _intersection(subject, clip):
    poly = subject
    orientation = 1 if _area(clip) > 0 else -1
    for a, b in zip(clip, clip[1:] + clip[:1]):
        out = []
        for p, q in zip(poly, poly[1:] + poly[:1]):
            dp = orientation * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]))
            dq = orientation * ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]))
            if dp >= 0:
                out.append(p)
            if (dp >= 0) != (dq >= 0):
                t = dp / (dp - dq)
                out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
        poly = out
        if not poly:
            break
    return poly


def _plane(points):
    a, b, c = points[:3]
    ux, uz, uy = b[0] - a[0], b[2] - a[2], b[1] - a[1]
    vx, vz, vy = c[0] - a[0], c[2] - a[2], c[1] - a[1]
    determinant = ux * vz - uz * vx
    if abs(determinant) < 1e-10:
        return None
    px = (uy * vz - uz * vy) / determinant
    pz = (ux * vy - uy * vx) / determinant
    return px, pz, a[1] - px * a[0] - pz * a[2]


def _height(plane, x, z):
    return plane[0] * x + plane[1] * z + plane[2]


def _bounds(poly):
    return min(p[0] for p in poly), min(p[1] for p in poly), max(p[0] for p in poly), max(p[1] for p in poly)


def _bbox_overlap(a, b):
    return min(a[2], b[2]) - max(a[0], b[0]) > 1e-6 and min(a[3], b[3]) - max(a[1], b[1]) > 1e-6


def _surface_overlap(a, b):
    if not _bbox_overlap(a['bbox'], b['bbox']):
        return 0.0
    intersection = _intersection(a['poly'], b['poly'])
    if len(intersection) < 3:
        return 0.0
    area = abs(_area(intersection))
    if area < 1e-6:
        return 0.0
    if max(abs(_height(a['plane'], *p) - _height(b['plane'], *p)) for p in intersection) > COPLANAR_TOLERANCE:
        return 0.0
    return area


def segment_ranges(points):
    ranges = []
    vertex_offset = face_offset = 0
    for a, b in zip(points, points[1:]):
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        if length < .01:
            continue
        samples = max(1, math.ceil(length / 5))
        vertex_end = vertex_offset + 2 * (samples + 1)
        face_end = face_offset + 2 * samples
        ranges.append((vertex_offset, vertex_end, face_offset, face_end))
        vertex_offset, face_offset = vertex_end, face_end
    return ranges


class RouteSurfaceLayers:
    """Graph-color exact geometric overlaps; keep every vertex and triangle."""

    def __init__(self):
        self.groups = []
        self.grid = {}

    @staticmethod
    def _cells(bbox):
        for x in range(math.floor(bbox[0] / 64), math.floor(bbox[2] / 64) + 1):
            for z in range(math.floor(bbox[1] / 64), math.floor(bbox[3] / 64) + 1):
                yield x, z

    def apply(self, name, vertices, faces, ranges):
        output = [list(v) for v in vertices]
        changes = []
        for index, (v0, v1, f0, f1) in enumerate(ranges):
            local = vertices[v0:v1]
            poly = [(local[i][0], local[i][2]) for i in (0, 1, len(local) - 1, len(local) - 2)]
            plane = _plane([vertices[i] for i in faces[f0]])
            planar = plane is not None and all(abs(v[1] - _height(plane, v[0], v[2])) < COPLANAR_TOLERANCE for v in local)
            group = {'name': name, 'segment': index, 'bbox': _bounds(poly), 'poly': poly,
                     'plane': plane if planar else None, 'layer': 0, 'triangles': []}
            if not planar:
                for face in faces[f0:f1]:
                    tri = [vertices[i] for i in face]
                    tp = _plane(tri)
                    if tp is not None:
                        p = [(v[0], v[2]) for v in tri]
                        group['triangles'].append({'poly': p, 'bbox': _bounds(p), 'plane': tp})
            candidates = set()
            for cell in self._cells(group['bbox']):
                candidates.update(self.grid.get(cell, []))
            neighbors = []
            for prior in sorted(candidates):
                other = self.groups[prior]
                if not _bbox_overlap(group['bbox'], other['bbox']):
                    continue
                surfaces_a = [group] if planar else group['triangles']
                surfaces_b = [other] if other['plane'] is not None else other['triangles']
                area = sum(_surface_overlap(a, b) for a in surfaces_a for b in surfaces_b)
                if area > 1e-6:
                    neighbors.append((prior, area))
            forbidden = {self.groups[i]['layer'] for i, _ in neighbors}
            while group['layer'] in forbidden:
                group['layer'] += 1
            offset = group['layer'] * SEPARATION
            if offset:
                for i in range(v0, v1):
                    output[i][1] += offset
            if neighbors:
                changes.append({'segment': index, 'offsetMeters': offset, 'layer': group['layer'],
                                'overlaps': [{'path': self.groups[i]['name'], 'segment': self.groups[i]['segment'],
                                              'coplanarAreaM2': round(area, 7)} for i, area in neighbors]})
            group_id = len(self.groups)
            self.groups.append(group)
            for cell in self._cells(group['bbox']):
                self.grid.setdefault(cell, []).append(group_id)
        return output, changes


def main():
    import bpy
    import argparse
    import json
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent))
    from scene_kit import ground
    from build_world import OUT, PUBLIC, DEFINITIONS
    from build_meadow_harbor import build_meadow, build_harbor
    from build_alpine_canyon import build_alpine, build_canyon

    parser = argparse.ArgumentParser()
    parser.add_argument('--biome', required=True)
    parser.add_argument('--audit-only', action='store_true')
    parser.add_argument('--render', nargs='*', default=[])
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    definition = next(d for d in DEFINITIONS if d['id'] == args.biome)
    directory = OUT / args.biome
    source = directory / ('Four_Horizons_' + args.biome.replace('-', '_') + '.blend')
    bpy.ops.wm.open_mainfile(filepath=str(source))
    scene = bpy.context.scene

    terrain_sample = ground
    class Recorder:
        ground = staticmethod(terrain_sample)
        def __init__(self): self.paths = []
        def path(self, name, points, width, material, lift=.08): self.paths.append((name, points))
        def __getattr__(self, name):
            if name.startswith('_') or name in ('meshes','materials'):raise AttributeError(name)
            return lambda *a, **kw: None

    recorder = Recorder()
    builders = {'verdant-airfield': build_meadow, 'azure-port': build_harbor,
                'alpine-lake': build_alpine, 'sunstone-oasis': build_canyon}
    builders[args.biome](recorder)
    planner = RouteSurfaceLayers()
    report = {'biome': args.biome, 'source': str(source), 'operation': 'Separate positively overlapping coplanar road strips',
              'separationPerLayerMeters': SEPARATION, 'coplanarToleranceMeters': COPLANAR_TOLERANCE,
              'preserves': ['object count', 'vertex count', 'triangle count', 'materials', 'horizontal placement', 'source detail'],
              'pathsInspected': len(recorder.paths), 'changedPaths': [], 'coincidentOverlaps': []}
    for name, points in recorder.paths:
        obj = scene.objects.get(definition['region'] + '/' + name)
        if obj is None:
            raise RuntimeError('Existing route object missing: ' + name)
        if any(abs(obj.matrix_world[i][j] - (1 if i == j else 0)) > 1e-7 for i in range(4) for j in range(4)):
            raise RuntimeError('Route transform requires explicit handling: ' + name)
        verts = [(v.co.x, v.co.z, -v.co.y) for v in obj.data.vertices]
        faces = [tuple(p.vertices) for p in obj.data.polygons]
        ranges = segment_ranges(points)
        if ranges[-1][1] != len(verts) or ranges[-1][3] != len(faces):
            raise RuntimeError('Existing route topology differs from captured source: ' + name)
        old_offsets = json.loads(obj.get('route_surface_offsets', '{}'))
        for segment, offset in old_offsets.items():
            v0, v1, _, _ = ranges[int(segment)]
            for i in range(v0, v1):
                x, y, z = verts[i]
                verts[i] = (x, y - offset, z)
        output, overlaps = planner.apply(name, verts, faces, ranges)
        if overlaps:
            report['coincidentOverlaps'].append({'path': name, 'segments': overlaps})
        offsets = {str(item['segment']): item['offsetMeters'] for item in overlaps if item['offsetMeters']}
        moved = sum(abs(output[i][1] - obj.data.vertices[i].co.z) > 1e-7 for i in range(len(output)))
        if moved:
            report['changedPaths'].append({'path': name, 'movedVertices': moved, 'maxOffsetMeters': max(offsets.values(), default=0)})
        if not args.audit_only:
            for i, vertex in enumerate(output):
                obj.data.vertices[i].co.z = vertex[1]
            obj.data.update()
            obj['route_surface_offsets'] = json.dumps(offsets, sort_keys=True)
            obj['route_surface_repair'] = 'Positive-area coplanar overlap graph; 4.3 mm per surface layer'
            layers = [planner.groups[len(planner.groups) - len(ranges) + i]['layer'] for i in range(len(ranges))]
            obj['ground_route'] = True
            obj['route_layer'] = max(layers, default=0)
            obj['route_segment_layers'] = layers
    report['modified'] = bool(report['changedPaths'])
    report['auditOnly'] = args.audit_only
    report['maximumOffsetMeters'] = max((x['maxOffsetMeters'] for x in report['changedPaths']), default=0)
    report['unresolvedCoplanarPairCount'] = sum(
        1 for i, group in enumerate(planner.groups) for other in planner.groups[:i]
        if group['layer'] == other['layer'] and group['plane'] is not None and other['plane'] is not None
        and _surface_overlap(group, other) > 1e-6)
    if report['unresolvedCoplanarPairCount']:
        raise RuntimeError('Coplanar overlap remains after assigned layers')
    suffix = 'route_surface_audit.json' if args.audit_only else 'route_surface_repair.json'
    (directory / suffix).write_text(json.dumps(report, indent=2), encoding='utf-8')
    if not args.audit_only:
        before = {'objects': sum(o.type == 'MESH' for o in scene.objects), 'triangles': 0, 'vertices': 0}
        for obj in scene.objects:
            if obj.type == 'MESH':
                obj.data.calc_loop_triangles()
                before['triangles'] += len(obj.data.loop_triangles)
                before['vertices'] += len(obj.data.vertices)
        report['countsAfterRepair'] = before
        bpy.ops.wm.save_as_mainfile(filepath=str(source), compress=False)
        bpy.ops.export_scene.gltf(filepath=str(PUBLIC / (args.biome + '.glb')), export_format='GLB',
            use_selection=False, export_cameras=False, export_lights=False, export_animations=False,
            export_yup=True, export_apply=False, export_extras=True, export_texcoords=True,
            export_normals=True, export_materials='EXPORT', export_draco_mesh_compression_enable=False)
        cameras = {'aerial': 'CAM_Aerial', 'street': 'CAM_street', 'village': 'CAM_Village'}
        for view in args.render:
            scene.camera = scene.objects[cameras[view]]
            scene.render.filepath = str(directory / 'renders' / ('pass-4-' + view + '.png'))
            bpy.ops.render.render(write_still=True)
        report['renderedViews'] = args.render
        (directory / suffix).write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('ROUTE_SURFACE_REPAIR', json.dumps({k: v for k, v in report.items() if k != 'coincidentOverlaps'}), flush=True)


if __name__ == '__main__':
    main()
