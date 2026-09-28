"""Replay all four builders and audit their metre-scale spatial contracts.

Uses draw_layout.Capture and pure convex geometry. Does not import Blender,
numpy, shapely, or generated scene specifications from the previous world.
"""
from __future__ import annotations

import hashlib
import ast
import json
import math
import random
import sys
from pathlib import Path

from draw_layout import Capture, load_ground, module, footprint
from layout_datums import entry_anchor, facade_bays
from repair_routes import _area, _intersection, _bounds, _bbox_overlap


ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent
OUTPUT = ROOT / 'artifacts/four-horizons/reference_rebuild_layout_validation.json'
EPSILON = 1e-5


def distance_to_segment(point, a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]
    length2 = dx * dx + dz * dz
    t = max(0, min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length2)) if length2 else 0
    closest = [a[0] + t * dx, a[1] + t * dz]
    return math.dist(point, closest), closest


def distance_to_path(point, route):
    return min((distance_to_segment(point, a, b) for a, b in zip(route['points'], route['points'][1:])),
               default=(float('inf'), None), key=lambda value: value[0])


def convex_contains(point, poly):
    signs = [(b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
             for a, b in zip(poly, poly[1:] + poly[:1])]
    return all(value >= -EPSILON for value in signs) or all(value <= EPSILON for value in signs)


def polygon_gap(a, b):
    if overlap(a, b)[0] > EPSILON or convex_contains(a[0], b) or convex_contains(b[0], a):
        return 0
    return min(distance_to_segment(p, q, r)[0] for p, poly in
               [(p, b) for p in a] + [(p, a) for p in b]
               for q, r in zip(poly, poly[1:] + poly[:1]))


def overlap(a, b):
    if not _bbox_overlap(_bounds(a), _bounds(b)):
        return 0, []
    polygon = _intersection(a, b)
    return (abs(_area(polygon)), polygon) if len(polygon) >= 3 else (0, [])


def route_strips(route):
    result = []
    for index, (a, b) in enumerate(zip(route['points'], route['points'][1:])):
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dz)
        if length < .01:
            continue
        nx, nz = -dz / length * route['width'] / 2, dx / length * route['width'] / 2
        polygon = [[a[0] + nx, a[1] + nz], [a[0] - nx, a[1] - nz],
                   [b[0] - nx, b[1] - nz], [b[0] + nx, b[1] + nz]]
        result.append({'polygon': polygon, 'segment': index})
    return result


def distance_to_route_surface(point, route):
    """Exact uncapped source strip distance; a wide plaza has no round end caps."""
    candidates = []
    for strip in route_strips(route):
        poly = strip['polygon']
        if convex_contains(point, poly):
            return 0, list(point)
        candidates.extend(distance_to_segment(point, a, b) for a, b in zip(poly, poly[1:] + poly[:1]))
    return min(candidates, key=lambda item: item[0], default=(float('inf'), None))


def projection_polygon(x, z, width, depth, yaw, rear=.80):
    # This is the architecture contract's reserved envelope, deliberately broader
    # than local roof, shutter and porch pieces. It is not a solid wall polygon.
    center_offset = (1.65 - rear) / 2
    return footprint(x + center_offset * math.sin(yaw), z + center_offset * math.cos(yaw),
                     width + 1.60, depth + rear + 1.65, yaw)


class Vector:
    """Small source-replay vector; deliberately independent of mathutils/numpy."""
    def __init__(self, values=(0, 0, 0)):
        self.values = tuple(values)
    def __iter__(self): return iter(self.values)
    def __getitem__(self, index): return self.values[index]
    def __add__(self, other): return Vector(a + b for a, b in zip(self, other))
    def __sub__(self, other): return Vector(a - b for a, b in zip(self, other))
    def __mul__(self, scalar): return Vector(a * scalar for a in self)
    __rmul__ = __mul__
    def __truediv__(self, scalar): return Vector(a / scalar for a in self)
    def __neg__(self): return Vector(-a for a in self)
    @property
    def x(self): return self.values[0]
    @property
    def y(self): return self.values[1]
    @property
    def z(self): return self.values[2]
    @property
    def length(self): return math.sqrt(sum(a * a for a in self))
    def normalized(self): return self / self.length
    def dot(self, other): return sum(a * b for a, b in zip(self, other))
    def cross(self, other):
        a, b, c = self; x, y, z = other
        return Vector((b * z - c * y, c * x - a * z, a * y - b * x))


