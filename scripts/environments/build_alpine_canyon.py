"""Ground-fitted alpine and sandstone environments for the four-biome world.

All helper coordinates are world meters in Three.js Y-up convention. Geometry
is original, deterministic and split into editable semantic components.
"""

import math
import random
import struct
from layout_datums import entry_anchor


TAU = math.tau


def _segment_distance(x, z, a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((x - a[0]) * dx + (z - a[1]) * dz) / max(0.001, dx * dx + dz * dz)))
    return math.hypot(x - a[0] - t * dx, z - a[1] - t * dz)


def _near_paths(x, z, paths, clearance):
    return any(_segment_distance(x, z, a, b) < clearance for p in paths for a, b in zip(p, p[1:]))


def _water(ctx, name, cx, cz, rx, rz, level, count=128):
    """Trace the true submerged contour so the lake terminates inside its banks."""
    shore = []
    for i in range(count):
        angle = TAU * i / count
        dx, dz = math.cos(angle) * rx, math.sin(angle) * rz
        last = 0.0
        hit = 1.8
        for step in range(1, 97):
            t = 1.8 * step / 96
            if ctx.ground(cx + dx * t, cz + dz * t) >= level + 0.15:
                hit = t
                break
            last = t
        for _ in range(12):
            middle = (last + hit) * 0.5
            if ctx.ground(cx + dx * middle, cz + dz * middle) < level + 0.15:
                last = middle
            else:
                hit = middle
        # A tiny amount of bank overlap hides sub-pixel cracks at grazing angles.
        shore.append((cx + dx * hit, cz + dz * hit))
    verts = [(cx, level, cz)] + [(x, level, z) for x, z in shore]
    faces = [(0, (i + 1) % count + 1, i + 1) for i in range(count)]
    ctx.mesh(name, verts, faces, 'water')
    return shore


def _wedge(ctx, name, x, y, z, inner, outer, height, a0, a1, material):
    verts = []
    for level in (y, y + height):
        for r, angle in ((outer, a0), (outer, a1), (inner, a1), (inner, a0)):
            verts.append((x + math.cos(angle) * r, level, z + math.sin(angle) * r))
    inward = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
              (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    ctx.mesh(name, verts, [tuple(reversed(face)) for face in inward], material)


def _fence(ctx, name, points, material='timber', height=1.5):
    for i, (a, b) in enumerate(zip(points, points[1:])):
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        steps = max(1, math.ceil(length / 4.5))
        for j in range(steps + 1):
            t = j / steps
            x, z = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            y = ctx.ground(x, z)
            ctx.box(f'{name}_Post_{i}_{j}', x, y + height / 2, z, .28, height, .28, material)
        for h in (.5, 1.18):
            ctx.beam(f'{name}_Rail_{i}_{h}', (a[0], ctx.ground(*a) + h, a[1]),
                     (b[0], ctx.ground(*b) + h, b[1]), .1, material)


def _bench(ctx, name, x, z, yaw=0):
    y = ctx.ground(x, z)
    def part(tag, xx, yy, zz, w, h, d, material):
        cx = x + xx * math.cos(yaw) + zz * math.sin(yaw)
        cz = z - xx * math.sin(yaw) + zz * math.cos(yaw)
        ctx.box(name + tag, cx, y + yy, cz, w, h, d, material, yaw=yaw)
    for dz in (-.20, 0, .20):
        part(f'_SeatSlat_{dz}', 0, .46, dz, 1.85, .075, .17, 'timber')
    for dx in (-.66, .66):
        part(f'_Leg_{dx}', dx, .21, 0, .085, .42, .47, 'metal')
        part(f'_BackPost_{dx}', dx, .65, .27, .07, .95, .07, 'metal')
    for height in (.78, .98):
        part(f'_BackSlat_{height}', 0, height, .27, 1.85, .16, .075, 'timber')


def _landscape_helpers():
    from detailed_vegetation import plant, plant_bed
    return plant, plant_bed


def _path_clear(x, z, routes, margin=1.2):
    return all(not _near_paths(x, z, [r['points']], r['width'] / 2 + margin) for r in routes)


def _route(ctx, routes, name, points, width, material='gravel', lift=.055):
    ctx.path(name, points, width, material, lift=lift)
    routes.append({'id': name, 'points': points, 'width': width, 'material': material})


def _stone_edges(ctx, name, points, width, material='stone', step=1.05):
    """Beveled individual curb stones, batched without reducing their geometry."""
    vertices, faces = [], []
    profile = [(-.5, -.5), (.5, -.5), (.5, .5), (-.5, .5)]
    for segment, (a, b) in enumerate(zip(points, points[1:])):
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dz)
        if length < .1:
            continue
        ux, uz = dx / length, dz / length
        for side in (-1, 1):
            for i in range(max(1, math.floor(length / step))):
                t = (i + .5) * step
                x = a[0] + ux * t - uz * (width / 2 + .14) * side
                z = a[1] + uz * t + ux * (width / 2 + .14) * side
                y = ctx.ground(x, z)
                k = len(vertices)
                for scale, height in ((1, -.08), (1, .12), (.88, .16)):
                    for p, q in profile:
                        px, pz = p * (step - .055) * scale, q * .29 * scale
                        vertices.append((x + ux * px - uz * pz, y + height, z + uz * px + ux * pz))
                faces.append((k, k + 1, k + 2, k + 3))
                for ring in range(2):
                    for j in range(4):
                        faces.append((k + ring * 4 + j, k + (ring + 1) * 4 + j,
                                      k + (ring + 1) * 4 + (j + 1) % 4, k + ring * 4 + (j + 1) % 4))
                faces.append((k + 11, k + 10, k + 9, k + 8))
    if faces:
        ctx.mesh(name, vertices, faces, material)


def _soil_patch(ctx, name, x, z, rx, rz, material, seed):
    rng = random.Random(seed)
    vertices = [(x, ctx.ground(x, z) + .025, z)]
    for i in range(18):
        a = i * TAU / 18
        rr = rng.uniform(.84, 1.14)
        xx, zz = x + math.cos(a) * rx * rr, z + math.sin(a) * rz * rr
        vertices.append((xx, ctx.ground(xx, zz) + .025, zz))
    ctx.mesh(name, vertices, [(0, (i + 1) % 18 + 1, i + 1) for i in range(18)], material)


class _TrunkGrid:
    def __init__(self, cell=9):
        self.cell, self.bins = cell, {}

    def add(self, x, z, clearance):
        key = (math.floor(x / self.cell), math.floor(z / self.cell))
        span = math.ceil(clearance / self.cell)
        for i in range(key[0] - span, key[0] + span + 1):
            for j in range(key[1] - span, key[1] + span + 1):
                if any((x - a) ** 2 + (z - b) ** 2 < clearance ** 2 for a, b in self.bins.get((i, j), [])):
                    return False
        self.bins.setdefault(key, []).append((x, z))
        return True


