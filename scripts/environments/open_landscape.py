"""Full-surface ecological infill, also usable on reopened Four Horizons sources.

API: dress_open_landscape(ctx, biome_id, exclusions) -> placement report.
Required ctx: normal scene_kit.Context methods; geometry-free Capture is supported.
exclusions = {
  'buildings': [{id, center:[x,z], dimensions:[width,height,depth], yaw}],
  'paths': [{id, points:[[x,z],...], width}],
  'fields': [{id, polygon:[[x,z],...]}],
  'structures': [{id, polygon:[[x,z],...]}],  # optional, e.g. hangar slabs
  'water': [{id, level, polygon:[[x,z],...]}], # optional lake/oasis contours
  'trees': [{id, center:[x,z], height, style}] # optional existing trunk centers
}

No builder imports, scene clearing, exports, camera changes, or quality budgets.
All botanical source leaves/blades survive shared prototype assembly. Distinct
habitats continue across the whole eligible land surface, beyond village belts.
"""
import math
import random
import hashlib


REGIONS = {
    'verdant-airfield': (-800, 800, -800, 800),
    'azure-port': (800, 2400, -800, 800),
    'alpine-lake': (-800, 800, 800, 2400),
    'sunstone-oasis': (800, 2400, 800, 2400),
}
ALIASES = {'REG_MEADOW': 'verdant-airfield', 'REG_PORT': 'azure-port',
           'REG_ALPINE': 'alpine-lake', 'REG_CANYON': 'sunstone-oasis'}
ALPINE_WOODS = [(-430, 1460, 170, 240), (-280, 1810, 255, 155),
                (205, 1735, 185, 115), (30, 1130, 210, 170)]
REGIONAL_INTENTS = {
    'verdant-airfield': {'identity': 'Productive rural enclosure around the village and flight field',
        'woodlandAnchors': 'Crop parcel margins, orchard outer edge, village backdrop and mill approach',
        'protectedOpenings': [[310, -180, 58, 70], [-310, 200, 43, 52], [200, 480, 50, 55]],
        'sequence': 'Wooded field edges alternate with small flowered grazing glades; short flight turf remains open.'},
    'azure-port': {'identity': 'Wooded arrival into the compact port and open waterfront',
        'woodlandAnchors': [[1128, -18, 145, 195], [1433, 14, 135, 315], [1668, -392, 155, 108], [1684, 397, 145, 108]],
        'protectedOpenings': [[1559, -119, 37, 49], [1584, 119, 32, 44]],
        'sequence': 'Arrival roads pass through oak/cypress woodland, reveal the planted park, then open toward the quay.'},
    'alpine-lake': {'identity': 'Lake enclosure, connected foothill woods and exposed high meadow',
        'woodlandAnchors': ALPINE_WOODS,
        'protectedOpenings': [[68, 1126, 48, 32], [355, 1490, 39, 55]],
        'sequence': 'Pine/oak foothills frame the lake and approach; heath and scree take over above the forest.'},
    'sunstone-oasis': {'identity': 'Irrigated oasis and narrow wooded washes in open dry desert',
        'wadiCenterlines': [[[1465, 1275], [1410, 1155], [1335, 1030], [1230, 900]],
                           [[1650, 1465], [1730, 1580], [1760, 1700], [1790, 1810]]],
        'protectedOpenings': [[1760, 1540, 48, 65]],
        'sequence': 'Lush water-linked groves thin into scrub and rock washes, leaving the stone arch and mesas legible.'},
}


def _rng(family, biome, *identity):
    key = '/'.join(map(str, (family, biome, *identity)))
    return random.Random(int(hashlib.sha256(key.encode()).hexdigest()[:16], 16))