class BoundsAssembly:
    """Replay exact component vertices for a flagged pair without creating meshes."""
    def __init__(self, ctx, name, x, z, base, yaw):
        self.ctx, self.name, self.x, self.z, self.base = ctx, name, x, z, base
        self.c, self.s = math.cos(yaw), math.sin(yaw)
        self.component_count, self.parts = 0, {}
    def poly(self, role, vertices, faces, material, smooth=False):
        bounds = self.parts.setdefault(role, [float('inf')] * 3 + [-float('inf')] * 3)
        for p in vertices:
            world = (self.x + p[0] * self.c + p[2] * self.s, self.base + p[1], self.z - p[0] * self.s + p[2] * self.c)
            for axis in range(3):
                bounds[axis] = min(bounds[axis], world[axis]); bounds[axis + 3] = max(bounds[axis + 3], world[axis])
        self.component_count += 1
    def box(self, role, center, size, material, axes=None, bevel=0):
        if min(size) <= 0: return
        center = Vector(center); axes = [Vector(axis) for axis in (axes or ((1, 0, 0), (0, 1, 0), (0, 0, 1)))]
        vertices = [center + sum((axes[i] * size[i] * signs[i] / 2 for i in range(3)), Vector())
                    for signs in ((x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1))]
        self.poly(role, vertices, [], material)
    def beam(self, role, start, end, width, depth, material, bevel=0):
        start, end = Vector(start), Vector(end); delta = end - start
        if delta.length < 1e-6: return
        along = delta.normalized(); across = along.cross(Vector((0, 1, 0)) if abs(along.y) < .96 else Vector((1, 0, 0))).normalized()
        self.box(role, (start + end) / 2, (width, delta.length, depth), material, (across, along, across.cross(along).normalized()), bevel)
    def tube(self, role, start, end, radius, material, sides=12, end_radius=None):
        start, end = Vector(start), Vector(end); delta = end - start
        if delta.length < 1e-6: return
        axis = delta.normalized(); u = axis.cross(Vector((0, 1, 0)) if abs(axis.y) < .96 else Vector((1, 0, 0))).normalized(); v = axis.cross(u).normalized()
        self.poly(role, [point + r * (u * math.cos(i * math.tau / sides) + v * math.sin(i * math.tau / sides))
                        for point, r in ((start, radius), (end, radius if end_radius is None else end_radius)) for i in range(sides)], [], material)
    def finish(self, style):
        self.ctx.exact_component_bounds[self.name] = self.parts
        return list(self.parts)


def replay_component_bounds(ctx, buildings):
    class Palette(dict):
        def __missing__(self, key): return key
    source = ast.parse((SOURCE / 'detailed_architecture.py').read_text(encoding='utf-8'))
    definitions = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name not in
                   {'surface_images', 'textured_material', 'palette'} or isinstance(node, ast.ClassDef) and node.name == 'Face']
    env = {'math': math, 'random': random, 'hashlib': hashlib, 'Vector': Vector, 'UP': Vector((0, 1, 0)),
           'TAU': math.tau, 'Assembly': BoundsAssembly, 'facade_bays': facade_bays, 'entry_anchor': entry_anchor,
           'palette': lambda ctx, wall, roof: Palette(wall=wall, roof=roof)}
    exec(compile(ast.Module(body=definitions, type_ignores=[]), 'architecture_pure_component_replay', 'exec'), env)
    class Context:
        region = ctx.region
        ground = staticmethod(ctx.ground)
        buildings = []
        exact_component_bounds = {}
    capture = Context()
    for building in buildings:
        x, z = building['center']; w, h, d = building['dimensions']
        env['build_building'](capture, building['id'].split('/', 1)[1], x, z, w, d, h,
                              'plaster', building['roofMaterial'], building['yaw'], building['family'])
    return capture.exact_component_bounds