def _lookout(ctx, x, z):
    ground = ctx.ground(x, z)
    ctx.collection('ALP_Hero_StoneWatchtower')
    samples = [ctx.ground(x + math.cos(i * TAU / 16) * 4.8, z + math.sin(i * TAU / 16) * 4.8) for i in range(16)]
    foundation_bottom, y = min(samples) - .4, max(samples) + .28
    ctx.cyl('ALP_Tower_Foundation', x, (foundation_bottom + y) / 2, z, 4.85, y - foundation_bottom, 'stone', vertices=32)
    ctx.cyl('ALP_Tower_InteriorFloor', x, y + .13, z, 4.20, .22, 'timber', vertices=32)
    for course in range(32):
        for j in range(24):
            door = course < 5 and j in (5, 6)
            slit = course in (13, 14, 15, 22, 23, 24) and j in (0, 6, 12, 18)
            if door or slit:
                continue
            offset = .0 if course < 5 or course >= 13 else (course % 2) * .09
            _wedge(ctx, f'ALP_Tower_Course_{course:02d}_Stone_{j:02d}', x, y + .24 + course * .56, z,
                   3.68, 4.3 - course * .007, .535, TAU * j / 24 + offset + .008,
                   TAU * (j + 1) / 24 + offset - .008, 'stone' if (j + course) % 7 else 'concrete')
    gallery = y + 18.25
    ctx.cyl('ALP_Tower_UpperCornice', x, gallery, z, 4.6, .45, 'stone', vertices=32)
    ctx.cyl('ALP_Tower_GalleryFloor', x, gallery + .34, z, 5.25, .23, 'timber', vertices=32)
    for i in range(12):
        a, b = i * TAU / 12, (i + 1) * TAU / 12
        xx, zz = x + math.cos(a) * 4.65, z + math.sin(a) * 4.65
        ctx.cyl(f'ALP_Tower_GalleryPost_{i}', xx, gallery + 1.86, zz, .115, 3.1, 'timber', vertices=10)
        for rail_h in (.73, 1.36):
            ctx.beam(f'ALP_Tower_Rail_{i}_{rail_h}', (xx, gallery + rail_h, zz),
                     (x + math.cos(b) * 4.65, gallery + rail_h, z + math.sin(b) * 4.65), .065, 'timber')
        ctx.beam(f'ALP_Tower_Bracket_{i}', (xx, gallery + .1, zz),
                 (x + math.cos(a) * 3.9, gallery - 1.45, z + math.sin(a) * 3.9), .11, 'timber')
    ctx.cyl('ALP_Tower_Roof_Eave', x, gallery + 3.43, z, 5.45, .24, 'timber', vertices=32)
    # Concentric overlapping slate courses give the conical roof physical depth.
    for course in range(23):
        t0, t1 = course / 23, (course + 1) / 23
        r0, r1 = 5.62 * (1 - t0) + .14, 5.62 * (1 - t1) + .14
        hh = 5.7 / 23 + .055
        ctx.cyl(f'ALP_Tower_SlateRoof_Course_{course:02d}', x, gallery + 3.57 + course * 5.7 / 23 + hh / 2,
                z, r0, hh, 'roof_slate', vertices=48, top=r1)
    ctx.cyl('ALP_Tower_Roof_Finial', x, gallery + 9.72, z, .12, 1.2, 'metal', vertices=12, top=0)
    for i in range(16):
        zz = z + 4.8 + i * .34
        bottom = ctx.ground(x, zz)
        top = y + .24 - i * .17
        if top > bottom:
            ctx.box(f'ALP_Tower_EntryStep_{i}', x, (top + bottom) / 2, zz, 1.65, top - bottom, .36, 'stone')
    return x, z


def _dock(ctx, shore_x, z, level, length=24):
    ctx.collection('ALP_Lake_DocksAndBoats')
    outer, inner = shore_x - length, shore_x + 5
    width = 3.0
    deck_y = level + .62
    ramp_start = shore_x - 3
    shore_deck_y = ctx.ground(inner, z) + .10
    def deck_height(x):
        t = max(0, min(1, (x - ramp_start) / (inner - ramp_start)))
        return deck_y * (1 - t) + shore_deck_y * t
    n = math.ceil((inner - outer) / .24)
    for i in range(n):
        x = outer + (inner - outer) * (i + .5) / n
        ctx.box(f'ALP_Dock_Plank_{i:03d}', x, deck_height(x), z, (inner - outer) / n - .015,
                .10, width, 'timber')
    for dz in (-1.22, 1.22):
        ctx.box(f'ALP_Dock_LongitudinalBeam_{dz}', (outer + ramp_start) / 2, deck_y - .23, z + dz,
                ramp_start - outer + .3, .28, .20, 'timber')
        ctx.beam(f'ALP_Dock_ShoreRampBeam_{dz}', (ramp_start, deck_y - .23, z + dz),
                 (inner, shore_deck_y - .23, z + dz), .14, 'timber')
        for i in range(7):
            x = outer + (inner - outer) * i / 6
            foot = min(ctx.ground(x, z + dz), level - .5) - .6
            cap = deck_height(x) + (.65 if i in (0, 6) else .14)
            ctx.cyl(f'ALP_Dock_Pile_{dz}_{i}', x, (foot + cap) / 2, z + dz, .15,
                    cap - foot, 'bark', vertices=10)
    for side in (-1, 1):
        cx, cz = outer + 8 + side * 2, z + side * 2.75
        hull = [(cx - 2.5, level + .08, cz), (cx - 1.4, level + .36, cz - .64),
                (cx + 1.4, level + .36, cz - .64), (cx + 2.5, level + .08, cz),
                (cx + 1.4, level + .36, cz + .64), (cx - 1.4, level + .36, cz + .64),
                (cx - 1.65, level - .24, cz), (cx + 1.65, level - .24, cz)]
        ctx.mesh(f'ALP_Rowboat_{side}_Hull', hull, [(0, 1, 6), (1, 2, 7, 6), (2, 3, 7),
                 (3, 4, 7), (4, 5, 6, 7), (5, 0, 6)], 'plaster_ochre' if side == 1 else 'plaster_rose')
        for i, dx in enumerate((-.8, .8)):
            ctx.box(f'ALP_Rowboat_{side}_Bench_{i}', cx + dx, level + .29, cz,
                    .32, .08, 1.12, 'timber')
        for p, q in zip(hull[:6], hull[1:6] + hull[:1]):
            ctx.beam(f'ALP_Rowboat_{side}_Gunwale', p, q, .055, 'timber')
        ctx.beam(f'ALP_Rowboat_{side}_Oar', (cx - 1.5, level + .4, cz - .35),
                 (cx + 1.3, level + .4, cz + .35), .033, 'timber')
        ctx.beam(f'ALP_Rowboat_{side}_Mooring', (cx + 2.15, level + .1, cz),
                 (cx + 3, deck_y + .2, z + side * 1.22), .024, 'cream')
    return inner