def _all_reservations(biome, current):
    """One shared world reservation set; explicit input wins over source JSON."""
    from pathlib import Path
    import json
    result = dict(current.get('neighborReservations', {}))
    directory = Path(__file__).resolve().parents[2] / 'artifacts/four-horizons'
    for other in REGIONS:
        if other != biome and other not in result:
            path = directory / other / 'landscape_reservations.json'
            if path.exists(): result[other] = json.loads(path.read_text(encoding='utf-8'))
    result[biome] = current
    try:
        from landmark_reservations import augment_landmark_reservations
        result = {owner: augment_landmark_reservations(value, owner) for owner, value in result.items()}
    except ImportError:
        pass  # The base reservation API remains usable for isolated fixtures.
    merged = {key: [] for key in ('buildings', 'paths', 'fields', 'structures', 'water', 'trees')}
    for value in result.values():
        for key in merged: merged[key].extend(value.get(key, []))
    return result, merged


def _segment_distance(x, z, a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dz * dz
    t = max(0, min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / length)) if length else 0
    return math.hypot(x - a[0] - t * dx, z - a[1] - t * dz)


def _inside(x, z, polygon):
    inside = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if (a[1] > z) != (b[1] > z) and x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def _footprint(building):
    x, z = building['center']; w, _, d = building['dimensions']; yaw = building.get('yaw', 0)
    c, s = math.cos(yaw), math.sin(yaw)
    return [[x + u * c + v * s, z - u * s + v * c]
            for u, v in [(-w / 2 - 1, -d / 2 - 1.1), (w / 2 + 1, -d / 2 - 1.1),
                         (w / 2 + 1, d / 2 + 1.8), (-w / 2 - 1, d / 2 + 1.8)]]


class Reservations:
    def __init__(self, exclusions, biome):
        self.biome, self.grid = biome, {}
        self.queries, self.rejected = 0, {}
        polygons = [('building', b['id'], _footprint(b)) for b in exclusions.get('buildings', [])]
        polygons += [(kind, item.get('id', kind), item['polygon']) for kind, key in
                     [('crop', 'fields'), ('structure', 'structures'), ('water', 'water')]
                     for item in exclusions.get(key, [])]
        if biome == 'verdant-airfield':
            polygons.append(('runway-pavement', 'Meadow_Runway_Shoulder', [[-16, -192], [16, -192], [16, 192], [-16, 192]]))
        for kind, name, poly in polygons:
            xs, zs = [p[0] for p in poly], [p[1] for p in poly]
            self._add((min(xs), max(xs), min(zs), max(zs)), {'kind': kind, 'id': name, 'polygon': poly})
        for path in exclusions.get('paths', []):
            for a, b in zip(path['points'], path['points'][1:]):
                half = path['width'] / 2
                self._add((min(a[0], b[0]) - half, max(a[0], b[0]) + half,
                           min(a[1], b[1]) - half, max(a[1], b[1]) + half),
                          {'kind': 'route', 'id': path['id'], 'segment': (a, b), 'half': half})

    def _add(self, bounds, item):
        # Largest query radius is a mature copse crown; broad bins avoid full scans.
        for ix in range(math.floor((bounds[0] - 15) / 64), math.floor((bounds[1] + 15) / 64) + 1):
            for iz in range(math.floor((bounds[2] - 15) / 64), math.floor((bounds[3] + 15) / 64) + 1):
                self.grid.setdefault((ix, iz), []).append(item)

    def blocked(self, x, z, radius=.5):
        self.queries += 1
        for item in self.grid.get((math.floor(x / 64), math.floor(z / 64)), []):
            if 'segment' in item:
                blocked = _segment_distance(x, z, *item['segment']) < item['half'] + radius + .25
            else:
                poly = item['polygon']
                blocked = _inside(x, z, poly) or any(_segment_distance(x, z, a, b) < radius
                    for a, b in zip(poly, poly[1:] + poly[:1]))
            if blocked:
                self.rejected[item['kind']] = self.rejected.get(item['kind'], 0) + 1
                return item['kind']
        return None