class AuditCapture(Capture):
    def __init__(self, region, ground):
        super().__init__(region, ground)
        self.buildings = []
        self.extra_obstacles = []

    def building(self, name, x, z, w, d, h, material, roofmat, yaw=0, style='mediterranean'):
        style = {'farmhouse': 'cottage', 'rural': 'cottage', 'desert': 'adobe',
                 'merchant': 'mediterranean', 'townhouse': 'mediterranean', 'warehouse': 'mediterranean'}.get(style, style)
        seed = int(hashlib.sha256((self.region + '/' + name).encode()).hexdigest()[:8], 16)
        positions, step, door_bay = facade_bays(w)
        building = {'id': self.region + '/' + name, 'center': [x, z], 'dimensions': [w, h, d],
            'yaw': yaw, 'family': style, 'variant': seed % 12, 'roof': {'eaves': h}, 'roofMaterial': roofmat,
            'entryAnchor': entry_anchor(x, z, w, d, yaw), 'doorCenter': entry_anchor(x, z, w, d, yaw, 0),
            'doorWidth': min(1.34, step - .48), 'footprint': footprint(x, z, w, d, yaw),
            'projectionEnvelope': projection_polygon(x, z, w, d, yaw, 1.0 if seed % 3 == 0 else .80),
            'projectionReservationMeters': {'side': .80, 'rear': 1.0 if seed % 3 == 0 else .80, 'front': 1.65},
            'rearStepCorrection': 'Rear door variants include the source step extent of .995 m.' if seed % 3 == 0 else None}
        self.buildings.append(building)
        return building

    def box(self, name, x, y, z, w, h, d, material, yaw=0):
        super().box(name, x, y, z, w, h, d, material, yaw)
        if h > 2 and ('ControlTower' in name or 'Hangar' in name or 'FuelTank' in name):
            self.extra_obstacles.append({'id': self.region + '/' + name, 'polygon': footprint(x, z, w, d, yaw),
                                         'bottom': y - h / 2, 'top': y + h / 2})


def route_kind(route):
    name = route['id'].lower()
    if '/curb' in name:
        return 'curb'
    if name.endswith('/entry') or 'entryapproach' in name or 'courtyardapproach' in name:
        return 'door-approach'
    if name.endswith('/court'):
        return 'private-court'
    if 'taxiway' in name or 'apron' in name:
        return 'airfield-ground-route'
    return 'public-route'


def own_route(building, route):
    prefix = building['id']
    return route['id'].startswith(prefix + '/') or route['id'].startswith(prefix + '_') or (
        prefix.endswith('CAN_Watchtower_Base') and 'CAN_Watchtower_Approach' in route['id'])


def audit_entries(ctx):
    checks, issues = [], []
    routes = [route for route in ctx.paths if route_kind(route) != 'curb']
    for building in ctx.buildings:
        anchor = building['entryAnchor']
        candidates = [route for route in routes if own_route(building, route)]
        if candidates:
            route, point = min(((route, point) for route in candidates for point in (route['points'][0], route['points'][-1])),
                               key=lambda pair: math.dist(pair[1], anchor))
            dx, dz = point[0] - building['doorCenter'][0], point[1] - building['doorCenter'][1]
            lateral = dx * math.cos(building['yaw']) - dz * math.sin(building['yaw'])
            outward = dx * math.sin(building['yaw']) + dz * math.cos(building['yaw'])
            record = {'building': building['id'], 'route': route['id'], 'entryAnchor': anchor,
                'routeEndpoint': point, 'lateralOffsetMeters': round(lateral, 5), 'outwardOffsetMeters': round(outward, 5),
                'anchorDistanceMeters': round(math.dist(anchor, point), 5),
                'aligned': abs(lateral) <= .05 and .1 <= outward <= 1.0}
            if not record['aligned']:
                issues.append({'type': 'entry-endpoint-alignment', **record})
        else:
            route, clearance, nearest = min(((route, *distance_to_route_surface(anchor, route)) for route in routes), key=lambda item: item[1])
            record = {'building': building['id'], 'entryAnchor': anchor, 'route': route['id'], 'nearestSurfacePoint': nearest,
                'uncoveredApproachMeters': round(clearance, 5), 'aligned': clearance <= .65,
                'method': 'No named approach; distance to nearest usable route strip.'}
            if not record['aligned']:
                issues.append({'type': 'entry-route-gap', **record})
        checks.append(record)
    return checks, issues