def build_alpine(ctx):
    rng = random.Random(8671203)
    plant, plant_bed = _landscape_helpers()
    ctx.material('alpine_forest_floor', (0.245, .30, .185, 1), roughness=.95)
    ctx.material('alpine_path_stone', (.57, .61, .54, 1), roughness=.9)
    ctx.collection('ALP_Lake_WaterAndBanks')
    shore = _water(ctx, 'ALP_Lake_WaterSurface', -100, 1510, 240, 175, 38, count=192)
    routes, parcels, courtyard_records = [], [], []
    shore_arcs = ((.85, 1.22), (2.12, 2.62), (3.40, 3.77), (5.32, 5.62))
    for i, (x, z) in enumerate(shore):
        angle = TAU * i / len(shore)
        if any(lo < angle < hi for lo, hi in shore_arcs) and rng.random() < .7:
            xx, zz = x + (x + 100) * .009, z + (z - 1510) * .009
            ctx.rock(f'ALP_Shore_Boulder_{i:03d}', xx, zz, rng.uniform(.8, 2.4), 'rock')
            for j in range(rng.randrange(2, 5)):
                ctx.rock(f'ALP_Shore_Shingle_{i}_{j}', xx + rng.uniform(-2, 2), zz + rng.uniform(-2, 2),
                         rng.uniform(.14, .52), 'stone')
        if abs(angle) > .07 and i % 2 == 0:
            # Discrete reed and fern drifts sit at the wet edge, without a rock necklace.
            for j in range(rng.randrange(4, 8)):
                xx = x + math.cos(angle) * rng.uniform(.2, 4.3) + rng.uniform(-1.9, 1.9)
                zz = z + math.sin(angle) * rng.uniform(.2, 4.3) + rng.uniform(-1.9, 1.9)
                if ctx.ground(xx, zz) > 37.2:
                    plant(ctx, f'ALP_Shore_Reed_{i}_{j}', xx, zz,
                          kind='reed' if j < 3 else 'grass', scale=rng.uniform(.75, 1.35))

    ctx.collection('ALP_Village_ConnectedLanes')
    main = [(60, 800), (115, 1000), (155, 1230), (220, 1367), (221, 1528),
            (245, 1685), (455, 1760), (720, 1830), (800, 1810)]
    east_lane = [(265, 1373), (265, 1531)]
    central_cross = [(194, 1454), (285, 1454)]
    south_cross = [(221, 1373), (265, 1373)]
    north_cross = [(221, 1531), (265, 1531)]
    lookout_route = [(221, 1528), (198, 1662), (100, 1773), (-150, 1785), (-320, 1735), (-425, 1752)]
    western_route = [(-800, 950), (-575, 1035), (-270, 1120), (25, 1190), (155, 1230)]
    _route(ctx, routes, 'ALP_Village_MainLane', main, 4.8)
    _route(ctx, routes, 'ALP_Village_EastLane', east_lane, 3.8)
    _route(ctx, routes, 'ALP_Village_MarketCrossLane', central_cross, 3.8, 'alpine_path_stone')
    _route(ctx, routes, 'ALP_Village_SouthConnection', south_cross, 3.6)
    _route(ctx, routes, 'ALP_Village_NorthConnection', north_cross, 3.6)
    _route(ctx, routes, 'ALP_Watchtower_RidgeTrail', lookout_route, 2.7)
    _route(ctx, routes, 'ALP_Western_Connector', western_route, 4.2)
    _stone_edges(ctx, 'ALP_Lane_MasonryEdges', [(221, 1373), (221, 1531)], 4.8, 'stone')
    _stone_edges(ctx, 'ALP_EastLane_MasonryEdges', east_lane, 3.8, 'stone')

    ctx.collection('ALP_Village_CompactChaletParcels')
    building_count = 0
    # Two lanes form four close frontages. Each small home keeps an actual approach
    # and private rear garden; the cross lane reserves a continuous village square.
    rows = [(210, 221, math.pi / 2), (232, 221, -math.pi / 2),
            (254, 265, math.pi / 2), (276, 265, -math.pi / 2)]
    for row, (x, lane_x, yaw) in enumerate(rows):
        for i in range(9):
            if i == 4:
                continue
            z = 1390 + i * 16
            w, d = rng.uniform(8.1, 10.4), rng.uniform(7.2, 9.0)
            h = rng.choice((5.7, 6.1, 6.6)) if (row + i) % 5 else 4.1
            name = f'ALP_Chalet_{row}_{i:02d}'
            ctx.building(name, x, z, w, d, h, 'plaster_ivory' if i % 3 else 'plaster_ochre',
                         'roof_slate', yaw=yaw, style='chalet')
            building_count += 1
            parcels.append((x, z, d / 2 + 2.1, w / 2 + 2.0))
            direction = 1 if yaw > 0 else -1
            entry = entry_anchor(x, z, w, d, yaw)
            _route(ctx, routes, name + '_EntryApproach', [(lane_x, entry[1]), entry], 1.65, 'alpine_path_stone')
            # Functional rear spaces add the same close-range craft as the reference.
            back = x - direction * (d / 2 + 2)
            _fence(ctx, name + '_PrivateGardenFence', [(back, z - w / 2 - .8), (back, z + w / 2 + .8)], height=1.05)
            plant_bed(ctx, name + '_Garden', back + direction * .8, z, 1.45, w - .6,
                      kind='mixed', spacing=.48, seed=20700 + row * 100 + i)
            for side in (-1, 1):
                plant_bed(ctx, name + f'_EntranceFlowers_{side}', x + direction * (d / 2 + .7),
                          z + side * (w / 2 - 1.3), 1.0, 1.35,
                          kind='lavender' if i % 2 else 'daisy', spacing=.37, seed=6200 + row * 100 + i * 3 + side)
            for j in range(8):
                log_x, log_z = back + direction * .3, z - w / 2 + 1.0 + (j % 4) * .22
                gy = ctx.ground(log_x, log_z) + .14 + (j // 4) * .23
                ctx.beam(name + f'_SplitFirewood_{j}', (log_x - .65, gy, log_z),
                         (log_x + .65, gy, log_z), .12, 'bark')
            courtyard_records.append({'id': name + '_PARCEL', 'building': name,
                'frontageRoute': 'ALP_Village_MainLane' if row < 2 else 'ALP_Village_EastLane',
                'entry': list(entry), 'width': d + 4.2, 'depth': w + 4,
                'neighborGapMeters': 16 - w, 'garden': [back, z]})

    for name, x, z, w, d, h, yaw in [
        ('ALP_Lakeside_Inn', 239, 1356, 14.2, 10.5, 6.5, 0),
        ('ALP_Village_MountainLodge', 243, 1547, 13.6, 10.8, 6.8, math.pi),
    ]:
        ctx.building(name, x, z, w, d, h, 'plaster_ivory', 'roof_slate', yaw=yaw, style='chalet')
        building_count += 1
        parcels.append((x, z, w / 2 + 2.1, d / 2 + 2.1))
        entry = entry_anchor(x, z, w, d, yaw, offset=.8)
        _route(ctx, routes, name + '_Approach', [entry, (entry[0], 1373 if yaw == 0 else 1531)], 2.4, 'alpine_path_stone')
        plant_bed(ctx, name + '_Border', x - w / 2 - 1.3, z, 1.5, d + 1.2, kind='mixed', spacing=.5, seed=801 + building_count)

    ctx.collection('ALP_Village_StoneSquareAndFurniture')
    _route(ctx, routes, 'ALP_Village_Square', [(232, 1454), (253, 1454)], 11, 'alpine_path_stone')
    _stone_edges(ctx, 'ALP_Square_EdgeBlocks', [(232, 1454), (253, 1454)], 11, 'stone', step=.65)
    wx, wz = 242.5, 1456
    wy = ctx.ground(wx, wz)
    for course in range(3):
        for i in range(16):
            _wedge(ctx, f'ALP_Village_WellStone_{course}_{i}', wx, wy + course * .30, wz, .63, .98, .285,
                   i * TAU / 16 + .014, (i + 1) * TAU / 16 - .014, 'stone')
    for dx in (-1.15, 1.15):
        ctx.box(f'ALP_Well_Post_{dx}', wx + dx, wy + 1.25, wz, .15, 2.5, .15, 'timber')
    ctx.beam('ALP_Well_Crossbeam', (wx - 1.3, wy + 2.35, wz), (wx + 1.3, wy + 2.35, wz), .11, 'timber')
    ctx.beam('ALP_Well_Rope', (wx, wy + 2.3, wz), (wx, wy + .35, wz), .027, 'cream')
    ctx.cyl('ALP_Well_Roof', wx, wy + 2.75, wz, 1.75, 1.05, 'roof_slate', vertices=4, top=0)
    for i, (x, z, yaw) in enumerate(((234, 1458, 0), (250, 1458, 0), (238, 1449.4, math.pi))):
        _bench(ctx, f'ALP_Square_Bench_{i}', x, z, yaw)
    for x, z in ((231, 1449), (254, 1459.5)):
        plant_bed(ctx, f'ALP_Square_Flowers_{x}', x, z, 1.2, 2.8, kind='mixed', spacing=.37, seed=int(x))

    ctx.collection('ALP_Lake_HumanScalePromenade')
    promenade = []
    for i in range(39):
        a = -1.28 + i * 2.48 / 38
        j = round((a % TAU) / TAU * len(shore)) % len(shore)
        sx, sz = shore[j]
        promenade.append((sx + math.cos(a) * 7, sz + math.sin(a) * 7))
    _route(ctx, routes, 'ALP_Lake_BankPromenade', promenade, 2.8, 'alpine_path_stone')
    _stone_edges(ctx, 'ALP_Lake_PromenadeCurb', promenade, 2.8, 'stone', step=.85)
    shore_east = shore[0][0]
    dock_end = _dock(ctx, shore_east, 1510, 38, length=24)
    dock_route = [(221, 1454), (194, 1454), (176, 1473), (165, 1510), (dock_end, 1510)]
    _route(ctx, routes, 'ALP_Lake_DockApproach', dock_route, 2.8, 'gravel')
    _stone_edges(ctx, 'ALP_Lake_DockApproachEdges', dock_route, 2.8, 'stone')
    for i in (6, 14, 25, 32):
        x, z = promenade[i]
        angle = math.atan2(z - 1510, x + 100)
        _bench(ctx, f'ALP_Promenade_Bench_{i}', x + math.cos(angle) * 2.2, z + math.sin(angle) * 2.2, math.pi / 2 - angle)
    _lookout(ctx, -425, 1740)

    ctx.collection('ALP_Forest_ConnectedCanopy')
    rng = random.Random(8671204)
    groves = [(-360, 1255, 60, 62), (425, 1630, 66, 54)]
    approach_woodland = [(155, 1230), (220, 1367)]
    trees, trunk_grid = [], _TrunkGrid(9)
    tree_count = 0
    # A jittered ecological lattice controls canopy closure; habitat boundaries,
    # selective glades and age variation break any visible planting grid.
    for row in range(129):
        z0 = 915 + row * 8.8
        for col in range(161):
            x = -710 + col * 8.8 + (row % 2) * 4.4 + rng.uniform(-2.4, 2.4)
            z = z0 + rng.uniform(-2.4, 2.4)
            a = math.atan2((z - 1510) / 175, (x + 100) / 240) % TAU
            shore_index = round(a / TAU * len(shore)) % len(shore)
            sx, sz = shore[shore_index]
            radial_offset = math.hypot(x + 100, z - 1510) - math.hypot(sx + 100, sz - 1510)
            woodland_depth = max(35, min(65, 48 + 13 * math.sin(a * 3 + .6) + 5 * math.sin(a * 7)))
            lake_belt = 8 < radial_offset < woodland_depth
            village_wood = 289 < x < 340 and 1350 < z < 1573
            approach_belt = _near_paths(x, z, [approach_woodland], 27)
            foothill_grove = any(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 < 1 for cx, cz, rx, rz in groves)
            if not (lake_belt or village_wood or approach_belt or foothill_grove):
                continue
            y = ctx.ground(x, z)
            if y < 40 or y > 218 or not _path_clear(x, z, routes, 1.25):
                continue
            if any(abs(x - px) < pw + 5.0 and abs(z - pz) < pd + 5.0 for px, pz, pw, pd in parcels):
                continue
            if math.hypot(x + 425, z - 1740) < 15 or (229 < x < 257 and 1445 < z < 1464):
                continue
            # Preserve only a few deliberate meadow reveals rather than evenly
            # scattering isolated trees over all the visible ground.
            glade = ((x - 68) / 48) ** 2 + ((z - 1126) / 32) ** 2 < 1
            if glade or not trunk_grid.add(x, z, 5.3):
                continue
            style = 'oak' if y < 95 and rng.random() < .17 else 'pine'
            height = rng.uniform(16, 23) if style == 'oak' else rng.uniform(21, 30)
            if rng.random() < .14:
                height *= .66
            if y > 178:
                height *= .85
            ctx.tree(f'ALP_Forest_{tree_count:04d}', x, z, height, style=style)
            trees.append((x, z, height, style))
            tree_count += 1

    ctx.collection('ALP_Forest_UnderstoryAndGroundCover')
    understory_count = 0
    for i, (x, z, height, style) in enumerate(trees):
        # Full botanical assemblies share mesh prototypes, keeping the understory
        # detailed even where many thousands of forest instances are visible.
        if i % 2 == 0:
            for j in range(3):
                a = i * 2.399 + j * 2.09
                px, pz = x + math.cos(a) * 2.8, z + math.sin(a) * 2.8
                if not _path_clear(px, pz, routes, .6) or ctx.ground(px, pz) < 38.5:
                    continue
                kind = 'fern' if j == 0 else 'grass' if j == 1 else 'leaf_litter'
                plant(ctx, f'ALP_Understory_{i:04d}_{j}', px, pz, kind=kind,
                      scale=rng.uniform(.65, 1.25))
                understory_count += 1
        if i % 13 == 0 and _path_clear(x, z, routes, 4.2):
            _soil_patch(ctx, f'ALP_ForestFloor_{i:04d}', x, z, 3.2, 2.7, 'alpine_forest_floor', 40300 + i)
        if i % 19 == 0:
            plant(ctx, f'ALP_Woodland_Shrub_{i:04d}', x + 2, z - 2, kind='shrub', scale=rng.uniform(.65, 1.1))
    for row, (x, lane_x, yaw) in enumerate(rows):
        for i in (0, 2, 5, 7):
            z = 1390 + i * 16 + 8
            px = x + (-7.3 if row == 0 else 7.3 if row == 3 else 0)
            if _path_clear(px, z, routes, 1.8):
                ctx.tree(f'ALP_Village_Orchard_{row}_{i}', px, z, rng.uniform(6.8, 9.1), style='oak')
                tree_count += 1

    ctx.collection('ALP_Ridges_ExposedRockAndSnow')
    for i in range(150):
        x, z = rng.uniform(-760, 750), rng.uniform(1040, 2340)
        y = ctx.ground(x, z)
        if y < 138 or not _path_clear(x, z, routes, 9):
            continue
        ctx.rock(f'ALP_Ridge_Outcrop_{i:03d}', x, z, rng.uniform(4, 13), 'snow' if y > 220 else 'rock')
    layout = {'id': 'REG_ALPINE', 'villageCenter': [243, 1454], 'humanScale': True,
              'buildingCount': building_count, 'closedExteriors': True, 'parcels': courtyard_records,
              'routes': routes, 'forestBelts': [{'type': 'shore-following woodland', 'waterContour': shore,
                'innerOffsetMeters': 8, 'depthRangeMeters': [35, 65], 'depthFormula': 'clamp(48+13*sin(3*a+0.6)+5*sin(7*a),35,65)'},
                {'type': 'village back woodland', 'bounds': [289, 340, 1350, 1573]},
                {'type': 'approach woodland', 'centerline': approach_woodland, 'halfWidthMeters': 27}],
              'foothillGroves': [{'center': [x, z], 'radii': [rx, rz]} for x, z, rx, rz in groves],
              'ecologyRationale': 'Dense woodland encloses lake, compact village and approach; higher slopes remain exposed alpine meadow and rock.',
              'canopySpacingMeters': 8.8, 'trees': tree_count, 'understoryAssemblies': understory_count,
              'referencesApplied': ['Willowmere complete overlapping crowns, cottage proportions and detailed flower gardens',
                                    'Fleur du Lac layered stone promenade, benches and wet-edge vegetation']}
    ctx.environment_layout = layout
    return {'biome': 'alpine', 'trees': tree_count, 'buildings': building_count,
            'landmark': [-425, 1740], 'water_level': 38, 'paths': [r['points'] for r in routes], 'layout': layout}

def _geology_mesh(ctx, name, vertices, faces, material):
    """Meter-scale erosion is geometry; packed stone pores supply close detail."""
    if hasattr(ctx, '_object'):
        from detailed_architecture import textured_material
        material = textured_material(ctx, material, 'stone')
    obj = ctx.mesh(name, vertices, faces, material)
    if obj is not None and hasattr(obj, 'data'):
        # Stratum clipping keeps separate face vertices for exact material
        # boundaries. Average their normals by coincident position without
        # welding, removing, or moving any geometry.
        normal_sum = {}
        for polygon in obj.data.polygons:
            weighted = polygon.normal * polygon.area
            for vertex_index in polygon.vertices:
                key = tuple(obj.data.vertices[vertex_index].co)
                if key not in normal_sum:
                    normal_sum[key] = weighted.copy()
                else:
                    normal_sum[key] += weighted
            polygon.use_smooth = True
        normals = [normal_sum[tuple(v.co)].normalized() if tuple(v.co) in normal_sum else (0, 0, 1)
                   for v in obj.data.vertices]
        obj.data.normals_split_custom_set_from_vertices(normals)
        uv = obj.data.uv_layers.new(name='GeologyMeterScale')
        for polygon in obj.data.polygons:
            axis = max(range(3), key=lambda i: abs(polygon.normal[i]))
            axes = [i for i in range(3) if i != axis]
            for loop_index in polygon.loop_indices:
                point = obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
                uv.data[loop_index].uv = (point[axes[0]] / 2, point[axes[1]] / 2)
        obj['geology_surface'] = 'Layered eroded sandstone with true surface relief and packed normal/roughness'
    return obj


def repair_geology_float32_degenerates(scene):
    """Repair only collapsed arch clip faces in an already-built source.

    Used by the final landscape integration before its single source save and
    export. No positive-area faces, objects, materials or UVs are removed.
    """
    import bmesh
    seen, repaired = set(), []
    for obj in scene.objects:
        if obj.type != 'MESH' or '/CAN_NaturalArch_ErodedStratum_' not in obj.name:
            continue
        data = obj.data
        if data.as_pointer() in seen:
            continue
        seen.add(data.as_pointer())
        data.calc_loop_triangles()
        before = len(data.loop_triangles)
        bm = bmesh.new()
        bm.from_mesh(data)
        collapsed = [face for face in bm.faces if face.calc_area() == 0.0]
        if collapsed:
            for face in collapsed:
                bm.faces.remove(face)
            bm.to_mesh(data)
            data.update()
            data.calc_loop_triangles()
            repaired.append({'mesh': data.name, 'trianglesBefore': before,
                             'trianglesAfter': len(data.loop_triangles),
                             'removedZeroAreaFaces': len(collapsed)})
        bm.free()
    return {'scope': 'Natural-arch layer clipping only', 'removedPositiveAreaFaces': 0,
            'repairedMeshes': repaired, 'removedTriangles': sum(r['trianglesBefore'] - r['trianglesAfter'] for r in repaired)}


def refresh_canyon_geology(scene):
    """Replace only the authored canyon strata before final landscape export.

    Replays deterministic placement through a geometry filter, preserving all
    architecture, vegetation, water, route, and talus objects already in source.
    """
    import bpy
    from scene_kit import Context, ground, color

    def is_stratum(name):
        short = name.split('/')[-1]
        return (short.startswith('CAN_NaturalArch_ErodedStratum_')
                or short.startswith(('CAN_Mesa_', 'CAN_Spire_')) and '_Stratum_' in short)

    previous = [obj for obj in scene.objects if obj.type == 'MESH' and is_stratum(obj.name)]
    before = 0
    for obj in previous:
        obj.data.calc_loop_triangles()
        before += len(obj.data.loop_triangles)
        bpy.data.objects.remove(obj, do_unlink=True)
    ctx = Context.__new__(Context)
    ctx.region, ctx.meshes, ctx.entries, ctx.buildings = 'REG_CANYON', {}, [], []
    ctx.materials = {material.name: material for material in bpy.data.materials}
    terrain_ground = ground

    class GeologyOnly:
        ground = staticmethod(terrain_ground)

        def collection(self, name):
            full = ctx.region + '/' + name
            ctx.current = bpy.data.collections.get(full)
            if ctx.current is None:
                ctx.current = bpy.data.collections.new(full)
                scene.collection.children.link(ctx.current)

        def mesh(self, name, vertices, faces, material):
            if is_stratum(name):
                _geology_mesh(ctx, name, vertices, faces, material)

        def material(self, name, value, roughness=.8, metallic=0):
            if not name.startswith('can_strata_'):
                return
            rgba = (*color(value), 1)
            for key in (name, name + '/crafted-stone'):
                material = ctx.materials.get(key)
                if material is not None:
                    material.diffuse_color = rgba
                    bs = material.node_tree.nodes.get('Principled BSDF')
                    bs.inputs['Base Color'].default_value = rgba
                    bs.inputs['Roughness'].default_value = roughness

        def box(self, *args, **kwargs): pass
        def cyl(self, *args, **kwargs): pass
        def beam(self, *args, **kwargs): pass
        def path(self, *args, **kwargs): pass
        def tree(self, *args, **kwargs): pass
        def building(self, *args, **kwargs): pass
        def rock(self, *args, **kwargs): pass

    replay = GeologyOnly()
    build_canyon(replay)
    current = [obj for obj in scene.objects if obj.type == 'MESH' and is_stratum(obj.name)]
    after = 0
    for obj in current:
        obj.data.calc_loop_triangles()
        after += len(obj.data.loop_triangles)
    return {'scope': 'Authored canyon arch and mesa strata only', 'objectsBefore': len(previous),
            'objectsAfter': len(current), 'trianglesBefore': before, 'trianglesAfter': after,
            'objects': ctx.entries, 'geometryRevision': 'Irregular weathering and subdued sediment bands',
            'clipPrecisionAudit': getattr(replay, 'geology_clip_audit', {}),
            'degenerateRepair': repair_geology_float32_degenerates(scene)}


def _sandstone_arch(ctx, x=1830, z=1550):
    ctx.collection('CAN_Hero_NaturalSandstoneArch')
    rng = random.Random(901332)
    n, divisions = 160, 28
    verts, faces = [], []
    clip_audit = {'candidateTriangles': 0, 'omittedZeroFloat32AreaTriangles': 0,
                  'duplicateBoundaryVertices': 0}
    foot = min(ctx.ground(x, z - 100), ctx.ground(x, z + 100)) - 3
    for i in range(n + 1):
        a = math.pi * i / n
        for side in (-1, 1):
            for j in range(divisions + 1):
                frac = j / divisions
                erosion = math.sin(a * 5 + .3) * 2 + math.sin(a * 11 + .4)
                inner = 74 + 6 * math.sin(a * 3)
                outer = 117 + 8 * math.sin(a * 2) + erosion * 1.5
                radial = inner * (1 - frac) + outer * frac
                zz = z + math.cos(a) * radial + math.sin(a) ** 2 * 7
                thickness = 19 + math.sin(a) * 10 + 2.4 * math.sin(a * 4 + frac * 2)
                xx = x + side * thickness + math.sin(a * 3) * 2.2
                blend = math.sin(a) ** .55
                base = (ctx.ground(xx, zz) - .4) * (1 - blend) + foot * blend
                yy = base + math.sin(a) ** .83 * (78 + frac * 38 + 8 * math.sin(a * 2))
                yy += erosion * (frac * 1.8 + .35) * math.sin(a)
                # Differential weathering follows bedding while vertical joints
                # create fluted rock faces. The two sides erode independently.
                relief = (.95 * math.sin(zz * .091 + yy * .023 + side * .8)
                          + .46 * math.sin(zz * .267 + yy * .13)
                          + .23 * math.sin(zz * .63 + yy * .71)
                          - .65 * max(0, math.sin(zz * .175 + yy * .017 + side)) ** 8)
                for seam in (21, 43, 69, 80, 102):
                    relief -= .48 * math.exp(-((yy - foot - seam - .5 * math.sin(zz * .04)) / .7) ** 2)
                relief *= .4 + .6 * math.sin(a) ** .3
                xx += side * relief
                verts.append((xx, yy, zz))
    stride = 2 * (divisions + 1)
    for i in range(n):
        for j in range(divisions):
            p, q = i * stride + j, (i + 1) * stride + j
            faces.append((p + 1, q + 1, q, p))
            p += divisions + 1
            q += divisions + 1
            faces.append((q, q + 1, p + 1, p))
        p, q = i * stride, (i + 1) * stride
        faces.append((q, q + divisions + 1, p + divisions + 1, p))
        faces.append((p + divisions, p + stride - 1, q + stride - 1, q + divisions))
    for i in (0, n):
        p = i * stride
        for j in range(divisions):
            face = (p + j, p + j + divisions + 1, p + j + divisions + 2, p + j + 1)
            faces.append(face if i == 0 else tuple(reversed(face)))

    # Clip the irregular rock volume into genuine horizontal sedimentary layers.
    # Curving color bands would misleadingly resemble manufactured rainbow ribs.
    levels = [foot - 200, foot + 18, foot + 18.28, foot + 31, foot + 31.22,
              foot + 54, foot + 54.24, foot + 64, foot + 64.30,
              foot + 85, foot + 85.22, foot + 94, foot + 94.26, foot + 160, foot + 800]
    colors = ['sandstone', 'can_strata_light', 'can_strata_dark', 'can_strata_gold',
              'sandstone', 'can_strata_light', 'can_strata_gold', 'can_strata_light',
              'sandstone', 'can_strata_gold', 'can_strata_light', 'can_strata_dark',
              'sandstone', 'sandstone']

    def clipped(poly, level, keep_above):
        out = []
        for a, b in zip(poly, poly[1:] + poly[:1]):
            inside_a = a[1] >= level if keep_above else a[1] <= level
            inside_b = b[1] >= level if keep_above else b[1] <= level
            if inside_a:
                out.append(a)
            if inside_a != inside_b:
                t = (level - a[1]) / (b[1] - a[1])
                out.append(tuple(a[k] + (b[k] - a[k]) * t for k in range(3)))
        # A vertex exactly on the bedding plane can be emitted by both the
        # retained corner and edge intersection. Keep one copy, so clipping
        # cannot manufacture a zero-area triangle at that corner.
        unique = []
        for point in out:
            if not unique or sum((point[k] - unique[-1][k]) ** 2 for k in range(3)) > 1e-16:
                unique.append(point)
        if len(unique) > 1 and sum((unique[0][k] - unique[-1][k]) ** 2 for k in range(3)) <= 1e-16:
            unique.pop()
        clip_audit['duplicateBoundaryVertices'] += len(out) - len(unique)
        return unique

    for band, material in enumerate(colors):
        out_vertices, out_faces = [], []
        for face in faces:
            for k in range(1, len(face) - 1):
                triangle = [verts[face[0]], verts[face[k]], verts[face[k + 1]]]
                poly = clipped(clipped(triangle, levels[band], True), levels[band + 1], False)
                if len(poly) < 3:
                    continue
                offset = len(out_vertices)
                out_vertices.extend(poly)
                for j in range(1, len(poly) - 1):
                    clip_audit['candidateTriangles'] += 1
                    # Blender stores mesh positions as float32. Near an exact
                    # layer boundary a micrometer sliver can collapse after
                    # storage; omit only faces with zero representable area.
                    tri = [struct.unpack('fff', struct.pack('fff', *poly[k])) for k in (0, j, j + 1)]
                    u = [tri[1][k] - tri[0][k] for k in range(3)]
                    v = [tri[2][k] - tri[0][k] for k in range(3)]
                    normal = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
                    if sum(component * component for component in normal) > 0:
                        out_faces.append((offset, offset + j, offset + j + 1))
                    else:
                        clip_audit['omittedZeroFloat32AreaTriangles'] += 1
        if out_faces:
            _geology_mesh(ctx, f'CAN_NaturalArch_ErodedStratum_{band}', out_vertices, out_faces, material)
    ctx.geology_clip_audit = clip_audit
    for side in (-1, 1):
        for j in range(10):
            xx = x + rng.uniform(-32, 32)
            zz = z + side * rng.uniform(92, 128)
            ctx.rock(f'CAN_NaturalArch_FootTalus_{side}_{j}', xx, zz, rng.uniform(3.8, 10), 'sandstone')


def _mesa(ctx, name, x, z, radius, height, rng):
    base = ctx.ground(x, z) - 3
    sides = 128
    rotation = rng.uniform(0, TAU)
    phase = rng.uniform(0, TAU)
    irregular = [.94 + .105 * math.sin(i * TAU / sides * 3 + phase)
                 + .065 * math.sin(i * TAU / sides * 7 + phase * .6)
                 + .045 * math.sin(i * TAU / sides * 13) for i in range(sides)]
    mat = ['sandstone', 'can_strata_dark', 'can_strata_light', 'sandstone', 'can_strata_gold',
           'sandstone', 'can_strata_light', 'sandstone', 'can_strata_dark', 'can_strata_light',
           'sandstone', 'can_strata_gold']
    radii = [1.10, 1.04, .96, .935, .89, .875, .825, .81, .77, .73, .705, .67, .64]
    yfracs = [0, .045, .13, .15, .27, .292, .42, .441, .58, .72, .745, .86, 1]
    for band in range(len(mat)):
        vertices = []
        steps = max(2, math.ceil(height * (yfracs[band + 1] - yfracs[band]) / 2.0))
        for step in range(steps + 1):
            t = step / steps
            level = band + t
            yfrac = yfracs[band] * (1 - t) + yfracs[band + 1] * t
            radial = radii[band] * (1 - t) + radii[band + 1] * t
            for i in range(sides):
                a = i * TAU / sides + rotation
                r = radius * radial * irregular[i] * (1 + .035 * math.sin(a * 5 + level * .42))
                r += min(radius * .025, .85) * (.55 * math.sin(height * yfrac * .41 + a * 3.1)
                                               + .24 * math.sin(height * yfrac * .91 + a * 13)
                                               - max(0, math.sin(a * 19 + phase + yfrac)) ** 8)
                xx, zz = x + math.cos(a) * r, z + math.sin(a) * r
                yy = base + height * yfrac + math.sin(a * 3 + phase) * .65
                if level == 0:
                    yy = min(yy, ctx.ground(xx, zz) - 1)
                vertices.append((xx, yy, zz))
        faces = [(j * sides + i, (j + 1) * sides + i, (j + 1) * sides + (i + 1) % sides,
                  j * sides + (i + 1) % sides) for j in range(steps) for i in range(sides)]
        if band == len(mat) - 1:
            faces.append(tuple(range((steps + 1) * sides - 1, steps * sides - 1, -1)))
        _geology_mesh(ctx, f'{name}_Stratum_{band}', vertices, faces, mat[band])


def _market_stall(ctx, name, x, z, material):
    y = ctx.ground(x, z)
    for dx in (-2.6, 2.6):
        for dz in (-1.9, 1.9):
            ctx.box(f'{name}_Post_{dx}_{dz}', x + dx, y + 1.9, z + dz, .18, 3.8, .18, 'timber')
    roof = [(x - 2.9, y + 3.7, z - 2.2), (x + 2.9, y + 3.7, z - 2.2),
            (x + 2.9, y + 3.7, z + 2.2), (x - 2.9, y + 3.7, z + 2.2),
            (x, y + 4.25, z - 2.2), (x, y + 4.25, z + 2.2)]
    ctx.mesh(name + '_CanvasRoof', roof, [(3, 5, 4, 0), (5, 2, 1, 4)], material)
    ctx.box(name + '_DisplayTable', x, y + 1.12, z, 4.9, .25, 1.8, 'timber')
    for dx in (-1.85, 1.85):
        ctx.box(name + f'_TableLeg_{dx}', x + dx, y + .5, z, .23, 1, 1.4, 'timber')
    for i in range(4):
        xx = x - 1.75 + i * 1.15
        ctx.cyl(name + f'_PotBody_{i}', xx, y + 1.65, z, .4, .7, 'roof_terracotta', vertices=12, top=.27)
        ctx.cyl(name + f'_PotRim_{i}', xx, y + 2.02, z, .30, .13, 'plaster_ochre', vertices=12, top=.34)


def _canyon_watchtower(ctx, x, z):
    y = ctx.ground(x, z)
    ctx.collection('CAN_Settlement_Watchtower')
    ctx.building('CAN_Watchtower_Base', x, z, 8.4, 8.4, 14.2, 'plaster_ochre', 'sandstone', style='adobe')
    for side in (-1, 1):
        ctx.box(f'CAN_Watchtower_UpperWall_X_{side}', x + side * 4.1, y + 14.82, z,
                .42, 1.0, 8.65, 'plaster_ochre')
        ctx.box(f'CAN_Watchtower_UpperWall_Z_{side}', x, y + 14.82, z + side * 4.1,
                8.65, 1.0, .42, 'plaster_ochre')
    for i in range(4):
        dx, dz = (-3.95 if i in (0, 3) else 3.95), (-3.95 if i < 2 else 3.95)
        ctx.box(f'CAN_Watchtower_CornerButtress_{i}', x + dx, y + 7.3, z + dz,
                1.10, 14.9, 1.10, 'sandstone')
        ctx.box(f'CAN_Watchtower_CornerCap_{i}', x + dx, y + 15.4, z + dz,
                1.30, .70, 1.30, 'plaster_ochre')
    for side in (-1, 1):
        for i in range(-2, 3):
            ctx.box(f'CAN_Watchtower_Merlon_X_{side}_{i}', x + side * 4.12, y + 15.62, z + i * 1.32,
                    .55, .65, .60, 'plaster_ochre')
            ctx.box(f'CAN_Watchtower_Merlon_Z_{side}_{i}', x + i * 1.32, y + 15.62, z + side * 4.12,
                    .60, .65, .55, 'plaster_ochre')
    ctx.beam('CAN_Watchtower_FlagMast', (x, y + 14.4, z), (x, y + 20.7, z), .09, 'timber')
    ctx.mesh('CAN_Watchtower_WovenBanner', [(x, y + 20.3, z), (x + 2.6, y + 20.05, z + .15),
             (x + 2.4, y + 18.4, z + .24), (x, y + 18.35, z)], [(0, 1, 2, 3)], 'plaster_rose')


def build_canyon(ctx):
    rng = random.Random(5932408)
    plant, plant_bed = _landscape_helpers()
    ctx.material('can_strata_dark', (.69, .40, .244, 1), roughness=.92)
    ctx.material('can_strata_gold', (.73, .439, .276, 1), roughness=.88)
    ctx.material('can_strata_light', (.76, .455, .288, 1), roughness=.9)
    ctx.material('can_oasis_soil', (.43, .34, .19, 1), roughness=.96)
    ctx.material('can_courtyard_paving', (.63, .52, .355, 1), roughness=.92)
    ctx.collection('CAN_Oasis_WaterAndLivingBank')
    shore = _water(ctx, 'CAN_Oasis_WaterSurface', 1510, 1450, 150, 105, 19, count=144)
    routes, parcels, courtyard_records = [], [], []
    for i, (x, z) in enumerate(shore):
        a = TAU * i / len(shore)
        if (.55 < a < 1.2 or 2.0 < a < 2.48 or 3.4 < a < 3.74) and rng.random() < .52:
            xx, zz = x + math.cos(a) * 1.4, z + math.sin(a) * 1.4
            ctx.rock(f'CAN_Oasis_ShoreStone_{i:03d}', xx, zz, rng.uniform(.6, 1.65), 'sandstone')
            for j in range(4):
                ctx.rock(f'CAN_Oasis_Shingle_{i}_{j}', xx + rng.uniform(-2, 2), zz + rng.uniform(-2, 2),
                         rng.uniform(.13, .43), 'sandstone')
        if i % 2 == 0:
            for j in range(6):
                xx = x + math.cos(a) * rng.uniform(.1, 5) + rng.uniform(-1.3, 1.3)
                zz = z + math.sin(a) * rng.uniform(.1, 5) + rng.uniform(-1.3, 1.3)
                if ctx.ground(xx, zz) > 18.65:
                    plant(ctx, f'CAN_WetBank_{i}_{j}', xx, zz, kind='reed' if j < 3 else 'grass', scale=rng.uniform(.85, 1.7))

    ctx.collection('CAN_Medina_NarrowConnectedLanes')
    west_entry = [(800, 1810), (1050, 1730), (1210, 1650), (1278, 1606), (1450, 1606)]
    arch_route = [(1432, 1606), (1490, 1615), (1685, 1613), (1830, 1550), (2010, 1575), (2200, 1725)]
    south_route = [(1304, 1606), (1272, 1606), (1271, 1545), (1282, 1370), (1310, 1170), (1370, 970), (1450, 800)]
    north_route = [(1368, 1710), (1375, 1810), (1510, 1940), (1800, 2130)]
    _route(ctx, routes, 'CAN_Market_CaravanStreet', west_entry, 5.2, 'sand')
    _route(ctx, routes, 'CAN_Arch_CaravanTrail', arch_route, 4.6, 'sand')
    _route(ctx, routes, 'CAN_Southern_Connector', south_route, 4.8, 'sand')
    _route(ctx, routes, 'CAN_Northern_Connector', north_route, 4.4, 'sand')
    for i, x in enumerate((1304, 1336, 1368, 1400, 1432)):
        _route(ctx, routes, f'CAN_Medina_Alley_NS_{i}', [(x, 1606), (x, 1708)], 3.25, 'can_courtyard_paving')
    for i, z in enumerate((1640, 1674, 1708)):
        _route(ctx, routes, f'CAN_Medina_Alley_EW_{i}', [(1304, z), (1432, z)], 3.15, 'can_courtyard_paving')
    _stone_edges(ctx, 'CAN_Market_WornStoneEdges', [(1278, 1606), (1450, 1606)], 5.2, 'sandstone', step=.75)

    ctx.collection('CAN_Medina_CourtyardHouseFamilies')
    building_count = 0
    # Each parcel is a three-wing courtyard with an open southern entrance.
    # Side passages remain >2m, while narrow public alleys connect every frontage.
    for row, cz in enumerate((1623, 1657, 1691)):
        for col, cx in enumerate((1320, 1352, 1384, 1416)):
            parcel_id = f'CAN_Courtyard_{row}_{col}'
            family_rng = random.Random(7200 + row * 19 + col)
            left_w, right_w = family_rng.uniform(8.2, 9.5), family_rng.uniform(8.0, 9.5)
            left_d, right_d = family_rng.uniform(6.7, 7.4), family_rng.uniform(6.8, 7.4)
            homes = [('West', cx - 7.9, cz, left_w, left_d, family_rng.choice((4.0, 5.8, 6.2)), math.pi / 2),
                     ('East', cx + 7.9, cz + .3, right_w, right_d, family_rng.choice((4.2, 5.8, 6.0)), -math.pi / 2),
                     ('North', cx, cz + 10.8, family_rng.uniform(8.5, 10.5), 6.8,
                      family_rng.choice((5.9, 6.3, 6.8)), math.pi)]
            for side, x, z, w, d, h, yaw in homes:
                name = parcel_id + '_' + side
                material = ('plaster_ochre', 'plaster_ivory', 'plaster_rose')[(row + col + (side == 'East')) % 3]
                building = ctx.building(name, x, z, w, d, h, material, 'sandstone', yaw=yaw, style='adobe')
                building_count += 1
                footprint_x = d / 2 if side != 'North' else w / 2
                footprint_z = w / 2 if side != 'North' else d / 2
                parcels.append((x, z, footprint_x + .9, footprint_z + .9))
                entry = entry_anchor(x, z, w, d, yaw, offset=.8)
                _route(ctx, routes, name + '_CourtyardApproach', [(cx, cz), entry], 1.45, 'can_courtyard_paving')
                gy = ctx.ground(x, z)
                roof_top = gy + (building['roof']['eaves'] if isinstance(building, dict) else h) + .16
                for j in range(2):
                    u, v = -.65 + j * 1.3, d * .25
                    jar_x, jar_z = x + u * math.cos(yaw) + v * math.sin(yaw), z - u * math.sin(yaw) + v * math.cos(yaw)
                    ctx.cyl(name + f'_RoofJar_{j}', jar_x, roof_top + .37, jar_z,
                            .26, .74, 'roof_terracotta', vertices=16, top=.14)
                    ctx.cyl(name + f'_JarNeck_{j}', jar_x, roof_top + .79, jar_z,
                            .16, .10, 'plaster_ochre', vertices=16, top=.18)
                roof_pavilion = isinstance(building, dict) and building.get('variant', 0) % 3 == 1
                if side == 'North' and (row + col) % 2 == 0 and not roof_pavilion:
                    # A timber roof pergola has matching posts, beams and shade slats.
                    for dx in (-2, 2):
                        for dz in (-1.35, 1.35):
                            ctx.box(name + f'_PergolaPost_{dx}_{dz}', x + dx, roof_top + 1.1, z + dz,
                                    .12, 2.2, .12, 'timber')
                    for dz in (-1.35, 1.35):
                        ctx.box(name + f'_PergolaBeam_{dz}', x, roof_top + 2.28, z + dz, 4.5, .16, .15, 'timber')
                    for j in range(12):
                        ctx.box(name + f'_PergolaSlat_{j}', x - 2.1 + j * .38, roof_top + 2.41, z,
                                .15, .10, 3.15, 'timber')
            courtyard_lane = [(cx, cz - 17), (cx, cz)]
            _route(ctx, routes, parcel_id + '_EntranceLane', courtyard_lane, 2.2, 'can_courtyard_paving')
            # A shallow covered cistern, planted clay beds and one tall date palm
            # make the open courtyard a usable space rather than leftover gaps.
            y = ctx.ground(cx + 2.8, cz + 3.9)
            for j in range(12):
                _wedge(ctx, parcel_id + f'_CisternCoping_{j}', cx + 2.8, y, cz + 3.9, .48, .75, .57,
                       TAU * j / 12 + .015, TAU * (j + 1) / 12 - .015, 'sandstone')
            ctx.cyl(parcel_id + '_CisternLid', cx + 2.8, y + .62, cz + 3.9, .56, .1, 'timber', vertices=16)
            plant_bed(ctx, parcel_id + '_HerbBed', cx - 2.3, cz + 3.5, 1.0, 2.3,
                      kind='mixed', spacing=.38, seed=4100 + row * 11 + col)
            ctx.tree(parcel_id + '_DatePalm', cx - 2.3, cz - 2.6, family_rng.uniform(11.5, 14.5), style='palm')
            for dx in (-2.9, 2.9):
                wall_y = ctx.ground(cx + dx, cz - 6.0)
                ctx.box(parcel_id + f'_LowEntranceWall_{dx}', cx + dx, wall_y + .52, cz - 6.0,
                        3.25, 1.04, .30, 'plaster_ochre')
                ctx.box(parcel_id + f'_WallCoping_{dx}', cx + dx, wall_y + 1.06, cz - 6.0,
                        3.42, .11, .40, 'sandstone')
            courtyard_records.append({'id': parcel_id, 'center': [cx, cz], 'envelopeMeters': [25.2, 28.6],
                'buildings': [parcel_id + '_' + side for side in ('West', 'East', 'North')],
                'frontage': [cx, cz - 17], 'entranceWidthMeters': 2.2, 'sidePassageMinimumMeters': 2.35})

    ctx.collection('CAN_Market_CivicFrontagesAndStalls')
    civic = [('CAN_Caravanserai', 1292, 1589, 14.5, 11, 6.6, math.pi / 2),
             ('CAN_Oasis_TeaHouse', 1425, 1587, 12, 10, 5.8, -math.pi / 2)]
    for name, x, z, w, d, h, yaw in civic:
        ctx.building(name, x, z, w, d, h, 'plaster_ochre' if 'Caravan' in name else 'plaster_ivory', 'sandstone', yaw=yaw, style='adobe')
        building_count += 1
        parcels.append((x, z, d / 2 + 1.4, w / 2 + 1.4))
        entry = entry_anchor(x, z, w, d, yaw)
        _route(ctx, routes, name + '_Approach', [(x, 1606), (x + math.sin(yaw) * (d / 2 + 1.8), 1600),
                                             (entry[0] + math.sin(yaw) * 1.2, entry[1] + math.cos(yaw) * 1.2),
                                             entry], 2.0, 'can_courtyard_paving')
    _canyon_watchtower(ctx, 1287, 1694)
    parcels.append((1287, 1694, 6.5, 6.5))
    building_count += 1
    _route(ctx, routes, 'CAN_Watchtower_Approach', [(1304, 1694), (1295, 1694), (1295, 1700), (1287, 1700),
                                               entry_anchor(1287, 1694, 8.4, 8.4)], 2.5, 'can_courtyard_paving')
    _route(ctx, routes, 'CAN_Market_PublicSquare', [(1338, 1592), (1387, 1592)], 15, 'can_courtyard_paving')
    for i, (x, z) in enumerate(((1338, 1600), (1351, 1600), (1381, 1600), (1394, 1600),
                               (1344, 1584), (1387, 1584))):
        _market_stall(ctx, f'CAN_Market_Stall_{i:02d}', x, z, 'cream' if i % 2 else 'plaster_rose')
    for i, (x, z) in enumerate(((1336, 1590), (1402, 1600), (1329, 1582), (1399, 1583))):
        y = ctx.ground(x, z)
        for j in range(4):
            ctx.cyl(f'CAN_Market_StorageJar_{i}_{j}', x + (j % 2) * .66, y + .52, z + (j // 2) * .65,
                    .28, 1.0, 'roof_terracotta', vertices=16, top=.16)
            ctx.cyl(f'CAN_Market_JarRim_{i}_{j}', x + (j % 2) * .66, y + 1.04, z + (j // 2) * .65,
                    .18, .09, 'plaster_ochre', vertices=16, top=.20)
    _bench(ctx, 'CAN_TeaHouse_Bench', 1416, 1585, -math.pi / 2)
    _bench(ctx, 'CAN_Market_Bench', 1370, 1585)

    ctx.collection('CAN_Oasis_FootpathsAndIrrigation')
    oasis_route = [(1368, 1606), (1368, 1592), (1436, 1572), (1510, 1565)]
    _route(ctx, routes, 'CAN_Oasis_Access', oasis_route, 2.6, 'sand')
    bank_path = []
    for i in range(46):
        a = -.2 + i * 3.85 / 45
        j = round((a % TAU) / TAU * len(shore)) % len(shore)
        sx, sz = shore[j]
        bank_path.append((sx + math.cos(a) * 5.0, sz + math.sin(a) * 5.0))
    _route(ctx, routes, 'CAN_Oasis_BankWalk', bank_path, 1.9, 'can_courtyard_paving')
    _stone_edges(ctx, 'CAN_Oasis_WalkEdges', bank_path, 1.9, 'sandstone', step=.7)
    for i in (12, 27, 38):
        x, z = bank_path[i]
        a = math.atan2(z - 1450, x - 1510)
        _bench(ctx, f'CAN_Oasis_ShadedBench_{i}', x + math.cos(a) * 1.9, z + math.sin(a) * 1.9, math.pi / 2 - a)

    _sandstone_arch(ctx)
    ctx.collection('CAN_Mesas_ExteriorRim')
    mesa_sites = [(2145, 1205, 69, 102), (2255, 1415, 84, 130), (2230, 1830, 80, 107),
                  (2050, 2130, 76, 126), (1750, 2230, 94, 105), (1510, 2210, 60, 85),
                  (1100, 2100, 66, 79), (1925, 1080, 62, 97), (1640, 1030, 47, 65)]
    for i, (x, z, radius, height) in enumerate(mesa_sites):
        _mesa(ctx, f'CAN_Mesa_{i:02d}', x, z, radius, height, rng)
    for i in range(34):
        x, z = rng.uniform(980, 2310), rng.uniform(950, 2290)
        if ((x - 1510) / 300) ** 2 + ((z - 1450) / 230) ** 2 < 1 or not _path_clear(x, z, routes, 28):
            continue
        if 1250 < x < 1470 and 1550 < z < 1750 or math.hypot(x - 1830, z - 1550) < 170:
            continue
        _mesa(ctx, f'CAN_Spire_{i:02d}', x, z, rng.uniform(9, 19), rng.uniform(33, 80), rng)

    ctx.collection('CAN_Oasis_OverlappingPalmCanopy')
    rng = random.Random(5932409)
    irrigated_groves = [(1454, 1582, 25, 32), (1515, 1591, 33, 22)]
    palms, trunk_grid, planted = 12, _TrunkGrid(7), []
    for row in range(69):
        z0 = 1235 + row * 6.7
        for col in range(84):
            x = 1230 + col * 6.7 + (row % 2) * 3.35 + rng.uniform(-1.8, 1.8)
            z = z0 + rng.uniform(-1.8, 1.8)
            a = math.atan2((z - 1450) / 105, (x - 1510) / 150) % TAU
            shore_index = round(a / TAU * len(shore)) % len(shore)
            sx, sz = shore[shore_index]
            radial_offset = math.hypot(x - 1510, z - 1450) - math.hypot(sx - 1510, sz - 1450)
            grove_depth = max(20, min(45, 33 + 12 * math.sin(a * 4 + .5)))
            shore_grove = 3 < radial_offset < grove_depth
            irrigated = any(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 < 1 for cx, cz, rx, rz in irrigated_groves)
            if not (shore_grove or irrigated):
                continue
            if ctx.ground(x, z) < 20.1 or not _path_clear(x, z, routes, .85):
                continue
            if any(abs(x - px) < pw + .9 and abs(z - pz) < pd + .9 for px, pz, pw, pd in parcels):
                continue
            if 1332 < x < 1406 and 1578 < z < 1604 or not trunk_grid.add(x, z, 3.85):
                continue
            kind = 'palm' if rng.random() > .10 else 'oak'
            height = rng.uniform(11.2, 18.5) if kind == 'palm' else rng.uniform(6.1, 9.4)
            ctx.tree(f'CAN_Oasis_GroveTree_{palms:04d}', x, z, height, style=kind)
            planted.append((x, z))
            palms += 1

    ctx.collection('CAN_Oasis_LushUnderstory')
    for i, (x, z) in enumerate(planted):
        if i % 2 == 0 and _path_clear(x, z, routes, 3):
            _soil_patch(ctx, f'CAN_Oasis_LivingGround_{i:04d}', x, z, 3.8, 3.2, 'can_oasis_soil', 50600 + i)
        for j in range(3):
            a = i * 2.399 + j * TAU / 3
            px, pz = x + math.cos(a) * 1.8, z + math.sin(a) * 1.8
            if ctx.ground(px, pz) > 19.8 and _path_clear(px, pz, routes, .45):
                plant(ctx, f'CAN_Oasis_Understory_{i:04d}_{j}', px, pz,
                      kind='grass' if j != 2 else 'shrub', scale=rng.uniform(.65, 1.35))
    for i, (x, z) in enumerate(((1300, 1581), (1410, 1579), (1332, 1587), (1402, 1589))):
        ctx.tree(f'CAN_Market_ShadePalm_{i}', x, z, rng.uniform(12.5, 15.5), style='palm')
        palms += 1
        plant_bed(ctx, f'CAN_Market_PlantedBorder_{i}', x + 1.1, z, 1.5, 3.0,
                  kind='mixed', spacing=.45, seed=8000 + i)

    ctx.collection('CAN_Desert_FootTalusAndScrub')
    for i in range(205):
        x, z = rng.uniform(890, 2340), rng.uniform(870, 2340)
        if ((x - 1510) / 230) ** 2 + ((z - 1450) / 185) ** 2 < 1:
            continue
        if not _path_clear(x, z, routes, 7) or 1250 < x < 1470 and 1530 < z < 1750:
            continue
        size = rng.uniform(.6, 5)
        ctx.rock(f'CAN_Desert_Talus_{i:03d}', x, z, size, 'sandstone')
        if i % 3 == 0:
            plant(ctx, f'CAN_Desert_Scrub_{i:03d}', x + size * .7, z - size * .5, kind='grass', scale=rng.uniform(.45, .85))
    layout = {'id': 'REG_CANYON', 'villageCenter': [1368, 1657], 'humanScale': True,
              'buildingCount': building_count, 'closedExteriors': True, 'parcels': courtyard_records,
              'routes': routes, 'oasisGroves': [{'type': 'shore-following date-palm belt', 'waterContour': shore,
                'innerOffsetMeters': 3, 'depthRangeMeters': [20, 45], 'depthFormula': 'clamp(33+12*sin(4*a+0.5),20,45)'}],
              'irrigatedGroves': [{'center': [x, z], 'radii': [rx, rz]} for x, z, rx, rz in irrigated_groves],
              'ecologyRationale': 'Lush dense canopy follows water and irrigated courts; dry desert remains open beyond the living bank.',
              'canopySpacingMeters': 6.7, 'trees': palms,
              'referencesApplied': ['Willowmere complete botanical assemblies and human-scale architecture',
                                    'Fleur du Lac coherent bank vegetation, masonry edges and usable planted public spaces']}
    ctx.environment_layout = layout
    return {'biome': 'canyon', 'trees': palms, 'buildings': building_count,
            'landmark': [1830, 1550], 'water_level': 19, 'paths': [r['points'] for r in routes], 'layout': layout}