class TrunkGrid:
    def __init__(self, trees=()):
        self.grid = {}
        for tree in trees:
            self.add(*tree['center'])
    def add(self, x, z): self.grid.setdefault((math.floor(x / 16), math.floor(z / 16)), []).append((x, z))
    def near(self, x, z, distance):
        ix, iz = math.floor(x / 16), math.floor(z / 16)
        span = math.ceil(distance / 16)
        return any((x - a) ** 2 + (z - b) ** 2 < distance ** 2 for i in range(ix - span, ix + span + 1)
                   for j in range(iz - span, iz + span + 1) for a, b in self.grid.get((i, j), []))


def _habitat(x, z):
    # Several continuous scales create coherent copses, field margins and glades.
    return .48 * math.sin(x * .037 + math.sin(z * .025) * 1.8) + .32 * math.cos(z * .033 - x * .017) + .20 * math.sin((x + z) * .061)


def _slope(ctx, x, z):
    gx = (ctx.ground(x + 3, z) - ctx.ground(x - 3, z)) / 6
    gz = (ctx.ground(x, z + 3) - ctx.ground(x, z - 3)) / 6
    return math.hypot(gx, gz), gx, gz


def _low_flight(x, z, biome):
    return biome == 'verdant-airfield' and -65 < x < 260 and -390 < z < 400


def _eligible(ctx, x, z, biome, reservation, radius=.5, tall=False):
    h = ctx.ground(x, z)
    x0, x1, z0, z1 = REGIONS[biome]
    # Region ownership uses centers. Only the exterior WORLD edge clips occupied
    # crowns/props: internal joins must not acquire a double empty border.
    if not x0 <= x < x1 or not z0 <= z < z1:
        return False
    if not -800 + radius < x < 2400 - radius or not -800 + radius < z < 2400 - radius:
        return False
    if h <= -4.6 or reservation.blocked(x, z, radius):
        return False
    if tall and biome == 'verdant-airfield' and -65 - radius < x < 260 + radius and -390 - radius < z < 400 + radius:
        return False
    if biome == 'alpine-lake' and h > (142 if tall else 214):
        return False
    if biome == 'sunstone-oasis' and h > (85 if tall else 128):
        return False
    return True


def _tree_candidate(ctx, biome, row, column, reservations, existing, local):
    step = 9.4 if biome == 'alpine-lake' else 15.0 if biome == 'sunstone-oasis' else 11.8
    x0, _, z0, _ = REGIONS[biome]
    rng = _rng('tree-proposal', biome, row, column)
    x = x0 + (column + .5 + (row % 2) * .5) * step + rng.uniform(-2, 2)
    z = z0 + (row + .5) * step + rng.uniform(-2, 2)
    h = ctx.ground(x, z); habitat = _habitat(x, z); intent = REGIONAL_INTENTS[biome]
    if any(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 < 1 for cx, cz, rx, rz in intent['protectedOpenings']):
        return None
    anchor = 'intervening-copse-and-glade'
    if biome == 'verdant-airfield':
        field_edge = min((_segment_distance(x, z, a, b) for field in local.get('fields', [])
                          for a, b in zip(field['polygon'], field['polygon'][1:] + field['polygon'][:1])), default=9999)
        village_backdrop = ((x + 454) / 87) ** 2 + ((z + 10) / 210) ** 2 < 1
        orchard_edge = 340 < x < 520 and 48 < z < 252 and not (372 < x < 483 and 80 < z < 219)
        anchored = field_edge < 42 or village_backdrop or orchard_edge
        wooded = habitat > (-.28 if anchored else .05)
        anchor = 'productive-field-edge' if field_edge < 42 else 'village-backdrop' if village_backdrop else 'orchard-margin' if orchard_edge else anchor
        style = 'oak' if rng.random() < .82 else 'pine'; height = rng.uniform(16, 25)
    elif biome == 'azure-port':
        anchored = any(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 < 1 for cx, cz, rx, rz in intent['woodlandAnchors'])
        wooded = habitat > (-.20 if anchored else .18)
        anchor = 'wooded-port-arrival' if anchored else 'coastal-copse-and-opening'
        style = 'oak' if rng.random() < .78 else 'cypress'; height = rng.uniform(16, 25)
    elif biome == 'alpine-lake':
        anchored = h < 125 and any(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 < 1 for cx, cz, rx, rz in ALPINE_WOODS)
        wooded = anchored or habitat > (.28 if h < 120 else .56)
        anchor = 'connected-lake-foothill-woodland' if anchored else 'high-meadow-woodland-edge'
        style = 'oak' if h < 80 and rng.random() < .2 else 'pine'; height = rng.uniform(16, 27)
    else:
        wadi_distance = min(_segment_distance(x, z, a, b) for line in intent['wadiCenterlines'] for a, b in zip(line, line[1:]))
        oasis_edge = 1.0 < ((x - 1510) / 220) ** 2 + ((z - 1450) / 177) ** 2 < 2.05
        wooded = h < 58 and (wadi_distance < 42 or oasis_edge) and habitat > -.18
        anchor = 'oasis-outer-grove' if oasis_edge else 'dry-wadi-grove'
        style = 'palm' if oasis_edge else 'oak'; height = rng.uniform(9, 15)
    radius = height * {'oak': .56, 'pine': .34, 'palm': .47, 'cypress': .16}[style]
    spacing = 7.0 if biome == 'alpine-lake' else 8.5
    if not wooded or not _eligible(ctx, x, z, biome, reservations, radius, True): return None
    if existing.near(x, z, spacing): return None
    if _slope(ctx, x, z)[0] > (.55 if biome == 'alpine-lake' else .48): return None
    return {'id': f'OPEN_{biome}/copse-{row:03d}-{column:03d}', 'owner': biome, 'center': [x, z],
            'height': height, 'style': style, 'clearanceRadius': radius, 'minimumTrunkSpacing': spacing,
            'priority': _rng('tree-spacing-priority', biome, row, column).random(), 'landUseAnchor': anchor}