def forest_masks(ctx, layout):
    masks = []
    landscape = layout.get('landscape', {})
    for index, (x, z, rx, rz) in enumerate(landscape.get('woodland_belts', [])):
        masks.append({'id': f'woodland-belt-{index}', 'type': 'ellipse', 'center': [x, z], 'radii': [rx, rz]})
    details = getattr(ctx, 'environment_layout', layout.get('layout', {}))
    for index, item in enumerate(details.get('forestBelts', []) + details.get('oasisGroves', [])):
        masks.append({'id': f'ecological-belt-{index}', **item})
    for group in ('foothillGroves', 'irrigatedGroves'):
        for index, item in enumerate(details.get(group, [])):
            masks.append({'id': f'{group}-{index}', 'type': 'ellipse', **item})
    return masks


def inside_mask(point, mask, region):
    x, z = point
    if mask['type'] == 'ellipse':
        cx, cz = mask['center']; rx, rz = mask['radii']
        return ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 < 1
    if 'bounds' in mask:
        x0, x1, z0, z1 = mask['bounds']
        return x0 < x < x1 and z0 < z < z1
    if 'centerline' in mask:
        return min(distance_to_segment(point, a, b)[0] for a, b in zip(mask['centerline'], mask['centerline'][1:])) < mask['halfWidthMeters']
    if 'waterContour' in mask:
        cx, cz, rx, rz = (-100, 1510, 240, 175) if region == 'REG_ALPINE' else (1510, 1450, 150, 105)
        a = math.atan2((z - cz) / rz, (x - cx) / rx) % math.tau
        contour = mask['waterContour']
        sx, sz = contour[round(a / math.tau * len(contour)) % len(contour)]
        offset = math.hypot(x - cx, z - cz) - math.hypot(sx - cx, sz - cz)
        depth = max(35, min(65, 48 + 13 * math.sin(a * 3 + .6) + 5 * math.sin(a * 7))) if region == 'REG_ALPINE' else max(20, min(45, 33 + 12 * math.sin(a * 4 + .5)))
        return mask['innerOffsetMeters'] < offset < depth
    return False


def spacing(trees):
    if len(trees) < 2:
        return {'count': len(trees), 'minimumMeters': None, 'medianMeters': None, 'p95Meters': None, 'closestPair': None}
    nearest = []
    closest = None
    for index, tree in enumerate(trees):
        other_index, distance = min(((j, math.dist(tree['center'], other['center'])) for j, other in enumerate(trees) if j != index), key=lambda item: item[1])
        nearest.append(distance)
        if closest is None or distance < closest['distanceMeters']:
            closest = {'ids': [tree['id'], trees[other_index]['id']], 'positions': [tree['center'], trees[other_index]['center']], 'distanceMeters': distance}
    nearest.sort()
    return {'count': len(trees), 'minimumMeters': round(nearest[0], 4), 'medianMeters': round(nearest[len(nearest) // 2], 4),
            'p95Meters': round(nearest[min(len(nearest) - 1, math.floor(len(nearest) * .95))], 4),
            'maximumMeters': round(nearest[-1], 4), 'closestPair': closest}


def audit_region(ctx, layout):
    footprints, envelopes, crossings, envelope_route_contacts, tree_conflicts = [], [], [], [], []
    smallest_wall_gap = None
    for index, building in enumerate(ctx.buildings):
        for other in ctx.buildings[index + 1:]:
            area, polygon = overlap(building['footprint'], other['footprint'])
            if area > EPSILON:
                footprints.append({'ids': [building['id'], other['id']], 'overlapSquareMeters': area, 'intersection': polygon})
            else:
                gap = polygon_gap(building['footprint'], other['footprint'])
                if smallest_wall_gap is None or gap < smallest_wall_gap['meters']:
                    smallest_wall_gap = {'ids': [building['id'], other['id']], 'meters': gap}
            area, polygon = overlap(building['projectionEnvelope'], other['projectionEnvelope'])
            if area > EPSILON:
                envelopes.append({'ids': [building['id'], other['id']], 'overlapSquareMeters': area, 'intersection': polygon,
                                  'classification': 'Conservative overhead/frontage reservation overlap; requires local component review, not a wall collision.'})
    strips = [(route, piece) for route in ctx.paths if route_kind(route) != 'curb' for piece in route_strips(route)]
    for building in ctx.buildings:
        for route, piece in strips:
            area, polygon = overlap(building['footprint'], piece['polygon'])
            if area > EPSILON:
                crossings.append({'building': building['id'], 'route': route['id'], 'routeKind': route_kind(route),
                    'segment': piece['segment'], 'overlapSquareMeters': area, 'intersection': polygon})
            area, polygon = overlap(building['projectionEnvelope'], piece['polygon'])
            if area > EPSILON and not own_route(building, route):
                envelope_route_contacts.append({'building': building['id'], 'route': route['id'],
                    'segment': piece['segment'], 'overlapSquareMeters': area,
                    'classification': 'Overhead/frontage reservation meets route; walls checked separately.'})
        for tree in ctx.planting:
            if convex_contains(tree['center'], building['footprint']):
                tree_conflicts.append({'building': building['id'], 'tree': tree['id'], 'position': tree['center']})
    entries, entry_issues = audit_entries(ctx)
    forest = [tree for tree in ctx.planting if any(tag in tree['id'] for tag in ('Meadow_Woods/', 'Harbor_CoastalWoods/', 'ALP_Forest_', 'CAN_Oasis_GroveTree_'))]
    masks = forest_masks(ctx, layout)
    mask_reports = []
    for mask in masks:
        assigned = [tree for tree in forest if inside_mask(tree['center'], mask, ctx.region)]
        mask_reports.append({'mask': mask, 'measuredNearestNeighbor': spacing(assigned)})
    unassigned = [tree for tree in forest if not any(inside_mask(tree['center'], mask, ctx.region) for mask in masks)]
    if envelopes:
        ids = {name for item in envelopes for name in item['ids']}
        components = replay_component_bounds(ctx, [building for building in ctx.buildings if building['id'] in ids])
        for item in envelopes:
            first, second = [components[name.split('/', 1)[1]] for name in item['ids']]
            overlaps = []
            for role, a in first.items():
                for other_role, b in second.items():
                    depths = [min(a[i + 3], b[i + 3]) - max(a[i], b[i]) for i in range(3)]
                    if min(depths) > EPSILON:
                        overlaps.append({'roles': [role, other_role], 'overlapBoundsDepthXYZ': depths})
            item['componentBoundsReview'] = {'source': 'Current detailed_architecture functions replayed with pure vectors and role bounds.',
                'overlappingRoleBounds': overlaps, 'componentConflictExcluded': not overlaps,
                'limitation': 'Boxes retain their unbeveled outer bounds; grouped-role bounds conservatively enclose their detailed pieces.'}
    route_junctions = []
    main = [route for route in ctx.paths if route_kind(route) in ('public-route', 'airfield-ground-route')
            and not route['id'].endswith(('/shoulder', '/paving'))]
    for index, route in enumerate(main):
        for other in main[index + 1:]:
            if any(overlap(a['polygon'], b['polygon'])[0] > EPSILON for a in route_strips(route) for b in route_strips(other)):
                route_junctions.append({'ids': [route['id'], other['id']], 'classification': 'Intentional ground-route junction or connected square, not an obstruction.'})
    return {'counts': {'buildings': len(ctx.buildings), 'trees': len(ctx.planting), 'forestTrees': len(forest), 'routes': len(ctx.paths)},
        'buildingFootprints': ctx.buildings, 'wallFootprintOverlaps': footprints, 'smallestWallGap': smallest_wall_gap,
        'projectionReservationOverlaps': envelopes, 'routeWallCrossings': crossings,
        'projectionRouteContacts': envelope_route_contacts, 'treeTrunkInsideWalls': tree_conflicts,
        'entryChecks': entries, 'entryIssues': entry_issues, 'intentionalRouteJunctions': route_junctions,
        'forestNearestNeighbor': spacing(forest), 'forestMasks': mask_reports,
        'forestTreesOutsideAllDeclaredMasks': unassigned,
        'otherPlantingNearestNeighbor': spacing([tree for tree in ctx.planting if tree not in forest]),
        'sourceEnvironmentLayout': getattr(ctx, 'environment_layout', layout)}


def audit_runway(ctx):
    corridor = [[-65, -390], [260, -390], [260, 400], [-65, 400]]
    runway = [[-12, -180], [12, -180], [12, 180], [-12, 180]]
    conflicts = []
    for building in ctx.buildings:
        area, poly = overlap(building['projectionEnvelope'], corridor)
        if area > EPSILON:
            conflicts.append({'id': building['id'], 'kind': 'building-projection', 'intersection': poly})
    for obstacle in ctx.extra_obstacles:
        if overlap(obstacle['polygon'], corridor)[0] > EPSILON:
            conflicts.append({'id': obstacle['id'], 'kind': 'tall-airfield-structure', 'polygon': obstacle['polygon']})
    for tree in ctx.planting:
        if convex_contains(tree['center'], corridor):
            conflicts.append({'id': tree['id'], 'kind': 'tree-trunk', 'position': tree['center']})
    return {'runwayBounds': [-12, 12, -180, 180], 'protectedCorridorBounds': [-65, 260, -390, 400],
        'obstructionConflicts': conflicts, 'clear': not conflicts,
        'minimumTreeTrunkDistanceToRunwayMeters': min(0 if convex_contains(tree['center'], runway) else min(
            distance_to_segment(tree['center'], a, b)[0] for a, b in zip(runway, runway[1:] + runway[:1])) for tree in ctx.planting),
        'groundRoutePolicy': 'Taxiway connectors and apron ground surfaces may join the runway; they are not flight obstacles.',
        'scope': 'Wall/projection reservations, tall named airfield structures, and tree trunk centers. Exact botanical crown bounds require source-mesh inspection.'}


def main():
    meadow, alpine = module('build_meadow_harbor'), module('build_alpine_canyon')
    ground = load_ground()
    captures, regions = {}, {}
    for region, builder in [('REG_MEADOW', meadow.build_meadow), ('REG_PORT', meadow.build_harbor),
                            ('REG_ALPINE', alpine.build_alpine), ('REG_CANYON', alpine.build_canyon)]:
        ctx = AuditCapture(region, ground)
        layout = builder(ctx)
        captures[region] = ctx
        regions[region] = audit_region(ctx, layout)
    assert 'bpy' not in sys.modules and 'numpy' not in sys.modules
    runway = audit_runway(captures['REG_MEADOW'])
    source_files = ['scene_kit.py', 'detailed_architecture.py', 'layout_datums.py', 'settlement_landscape.py',
                    'build_meadow_harbor.py', 'build_alpine_canyon.py', 'draw_layout.py', 'audit_rebuild_layout.py']
    report = {'units': 'meters', 'source': 'Deterministic replay of the current four source builders using draw_layout.Capture.',
        'imports': {'blender': False, 'numpy': False, 'shapely': False}, 'regions': regions, 'runway': runway,
        'summary': {region: {**data['counts'], 'wallOverlaps': len(data['wallFootprintOverlaps']),
                            'projectionReservationOverlaps': len(data['projectionReservationOverlaps']),
                            'routeWallCrossings': len(data['routeWallCrossings']), 'entryIssues': len(data['entryIssues']),
                            'treeTrunkInsideWalls': len(data['treeTrunkInsideWalls']),
                            'forestMaskViolations': len(data['forestTreesOutsideAllDeclaredMasks'])} for region, data in regions.items()},
        'limitations': ['Projection polygons reserve the full architectural contract; they are not exact filled roof/porch silhouettes.',
            'Roof/frontage reservation contacts and route-to-route junctions are reported separately from definite wall conflicts.',
            'Tree nearest-neighbor measurements use actual replayed trunk centers within each declared ecological mask; overlapping masks may include the same tree.',
            'No collision, traversal, or botanical crown-closure claim is made by this two-dimensional source audit.'],
        'provenance': [{'path': 'scripts/environments/' + name, 'sha256': hashlib.sha256((SOURCE / name).read_bytes()).hexdigest()} for name in source_files]}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'summary': report['summary'], 'runwayClear': runway['clear']}, indent=2))


if __name__ == '__main__':
    main()