def _world_tree_proposals(ctx, biome, world, reservations, existing):
    """Matérn-II thinning considers BOTH cells' candidates at every shared edge.

    A local proposal is retained only if no lower-priority compatible proposal
    lies inside its rigid trunk-spacing disc. The decision is independent of
    generation order and identical when either neighboring source is reopened.
    """
    target = REGIONS[biome]; proposals = []
    for owner, bounds in REGIONS.items():
        step = 9.4 if owner == 'alpine-lake' else 15.0 if owner == 'sunstone-oasis' else 11.8
        x0, x1, z0, z1 = bounds
        for row in range(math.ceil((z1 - z0) / step)):
            nominal_z = z0 + (row + .5) * step
            if owner != biome and not target[2] - 36 < nominal_z < target[3] + 36: continue
            for column in range(math.ceil((x1 - x0) / step)):
                nominal_x = x0 + (column + .5 + (row % 2) * .5) * step
                if owner != biome and not target[0] - 36 < nominal_x < target[1] + 36: continue
                proposal = _tree_candidate(ctx, owner, row, column, reservations, existing, world.get(owner, {}))
                if proposal: proposals.append(proposal)
    grid = {}
    for proposal in proposals:
        x, z = proposal['center']; grid.setdefault((math.floor(x / 16), math.floor(z / 16)), []).append(proposal)
    result = []
    for proposal in proposals:
        x, z = proposal['center']; ix, iz = math.floor(x / 16), math.floor(z / 16)
        if any(other['priority'] < proposal['priority'] and math.dist(other['center'], proposal['center']) < max(other['minimumTrunkSpacing'], proposal['minimumTrunkSpacing'])
               for i in range(ix - 1, ix + 2) for j in range(iz - 1, iz + 2) for other in grid.get((i, j), [])):
            continue
        result.append(proposal)
    return result


def _dress_stone_margins(ctx, biome, local, reservation, trunks, records, counts):
    """Grounded field boundaries and existing arrival-route verges, never a grid."""
    segments = []
    if biome == 'verdant-airfield':
        for field in local.get('fields', []):
            poly = field['polygon']
            orientation = 1 if sum(a[0] * b[1] - a[1] * b[0] for a, b in zip(poly, poly[1:] + poly[:1])) > 0 else -1
            for index, (a, b) in enumerate(zip(poly, poly[1:] + poly[:1])):
                segments.append((field['id'] + f'/outer-margin-{index}', a, b, 3.3, orientation))
    elif biome == 'azure-port':
        for path in local.get('paths', []):
            if 'Harbor_Approach_' not in path['id']: continue
            for index, (a, b) in enumerate(zip(path['points'], path['points'][1:])):
                for side in (-1, 1):
                    segments.append((path['id'] + f'/stone-verge-{index}-{side}', a, b, path['width'] / 2 + 3.1, side))
    for identity, a, b, offset, side in segments:
        dx, dz = b[0] - a[0], b[1] - a[1]; length = math.hypot(dx, dz)
        if length < 1: continue
        ux, uz = dx / length, dz / length; nx, nz = uz * side, -ux * side
        count = math.floor(length / 2.15)
        for index in range(count):
            rng = _rng('stone-margin', biome, identity, index)
            # Gaps respond to a shared segment rhythm; individual stones retain
            # the uninterrupted physical field/route direction and grounded base.
            if math.sin(index * .21 + rng.uniform(-.3, .3)) < -.58: continue
            along = (index + .5) * length / count
            px, pz = a[0] + ux * along + nx * (offset + rng.uniform(-.27, .27)), a[1] + uz * along + nz * (offset + rng.uniform(-.27, .27))
            size = rng.uniform(.65, 1.0); radius = size * 1.15
            if not _eligible(ctx, px, pz, biome, reservation, radius, True) or trunks.near(px, pz, radius + 1.6): continue
            name = 'OPEN_' + biome + '/' + identity + f'/stone-{index:04d}'
            ctx.rock(name, px, pz, size, 'stone')
            counts['stoneMarginBlocks'] += 1
            records['stoneMargins'].append({'id': name, 'center': [px, pz], 'radius': radius, 'landUseAnchor': identity})


def _cluster(ctx, name, x, z, kind, variant, scale=1):
    """One shared 6m botanical drift, preserving every original blade/petal."""
    if not hasattr(ctx, '_object'):
        return
    import detailed_vegetation as botanical
    botanical._runtime()
    mats = botanical._materials(ctx)
    cache = getattr(ctx, '_open_landscape_patches', {})
    key = (kind, variant)
    if key not in cache:
        rng = random.Random(52017 + variant * 81 + sum(map(ord, kind)))
        mesh, palette = botanical.Mesh(), []
        kinds = ['grass'] * 7 + (['daisy', 'grass'] if kind == 'flower' else ['lavender', 'grass'] if kind == 'heath' else ['grass', 'grass'])
        if kind == 'mown': kinds = ['grass'] * 9
        for index, plant_kind in enumerate(kinds):
            source, source_materials = botanical._botanical(plant_kind, (variant + index) % 3, mats)
            slots = []
            for material in source_materials:
                if material not in palette: palette.append(material)
                slots.append(palette.index(material))
            a = index * 2.399963 + rng.uniform(-.15, .15)
            radius = math.sqrt((index + .3) / len(kinds)) * 2.6
            px, pz = math.cos(a) * radius, math.sin(a) * radius
            size = rng.uniform(.9, 1.65) if kind != 'mown' else rng.uniform(.42, .64)
            offset = len(mesh.vertices)
            mesh.vertices.extend((px + v[0] * size, pz + v[1] * size, v[2] * size) for v in source.vertices)
            mesh.faces.extend(tuple(offset + i for i in face) for face in source.faces)
            mesh.slots.extend(slots[slot] for slot in source.slots)
            mesh.smooth.extend(source.smooth); mesh.leaf_count += source.leaf_count
        cache[key] = mesh.finish(f'OPEN_FullBotanicalDrift_{kind}_{variant}', palette)
        ctx._open_landscape_patches = cache
    obj = botanical._instance(ctx, name, cache[key], x, ctx.ground(x, z) + .025, z, scale, 0,
                              'botanical_open_landscape', f'open-drift/{kind}/{variant}')
    from mathutils import Vector
    _, gx, gz = _slope(ctx, x, z)
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector((-gx, gz, 1)).normalized())
    obj['landscape_drift_meters'] = 6 * scale
    obj['botanical_assemblies'] = 9


def _ground_drift(ctx, name, x, z, rx, rz, material, reservation, biome, seed):
    """Describe a soft mottle baked into the ORIGINAL terrain, never a plane."""
    if not hasattr(ctx, '_open_ground_mottles'): ctx._open_ground_mottles = []
    ctx._open_ground_mottles.append({'center': [x, z], 'radii': [rx, rz], 'material': material,
                                    'phase': random.Random(seed).random() * math.tau})
    return True


def _bake_ground_mottles(ctx, reservation):
    if not hasattr(ctx, '_object'): return {'mode': 'geometry-free', 'paintedVertices': None}
    import bpy
    grid = {}
    for drift in getattr(ctx, '_open_ground_mottles', []):
        x, z = drift['center']; rx, rz = drift['radii']
        for ix in range(math.floor((x - rx * 1.25) / 32), math.floor((x + rx * 1.25) / 32) + 1):
            for iz in range(math.floor((z - rz * 1.25) / 32), math.floor((z + rz * 1.25) / 32) + 1):
                grid.setdefault((ix, iz), []).append(drift)
    painted = 0
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not obj.name.startswith(ctx.region + '/') or 'continuous-terrain' not in obj.name: continue
        colors = obj.data.color_attributes.get('Color')
        if colors is None or colors.domain != 'POINT':
            raise RuntimeError('Expected original terrain Color/POINT data for landscape mottle.')
        for vertex, color in zip(obj.data.vertices, colors.data):
            point = obj.matrix_world @ vertex.co; x, z = point.x, -point.y
            if reservation.blocked(x, z, .2): continue
            # Shared world-space field gives both copies of every internal edge
            # vertex exactly the same color multiplier, including the four-cell corner.
            intensity = (.5 + .5 * math.sin(x * .081 + math.sin(z * .067))) ** 2
            intensity *= .55 + .45 * math.cos(z * .059 - x * .023) ** 2
            east = max(0, min(1, (x - 650) / 300)); north = max(0, min(1, (z - 650) / 300))
            warmth = .06 * east * north
            if intensity <= 0: continue
            fine = math.sin(x * .087 + z * .054) * math.cos(z * .071 - x * .019)
            factor = 1 + intensity * (-.075 + fine * .055)
            red, green, blue, alpha = color.color
            color.color = (max(0, red * (factor + warmth * intensity)), max(0, green * factor),
                           max(0, blue * (factor + warmth * intensity * .5)), alpha)
            painted += 1
        obj['open_landscape_ground'] = 'Soft habitat mottle baked into existing source vertex colors; original terrain vertices/triangles unchanged.'
    return {'mode': 'original-terrain-vertex-colors', 'paintedVertices': painted, 'newTerrainPlanes': 0}


def dress_open_landscape(ctx, biome_id, exclusions):
    biome = ALIASES.get(biome_id, biome_id)
    if biome not in REGIONS: raise ValueError('Unknown biome: ' + biome_id)
    world_reservations, merged = _all_reservations(biome, exclusions)
    reservation = Reservations(merged, biome)
    existing = merged.get('trees', [])
    trunks = TrunkGrid(existing)
    seed = 39007 + list(REGIONS).index(biome) * 10103
    records = {'trees': [], 'drifts': [], 'shrubs': [], 'rocks': [], 'stoneMargins': []}
    counts = {'trees': 0, 'botanicalDrifts': 0, 'wholeBotanicalAssemblies': 0, 'shrubs': 0,
              'rocks': 0, 'stoneMarginBlocks': 0, 'terrainColorDrifts': 0, 'mownDrifts': 0}
    materials = {'OPEN_Pasture': '74884D', 'OPEN_WildflowerSoil': '7A8750', 'OPEN_Heath': '77806A',
                 'OPEN_WoodlandFloor': '667147', 'OPEN_DryScrubSoil': 'BA956A', 'OPEN_MownTurf': '7D9059'}
    for name, colour in materials.items(): ctx.material(name, colour, roughness=.97)
    x0, x1, z0, z1 = REGIONS[biome]
    ctx.collection('OPEN_LANDSCAPE_CONTINUOUS_COPSES')
    accepted_trees = _world_tree_proposals(ctx, biome, world_reservations, reservation, trunks)
    for tree in accepted_trees:
        x, z = tree['center']
        trunks.add(x, z)
        if tree['owner'] != biome: continue
        ctx.tree(tree['id'], x, z, tree['height'], tree['style'])
        counts['trees'] += 1
        records['trees'].append(tree)
    ctx.collection('OPEN_LANDSCAPE_PASTURE_HEATH_AND_SCRUB')
    step = 24.0
    for row in range(math.ceil((z1 - z0) / step)):
        for column in range(math.ceil((x1 - x0) / step)):
            rng = _rng('groundcover-cell', biome, row, column)
            x = x0 + (column + .5) * step + rng.uniform(-5.2, 5.2)
            z = z0 + (row + .5) * step + rng.uniform(-5.2, 5.2)
            if not _eligible(ctx, x, z, biome, reservation, 1): continue
            h = ctx.ground(x, z); slope, _, _ = _slope(ctx, x, z)
            if slope > .85: continue
            short = _low_flight(x, z, biome)
            dry = biome == 'sunstone-oasis'
            heath = biome == 'alpine-lake' and (h > 115 or slope > .35)
            wooded = trunks.near(x, z, 13)
            kind = 'mown' if short else 'heath' if heath or dry else 'flower' if _habitat(x + 77, z - 112) < .18 else 'grass'
            mat = 'OPEN_MownTurf' if short else 'OPEN_DryScrubSoil' if dry else 'OPEN_Heath' if heath else 'OPEN_WoodlandFloor' if wooded else 'OPEN_WildflowerSoil' if kind == 'flower' else 'OPEN_Pasture'
            name = f'OPEN_{biome}/land-drift-{row:03d}-{column:03d}'
            if _ground_drift(ctx, name + '/living-soil', x, z, rng.uniform(11, 16), rng.uniform(10, 15), mat, reservation, biome, seed + row * 100 + column):
                counts['terrainColorDrifts'] += 1
            # Multiple 6m whole-botanical drifts create broad, irregular ground cover.
            for index in range(5 if not dry else 3):
                a = index * 2.399963 + rng.uniform(-.3, .3)
                radius = 1.5 if index == 0 else rng.uniform(5.5, 10.5)
                px, pz = x + math.cos(a) * radius, z + math.sin(a) * radius
                if not _eligible(ctx, px, pz, biome, reservation, 3.65): continue
                if _slope(ctx, px, pz)[0] > .72: continue
                patch_kind = 'mown' if _low_flight(px, pz, biome) else kind
                _cluster(ctx, name + f'/botanical-{index}', px, pz, patch_kind, (row + column + index) % 3)
                counts['botanicalDrifts'] += 1; counts['wholeBotanicalAssemblies'] += 9
                if patch_kind == 'mown': counts['mownDrifts'] += 1
                records['drifts'].append({'center': [px, pz], 'kind': patch_kind, 'radius': 3.65})
            if not short:
                shrub_count = 5 if wooded or heath else 3 if dry else 4
                for index in range(shrub_count):
                    a = index * 2.399963 + .7; radius = rng.uniform(3, 11)
                    px, pz = x + math.cos(a) * radius, z + math.sin(a) * radius
                    scale = rng.uniform(1.05, 2.2) if not dry else rng.uniform(.8, 1.55)
                    if not _eligible(ctx, px, pz, biome, reservation, scale * 1.1, True): continue
                    if hasattr(ctx, '_object'):
                        from detailed_vegetation import plant
                        plant(ctx, name + f'/heath-shrub-{index}', px, pz, kind='shrub', scale=scale)
                    counts['shrubs'] += 1; records['shrubs'].append({'center': [px, pz], 'radius': scale * 1.1})
                if dry or heath or slope > .27 or (row + column) % 7 == 0:
                    for index in range(4 if dry or heath else 2):
                        px, pz = x + rng.uniform(-8, 8), z + rng.uniform(-8, 8)
                        size = rng.uniform(.7, 2.7) if dry or heath else rng.uniform(.45, 1.4)
                        if not _eligible(ctx, px, pz, biome, reservation, size * 1.1, True): continue
                        if trunks.near(px, pz, size * 1.1 + 1.6): continue
                        ctx.rock(name + f'/embedded-rock-{index}', px, pz, size, 'sandstone' if dry else 'rock')
                        counts['rocks'] += 1; records['rocks'].append({'center': [px, pz], 'radius': size * 1.1})
    _dress_stone_margins(ctx, biome, exclusions, reservation, trunks, records, counts)
    ground_treatment = _bake_ground_mottles(ctx, reservation)
    report = {'biome': biome, 'seed': seed, 'counts': counts, 'placements': records, 'groundTreatment': ground_treatment,
              'exclusionQueries': reservation.queries, 'exclusionsRespected': reservation.rejected,
              'habitatScope': 'All eligible land, including former open plains and short turf inside the flight corridor; crop/paved/water/building reservations remain clear.',
              'alpineConnectedWoodlandMasks': ALPINE_WOODS if biome == 'alpine-lake' else [],
              'regionalIntent': REGIONAL_INTENTS[biome],
              'seeds': {'trees': 'Stable per region/grid candidate', 'spacing': 'Separate world-priority seed',
                        'groundcover': 'Stable per region/ground cell', 'stoneMargins': 'Stable per source margin segment'},
              'ownership': 'Object centers own one region; crowns can cross internal boundaries. Cross-cell minimum trunk spacing uses deterministic candidate priority.',
              'geometry': 'Full existing botanical meshes, assembled into shared whole-plant drifts; no LOD, decimation, opaque crown hulls or botanical proxies.'}
    ctx.open_landscape_report = report
    return report


def audit_open_landscape(ctx, biome_id, exclusions, report):
    """Independent final placement pass: no reserved ground/crown-volume intrusions."""
    biome = ALIASES.get(biome_id, biome_id); reservations = Reservations(exclusions, biome)
    violations = []
    for category, records in report['placements'].items():
        for item in records:
            x, z = item['center']; radius = item.get('clearanceRadius', item.get('radius', .5))
            reason = reservations.blocked(x, z, radius)
            if reason: violations.append({'category': category, 'center': [x, z], 'reason': reason})
            if category != 'drifts' and _low_flight(x, z, biome):
                violations.append({'category': category, 'center': [x, z], 'reason': 'tall-flight-corridor'})
            if ctx.ground(x, z) <= -4.6:
                violations.append({'category': category, 'center': [x, z], 'reason': 'sea'})
    return {'counts': report['counts'], 'checkedPlacements': sum(map(len, report['placements'].values())),
            'violations': violations, 'passes': not violations}


if __name__ == '__main__':
    import json
    from pathlib import Path
    from draw_layout import Capture, load_ground
    root = Path(__file__).resolve().parents[2] / 'artifacts/four-horizons'
    results = {}
    for region, biome in ALIASES.items():
        exclusions = json.loads((root / biome / 'landscape_reservations.json').read_text(encoding='utf-8'))
        ctx = Capture(region, load_ground())
        report = dress_open_landscape(ctx, biome, exclusions)
        check = audit_open_landscape(ctx, biome, exclusions, report)
        results[biome] = check
        (root / biome / 'open_landscape_placement_plan.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(biome, json.dumps({**check, 'violations': check['violations'][:5]}), flush=True)
    (root / 'open_landscape_placement_audit.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
