"""Render reproducible semantic maps from the built Four Horizons specifications.

Uses registered building dimensions, the exported terrain grid, region graph,
and a geometry-free replay of the deterministic source placement functions.
No Blender process, desktop interaction, or external image generation is needed.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts" / "four-horizons"
SOURCE = Path(__file__).resolve().parent
REGION_COLORS = {"REG_MEADOW": "#B7CA9C", "REG_PORT": "#E6C7A6",
                 "REG_ALPINE": "#AFCBD5", "REG_CANYON": "#DCB17D"}
INK = "#253A40"
MUTED = "#63777A"
OCEAN = "#5B9EB4"
LAKE = "#268DA6"
ROAD = "#FFF3D5"
FOOTPRINT = "#76523E"
PLANNED = "#9B6AAB"
GROUND_COVER_COLORS = {"drifts": "#8CA86B", "shrubs": "#577C50", "rocks": "#999185", "stoneMargins": "#777267"}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def file_evidence(path):
    return {"path": path.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def regional_id(region, identity):
    return identity if identity.startswith(region + "/") else region + "/" + identity


def human_evidence(specs, plans):
    result = []
    for spec in specs:
        plan_hash = hashlib.sha256(json.dumps(plans[spec['id']], sort_keys=True).encode()).hexdigest()
        source = OUT / spec['id'] / 'human_landuse_validation.json'
        report_bytes = source.read_bytes() if source.exists() else None
        report = json.loads(report_bytes) if report_bytes is not None else {}
        matches = report.get('planSha256') == plan_hash
        generated = report.get('sourceApplied') is True and matches
        result.append({'region': spec['region'], 'biome': spec['id'],
            'status': 'GENERATED' if generated else 'PLANNED', 'currentPlanSha256': plan_hash,
            'sourceApplied': report.get('sourceApplied', False),
            'exportIntegrated': report.get('exportIntegrated', False), 'sourcePlanMatches': matches,
            'report': {'path': source.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(report_bytes).hexdigest()} if report_bytes is not None else None,
            'planSource': 'scripts/environments/regional_network_plan.py / PLAN',
            'clearanceAppliedToMap': False})
    return result


def add_human_landuse(specs, data, plans, connections):
    """Keep planned parcels distinct from observed registered wall footprints."""
    data['plannedBuildingParcels'] = []
    states = {item['region']: item for item in data['humanLanduseEvidence']}
    path_key = lambda item: (round(item['width'], 5), min(tuple(tuple(round(v, 5) for v in p) for p in item['points']),
                                                       tuple(tuple(round(v, 5) for v in p) for p in reversed(item['points']))))
    known_paths = {path_key(item) for item in data['paths']}
    known_ids = {item['id'] for item in data['paths']}
    actual_parcels = {item.get('parcelId') for item in data['buildingFootprints']}
    actual_buildings = {item['id'] for item in data['buildingFootprints']}
    for spec in specs:
        region = spec['region']; plan = plans[spec['id']]; state = states[region]
        metadata = {'region': region, 'evidenceStatus': state['status'], 'humanLanduse': True,
                    'evidencePath': state['report']['path'] if state['status'] == 'GENERATED' else state['planSource'],
                    'planSha256': state['currentPlanSha256']}
        state.update(addedRoutes=0, duplicateRoutesSkipped=0, addedFields=0, plannedParcels=0,
                     removedMappedTrees=0, removedMappedGroundCover=0)
        for route in plan['routes']:
            item = {**route, **metadata, 'id': regional_id(region, route['id'])}
            key = path_key(item)
            if item['id'] in known_ids or key in known_paths:
                state['duplicateRoutesSkipped'] += 1; continue
            data['paths'].append(item); known_ids.add(item['id']); known_paths.add(key); state['addedRoutes'] += 1
        field_ids = {item['id'] for item in data['cultivatedParcels']}
        for field in plan['fields']:
            item = {**field, **metadata, 'id': regional_id(region, field['id']),
                    'polygon': footprint(*field['center'], field['width'], field['depth'], field.get('yaw', 0))}
            if item['id'] not in field_ids:
                data['cultivatedParcels'].append(item); field_ids.add(item['id']); state['addedFields'] += 1
        for settlement in plan['settlements']:
            for parcel in settlement['buildings']:
                actual_id = regional_id(region, 'Settlement/' + parcel['id'])
                if parcel['id'] in actual_parcels or actual_id in actual_buildings: continue
                center = parcel.get('center', [parcel.get('x'), parcel.get('z')])
                data['plannedBuildingParcels'].append({**parcel, **metadata, 'id': regional_id(region, parcel['id']),
                    'evidenceStatus': 'PLANNED', 'center': center, 'settlement': settlement['id'],
                    'polygon': footprint(*center, parcel['w'], parcel['d'], parcel['yaw'])})
                state['plannedParcels'] += 1
        # The new plan alone never proves a removal from the saved source.
        if state['status'] == 'GENERATED':
            report = read(ROOT / state['report']['path'])
            cleared = report.get('clearance', {})
            tree_ids = {regional_id(region, identity) for identity in cleared.get('treeAssemblies', [])}
            object_ids = {regional_id(region, identity) for identity in cleared.get('objects', [])}
            before = len(data['planting'])
            data['planting'] = [item for item in data['planting'] if item['id'] not in tree_ids]
            state['removedMappedTrees'] = before - len(data['planting'])
            before = len(data['groundCover'])
            data['groundCover'] = [item for item in data['groundCover'] if item['id'] not in object_ids]
            state['removedMappedGroundCover'] = before - len(data['groundCover'])
            state['clearanceAppliedToMap'] = True
    by_biome = {item['biome']: item for item in states.values()}
    data['humanConnections'] = [{**item, 'evidenceStatus': 'GENERATED' if all(by_biome[biome]['status'] == 'GENERATED' for biome in item['regions']) else 'PLANNED'} for item in connections]


def font(size, bold=False):
    filename = "segoeuib.ttf" if bold else "segoeui.ttf"
    path = Path("C:/Windows/Fonts") / filename
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default(size=size)


def load_ground():
    """Compile only the pure terrain functions, never import Blender's scene module."""
    names = {"smooth", "mix", "rectmask", "raw_ground", "ground"}
    tree = ast.parse((SOURCE / "scene_kit.py").read_text(encoding="utf-8"))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in functions} == names
    env = {"math": math}
    exec(compile(ast.Module(body=functions, type_ignores=[]), "scene_kit_pure_terrain", "exec"), env)
    return env["ground"]


def module(name):
    spec = importlib.util.spec_from_file_location(name, SOURCE / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def footprint(x, z, width, depth, yaw=0):
    c, s = math.cos(yaw), math.sin(yaw)
    return [[x + u * c + v * s, z - u * s + v * c]
            for u, v in ((-width / 2, -depth / 2), (width / 2, -depth / 2),
                         (width / 2, depth / 2), (-width / 2, depth / 2))]


class Capture:
    """Record semantic placement calls; intentionally does not construct geometry."""
    def __init__(self, region, ground):
        self.region, self.ground = region, ground
        self.paths, self.planting, self.water, self.fields, self.structures = [], [], [], [], []

    def path(self, name, points, width, material, lift=.08):
        if name.startswith('Meadow_Field') and name.endswith('_Surface'):
            xs,zs=[p[0] for p in points],[p[1] for p in points]
            self.fields.append({'id':self.region+'/'+name,'polygon':[
                [min(xs)-width/2,min(zs)],[max(xs)+width/2,min(zs)],
                [max(xs)+width/2,max(zs)],[min(xs)-width/2,max(zs)]]})
            return
        excluded = ("Furrow", "KitchenGarden", "KitchenRow", "FrontGarden")
        if any(part in name for part in excluded):
            return
        self.paths.append({"id": self.region + "/" + name, "points": points,
                           "width": width, "material": material})

    def tree(self, name, x, z, height, style="oak"):
        self.planting.append({"id": self.region + "/" + name, "center": [x, z],
                              "height": height, "style": style})

    def mesh(self, name, vertices, faces, material):
        if material == "water" and "WaterSurface" in name:
            self.water.append({"id": self.region + "/" + name, "level": vertices[0][1],
                               "polygon": [[p[0], p[2]] for p in vertices[1:]],
                               "derivation": "Exact source water contour using pure scene_kit terrain functions"})
        if "Meadow_Field" in name and name.endswith("_Surface"):
            xs, zs = [p[0] for p in vertices], [p[2] for p in vertices]
            self.fields.append({"id": self.region + "/" + name,
                                "polygon": [[min(xs), min(zs)], [max(xs), min(zs)],
                                            [max(xs), max(zs)], [min(xs), max(zs)]]})

    def box(self, name, x, y, z, w, h, d, material, yaw=0):
        keep = (("Hangar" in name and name.endswith("_Slab")) or
                name in {"Meadow_ControlTower_Shaft", "Harbor_Quay_Coping",
                         "Harbor_Breakwater_Walk", "Harbor_ClockTower_Core"} or
                ("Dock" in name and (name.endswith("_MainDeck") or "_Finger" in name)))
        if keep:
            self.structures.append({"id": self.region + "/" + name,
                                    "polygon": footprint(x, z, w, d, yaw),
                                    "source": "Source structural call; not a generic building registry entry"})

    def cyl(self, name, x, y, z, radius, height, material, vertices=12, top=None):
        if name in {"Meadow_Windmill_Foundation", "Harbor_Lighthouse_Platform"}:
            self.structures.append({"id": self.region + "/" + name,
                                    "polygon": [[x + math.cos(i * math.tau / 32) * radius,
                                                 z + math.sin(i * math.tau / 32) * radius] for i in range(32)],
                                    "source": "Source structural call; circular platform footprint"})

    def beam(self, *args, **kwargs):
        pass

    def building(self, *args, **kwargs):
        pass  # Final per-region scene specifications own registered dimensions.

    def rock(self, *args, **kwargs):
        pass

    def material(self, *args, **kwargs):
        pass

    def collection(self, *args, **kwargs):
        pass


def capture_sources(specs):
    meadow = module("build_meadow_harbor")
    alpine = module("build_alpine_canyon")
    builders = {"verdant-airfield": meadow.build_meadow, "azure-port": meadow.build_harbor,
                "alpine-lake": alpine.build_alpine, "sunstone-oasis": alpine.build_canyon}
    ground = load_ground()
    captured = {}
    for item in specs:
        ctx = Capture(item["region"], ground)
        builders[item["id"]](ctx)
        captured[item["region"]] = ctx
    return captured


def add_open_landscape(specs, data):
    """Use generated placement evidence first; plans remain explicitly planned."""
    known_ids = {item["id"]: item for item in data["planting"]}
    position_key = lambda item: (*[round(float(value), 5) for value in item["center"]],
                                 round(float(item["height"]), 5), item["style"])
    known_positions = {position_key(item): item for item in data["planting"]}
    data["groundCover"], data["openLandscapeEvidence"] = [], []
    for spec in specs:
        directory = OUT / spec["id"]
        generated = directory / "open_landscape_validation.json"
        planned = directory / "open_landscape_placement_plan.json"
        human = next((item for item in data.get('humanLanduseEvidence', []) if item['region'] == spec['region']), None)
        stale_generated = generated.exists() and human is not None and human['status'] != 'GENERATED'
        source = generated if generated.exists() and not stale_generated else planned if planned.exists() else None
        evidence = {"region": spec["region"], "biome": spec["id"], "status": "UNAVAILABLE",
                    "addedTrees": 0, "groundCoverCounts": {}, "duplicateTreesSkipped": 0}
        data["openLandscapeEvidence"].append(evidence)
        if stale_generated:
            evidence['staleGeneratedReport'] = {**file_evidence(generated),
                'reason': 'The saved open-landscape report predates the current human plan; current source application is not proven.'}
        if source is None:
            continue
        raw = source.read_bytes()
        report = json.loads(raw)
        assert report["biome"] == spec["id"], source
        status = "GENERATED" if source == generated else "PLANNED"
        path = source.relative_to(ROOT).as_posix()
        evidence.update(status=status, path=path, sha256=hashlib.sha256(raw).hexdigest(),
                        placementAuditPasses=report.get("placementAudit", {}).get("passes"),
                        recordCounts={category: len(records) for category, records in report["placements"].items()})
        for index, tree in enumerate(report["placements"].get("trees", [])):
            identity = tree["id"] if tree["id"].startswith(spec["region"] + "/") else spec["region"] + "/" + tree["id"]
            item = {**tree, "id": identity, "region": spec["region"], "evidenceStatus": status,
                    "evidencePath": path, "sourceCategory": "trees", "sourceRecordIndex": index}
            key = position_key(item)
            assert math.isfinite(item["clearanceRadius"]) and item["clearanceRadius"] > 0
            if identity in known_ids or key in known_positions:
                existing = known_ids.get(identity, known_positions.get(key))
                existing.update({key: value for key, value in item.items() if key != "id"})
                existing["sourceRecordId"] = identity
                evidence["duplicateTreesSkipped"] += 1
                continue
            data["planting"].append(item)
            known_ids[identity] = item; known_positions[key] = item; evidence["addedTrees"] += 1
        for category in GROUND_COVER_COLORS:
            records = report["placements"].get(category, [])
            evidence["groundCoverCounts"][category] = len(records)
            for index, placement in enumerate(records):
                # Older placement reports do not carry Blender object names for
                # ground cover; these are stable semantic record IDs, not names.
                identity = placement.get("id", f"OPEN_{spec['id']}/SEM_{category}_{index:06d}")
                if not identity.startswith(spec["region"] + "/"): identity = spec["region"] + "/" + identity
                data["groundCover"].append({**placement, "id": identity, "region": spec["region"],
                    "idKind": "source-object" if "id" in placement else "semantic-record",
                    "category": category, "evidenceStatus": status, "evidencePath": path,
                    "sourceCategory": category, "sourceRecordIndex": index})


def clip_submerged(vertices, level):
    """Clip a height-grid triangle against its actual ocean elevation."""
    clipped = []
    for previous, current in zip(vertices[-1:] + vertices[:-1], vertices):
        prev_in, curr_in = previous[2] <= level, current[2] <= level
        if prev_in != curr_in:
            t = (level - previous[2]) / (current[2] - previous[2])
            clipped.append((previous[0] + t * (current[0] - previous[0]),
                            previous[1] + t * (current[1] - previous[1]), level))
        if curr_in:
            clipped.append(current)
    return [(p[0], p[1]) for p in clipped]


def ocean_polygons(grid, level):
    nx, nz, step = grid["columns"], grid["rows"], grid["cellSize"]
    heights, x0, z0 = grid["heights"], grid["minX"], grid["minZ"]
    polygons = []
    for iz in range(nz - 1):
        for ix in range(nx - 1):
            x, z = x0 + ix * step, z0 + iz * step
            a = (x, z, heights[iz * nx + ix])
            b = (x, z + step, heights[(iz + 1) * nx + ix])
            c = (x + step, z + step, heights[(iz + 1) * nx + ix + 1])
            d = (x + step, z, heights[iz * nx + ix + 1])
            if min(p[2] for p in (a, b, c, d)) > level:
                continue
            if max(p[2] for p in (a, b, c, d)) <= level:
                polygons.append([(p[0], p[1]) for p in (a, b, c, d)])
            else:
                for tri in ([a, d, b], [c, b, d]):
                    poly = clip_submerged(tri, level)
                    if len(poly) >= 3:
                        polygons.append(poly)
    return polygons


class Map:
    def __init__(self, bounds, title, subtitle, regions, single=False):
        self.bounds = bounds
        self.left, self.top, self.size = 64, 142, 1130
        self.scale = self.size / (bounds["maxX"] - bounds["minX"])
        self.image = Image.new("RGB", (1790, 1408), "#F8F8F3")
        self.draw = ImageDraw.Draw(self.image)
        self.regions = regions
        self.single = single
        self.draw.text((64, 35), title, font=font(33, True), fill=INK)
        self.draw.text((64, 89), subtitle, font=font(18), fill=MUTED)
        self.draw.rectangle((self.left, self.top, self.left + self.size, self.top + self.size),
                            fill="#E9EEE9", outline=INK, width=2)

    def point(self, point):
        x, z = point
        return (self.left + (x - self.bounds["minX"]) * self.scale,
                self.top + (self.bounds["maxZ"] - z) * self.scale)

    def polygon(self, points, fill, outline=None, width=1):
        clipped = [tuple(p) for p in points]
        bounds = self.bounds
        for axis, limit, sign in ((0, bounds["minX"], 1), (0, bounds["maxX"], -1),
                                   (1, bounds["minZ"], 1), (1, bounds["maxZ"], -1)):
            if not clipped:
                return
            result = []
            for previous, current in zip(clipped[-1:] + clipped[:-1], clipped):
                prev_in = (previous[axis] - limit) * sign >= 0
                curr_in = (current[axis] - limit) * sign >= 0
                if prev_in != curr_in:
                    t = (limit - previous[axis]) / (current[axis] - previous[axis])
                    result.append((previous[0] + t * (current[0] - previous[0]),
                                   previous[1] + t * (current[1] - previous[1])))
                if curr_in:
                    result.append(current)
            clipped = result
        if len(clipped) >= 3:
            self.draw.polygon([self.point(p) for p in clipped], fill=fill, outline=outline, width=width)

    def line(self, points, fill, width=1):
        self.draw.line([self.point(p) for p in points], fill=fill, width=width, joint="curve")

    def contains(self, x, z):
        b = self.bounds
        return b["minX"] <= x <= b["maxX"] and b["minZ"] <= z <= b["maxZ"]

    def disk(self, point, radius, fill, outline=None, width=1):
        x, y = self.point(point)
        self.draw.ellipse((x - radius, y - radius, x + radius, y + radius),
                          fill=fill, outline=outline, width=width)

    def label(self, position, text, size=15, fill=INK, center=False):
        xy = self.point(position)
        f = font(size, True)
        box = self.draw.textbbox(xy, text, font=f)
        if center:
            xy = (xy[0] - (box[2] - box[0]) / 2, xy[1])
            box = self.draw.textbbox(xy, text, font=f)
        self.draw.rectangle((box[0] - 4, box[1] - 3, box[2] + 4, box[3] + 4), fill="#F8F8F0")
        self.draw.text(xy, text, font=f, fill=fill)

    def grid(self):
        b = self.bounds
        step = 200 if self.single else 400
        for x in range(math.ceil(b["minX"] / step) * step, int(b["maxX"]) + 1, step):
            self.line([(x, b["minZ"]), (x, b["maxZ"])], "#C0CFC0", 1)
            px, _ = self.point((x, b["minZ"]))
            self.draw.text((px - 17, self.top + self.size + 9), str(x), font=font(13), fill=MUTED)
        for z in range(math.ceil(b["minZ"] / step) * step, int(b["maxZ"]) + 1, step):
            self.line([(b["minX"], z), (b["maxX"], z)], "#C0CFC0", 1)
            _, py = self.point((b["minX"], z))
            self.draw.text((13, py - 7), str(z), font=font(13), fill=MUTED)

    def finish(self, path, note):
        # Enforce the requested region crop. Features from adjacent regions cannot
        # spill into a cropped map's labels or technical legend.
        self.draw.rectangle((0, self.top - 1, self.left - 2, self.top + self.size + 1), fill="#F8F8F3")
        self.draw.rectangle((self.left + self.size + 2, self.top - 1, 1789, self.top + self.size + 1), fill="#F8F8F3")
        self.draw.rectangle((self.left - 1, 125, self.left + self.size + 1, self.top - 2), fill="#F8F8F3")
        self.draw.rectangle((self.left - 1, self.top + self.size + 2, self.left + self.size + 1, 1310), fill="#F8F8F3")
        self.draw.rectangle((self.left, self.top, self.left + self.size, self.top + self.size), outline=INK, width=2)
        b = self.bounds
        step = 200 if self.single else 400
        for x in range(math.ceil(b["minX"] / step) * step, int(b["maxX"]) + 1, step):
            px, _ = self.point((x, b["minZ"]))
            self.draw.text((px - 17, self.top + self.size + 9), str(x), font=font(13), fill=MUTED)
        for z in range(math.ceil(b["minZ"] / step) * step, int(b["maxZ"]) + 1, step):
            _, py = self.point((b["minX"], z))
            self.draw.text((13, py - 7), str(z), font=font(13), fill=MUTED)
        self.draw.text((64, 1328), "X east / Z north / Y elevation     |     Dimensions in meters", font=font(17), fill=INK)
        self.draw.text((64, 1361), note, font=font(15), fill=MUTED)
        # North and scale remain outside all top-down source geometry.
        lx, ly = 1260, 1160
        self.draw.line((lx, ly + 45, lx, ly - 15), fill=INK, width=3)
        self.draw.polygon([(lx, ly - 25), (lx - 8, ly - 10), (lx + 8, ly - 10)], fill=INK)
        self.draw.text((lx + 18, ly - 13), "+Z / NORTH", font=font(18, True), fill=INK)
        meters = 200 if self.single else 400
        width = meters * self.scale
        self.draw.line((1260, 1255, 1260 + width, 1255), fill=INK, width=5)
        self.draw.text((1260, 1270), f"{meters} m", font=font(17), fill=INK)
        path.parent.mkdir(parents=True, exist_ok=True)

    def save(self, path):
        self.image.save(path)


def draw_legend(canvas, specs, data, layers, title):
    d = canvas.draw
    x, y = 1260, 160
    d.text((x, y), "READING THE MAP", font=font(22, True), fill=INK)
    y += 48
    for spec in specs:
        d.rounded_rectangle((x, y + 3, x + 26, y + 29), radius=4, fill=REGION_COLORS[spec["region"]], outline=INK)
        d.text((x + 42, y), spec["region"], font=font(19, True), fill=INK)
        d.text((x + 42, y + 28), spec["label"], font=font(17), fill=MUTED)
        y += 60
    entries = []
    if "water" in layers:
        entries += [(OCEAN, "Ocean / submerged terrain", "Terrain-grid contour at Y = -5 m")]
        if any(s["region"] in {"REG_ALPINE", "REG_CANYON"} for s in specs):
            entries.append((LAKE, "Lake and oasis surfaces", "Source shoreline polygons; Y = 38 / 19 m"))
    if "roads" in layers:
        entries.append(("#B19A69", "Roads, access and plazas", "Exact path positions and full widths"))
    if "fields" in layers:
        entries.append(("#D0CD9B", "Cultivated parcels", "Crop areas; purple boundary means PLANNED"))
    if "footprints" in layers:
        entries.append((FOOTPRINT, "Registered building footprints", "Declared dimensions and actual rotation"))
        if any(item['region'] in {spec['region'] for spec in specs} for item in data.get('plannedBuildingParcels', [])):
            entries.append((PLANNED, "Planned settlement parcels", "Outline only; distinct from saved buildings"))
    if "planting" in layers:
        entries.append(("#416C43", "Trees and planting", "Base: centers / infill: actual clearance radii"))
    if "ground_cover" in layers:
        entries.append(("#8CA86B", "Low ground cover", "Drifts, shrubs, rocks and stone margins"))
    if "clearance" in layers and any(s["region"] == "REG_MEADOW" for s in specs):
        entries.append(("#CA5680", "Protected flight corridor", "X -65 to 260; Z -390 to 400 m"))
    if "graph" in layers:
        verified = data.get('builtNetworkAudit', {}).get('passes', False)
        entries.append(("#526991", "Regional road connections", "Exported surfaces verified" if verified else "Authored connection locations"))
    for color, label, description in entries:
        d.rectangle((x, y + 4, x + 22, y + 20), fill=color)
        d.text((x + 36, y - 1), label, font=font(17, True), fill=INK)
        d.text((x + 36, y + 25), description, font=font(14), fill=MUTED)
        y += 42
    y += 7
    d.line((x, y, 1710, y), fill="#C6D1CC", width=1)
    y += 20
    count = sum(len(s["buildings"]) for s in specs)
    d.text((x, y), f"{count} registered building assemblies", font=font(18, True), fill=INK)
    if len(specs) == 1:
        d.text((x, y + 31), specs[0]["landmark"], font=font(16), fill=MUTED)
    else:
        d.text((x, y + 31), "4 connected regions / 3.2 km square", font=font(16), fill=MUTED)
    if layers & {"planting", "ground_cover", "roads", "fields", "footprints"}:
        y += 66
        d.text((x, y), "PLACEMENT EVIDENCE", font=font(16, True), fill=INK)
        selected = {spec["region"] for spec in specs}
        for evidence in data["openLandscapeEvidence"]:
            if evidence["region"] not in selected: continue
            y += 25
            human = next(item for item in data['humanLanduseEvidence'] if item['region'] == evidence['region'])
            d.text((x, y), f"{evidence['region']}: infill {evidence['status']} / land use {human['status']}", font=font(12, True),
                   fill=PLANNED if 'PLANNED' in (evidence['status'], human['status']) else "#416C43")
        y += 27
        d.text((x, y), "Purple outlines = PLANNED placement", font=font(14), fill=PLANNED)
        d.text((x, y + 22), "Evidence paths + hashes: semantic_layout_data.json", font=font(13), fill=MUTED)


def render(path, bounds, specs, data, ocean, layers, title, single=False):
    selected_evidence = [item for item in data["openLandscapeEvidence"] if item["region"] in {spec["region"] for spec in specs}]
    planned = any(item["status"] == "PLANNED" for item in selected_evidence + [item for item in data['humanLanduseEvidence'] if item['region'] in {spec['region'] for spec in specs}])
    subtitle = "Technical top-down source map" + (" / PLANNED human land use and planting are explicitly outlined" if planned else " / registered and generated placement evidence")
    canvas = Map(bounds, title, subtitle, specs, single)
    for spec in specs:
        b = spec["bounds"]
        canvas.polygon([(b["minX"], b["minZ"]), (b["maxX"], b["minZ"]),
                        (b["maxX"], b["maxZ"]), (b["minX"], b["maxZ"])], REGION_COLORS[spec["region"]])
    canvas.grid()
    selected = {s["region"] for s in specs}
    if "water" in layers:
        for poly in ocean:
            canvas.polygon(poly, OCEAN)
        for water in data["waterSurfaces"]:
            if water["id"].split("/")[0] in selected:
                canvas.polygon(water["polygon"], LAKE, "#1B6B80")
    if "fields" in layers:
        for field in data["cultivatedParcels"]:
            if field["id"].split("/")[0] in selected:
                canvas.polygon(field["polygon"], "#D0CD9B", PLANNED if field.get('evidenceStatus') == 'PLANNED' else "#8B9C65", 2)
                if single and field.get('crop'):
                    canvas.label(field['center'], field['crop'].upper(), 11, '#5B603B')
    if "ground_cover" in layers:
        for item in data["groundCover"]:
            if item["region"] in selected:
                color = GROUND_COVER_COLORS[item["category"]]
                radius = max(.65, item.get("clearanceRadius", item.get("radius", .5)) * canvas.scale)
                outline = PLANNED if item["evidenceStatus"] == "PLANNED" else color
                canvas.disk(item["center"], radius, color, outline)
    if "planting" in layers:
        for tree in data["planting"]:
            if tree["id"].split("/")[0] in selected:
                radius = tree["clearanceRadius"] * canvas.scale if "clearanceRadius" in tree else 1.7 if tree["height"] < 5 else 2.4
                outline = PLANNED if tree.get("evidenceStatus") == "PLANNED" else "#416C43" if "clearanceRadius" in tree else None
                canvas.disk(tree["center"], max(.65, radius), "#7C9C65" if "clearanceRadius" in tree else "#5C804D", outline)
    if "roads" in layers:
        for road in data["paths"]:
            if road["id"].split("/")[0] in selected:
                width = max(1, round(road["width"] * canvas.scale))
                canvas.line(road["points"], PLANNED if road.get('evidenceStatus') == 'PLANNED' else "#A49165", width + 2)
                canvas.line(road["points"], ROAD, width)
        for connection in data.get('humanConnections', []):
            if canvas.contains(*connection['position']):
                color = PLANNED if connection['evidenceStatus'] == 'PLANNED' else '#526991'
                canvas.disk(connection['position'], 6, '#F8F8F3', color, 2)
    if "footprints" in layers:
        for item in data.get('plannedBuildingParcels', []):
            if item['region'] in selected:
                canvas.polygon(item['polygon'], None, PLANNED, 2)
        for item in data["buildingFootprints"]:
            if item["region"] in selected:
                canvas.polygon(item["polygon"], FOOTPRINT, "#493827")
                if single:
                    x, z = item["center"]
                    direction = (math.sin(item["yaw"]), math.cos(item["yaw"]))
                    length = item["dimensions"][2] / 2 + 3.0
                    p = [x + direction[0] * length, z + direction[1] * length]
                    canvas.line([(x, z), p], "#FFF5D9", 1)
        for item in data["sourceStructures"]:
            if item["id"].split("/")[0] in selected:
                canvas.polygon(item["polygon"], "#8B857B", "#534F46")
    if "clearance" in layers and "REG_MEADOW" in selected:
        runway = data["runway"]
        x0, x1, z0, z1 = runway["bounds"]
        canvas.polygon([(x0, z0), (x1, z0), (x1, z1), (x0, z1)], "#4C5556", "#F9EDD0")
        x0, x1 = runway["flightClearance"]["x"]
        z0, z1 = runway["flightClearance"]["z"]
        canvas.polygon([(x0, z0), (x1, z0), (x1, z1), (x0, z1)], None, "#BD416D", 3)
        # Dash pattern marks a reservation boundary without hiding source objects.
        for z in range(z0, z1, 44):
            canvas.line([(x0, z), (x0 + 16, min(z + 16, z1))], "#BD416D", 2)
        canvas.label((x1 + 17, z1), "FLIGHT CLEARANCE", 14, "#962D55")
    for spec in specs:
        b = spec["bounds"]
        canvas.polygon([(b["minX"], b["minZ"]), (b["maxX"], b["minZ"]),
                        (b["maxX"], b["maxZ"]), (b["minX"], b["maxZ"])], None, "#50676A", 2)
        canvas.label((b["minX"] + 43, b["maxZ"] - 45), spec["region"], 18 if single else 16)
    if "graph" in layers:
        for connection in data["connections"]:
            position = connection["position"]
            x, z = (position[0], position[2]) if len(position) == 3 else position
            if canvas.contains(x, z):
                canvas.disk((x, z), 8, "#F8F8F3", "#526991", 3)
                label_x = max(bounds["minX"] + 18, min(bounds["maxX"] - 110, x + 23))
                label_z = max(bounds["minZ"] + 45, min(bounds["maxZ"] - 28, z + 24))
                canvas.label((label_x, label_z), connection["id"], 13, "#405A81")
    if "heroes" in layers:
        for hero in data["landmarks"]:
            if hero["region"] in selected:
                canvas.disk(hero["position"], 5, "#F8EECC", "#624D30", 2)
                x, z = hero["position"]
                canvas.label((x + 23, z + 28), hero["label"], 13)
    note = "Source/planned semantic evidence; no collision or runtime traversal claim. Evidence paths + hashes: semantic_layout_data.json"
    if single and selected_evidence and selected_evidence[0].get("path"):
        note = f"{selected_evidence[0]['status']} open-landscape evidence: {selected_evidence[0]['path']}"
    canvas.finish(path, note)
    draw_legend(canvas, specs, data, layers, title)
    canvas.save(path)


def main():
    master_path = OUT / "scene_spec.json"
    master = read(master_path)
    specs = [read(OUT / region["id"] / "scene_spec.json") for region in master["biomes"]]
    registry_inputs = []
    for spec in specs:
        registry_path = OUT / spec['id'] / 'asset_registry.json'
        if registry_path.exists():
            registry_bytes = registry_path.read_bytes()
            spec['buildings'] = json.loads(registry_bytes)['buildings']
            spec['buildingEvidence'] = {'path': registry_path.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(registry_bytes).hexdigest()}
            registry_inputs.append(registry_path)
    graph = read(OUT / "region_graph.json")
    assert {r["region"] for r in specs} == {r["id"] for r in graph["regions"]}
    for spec in specs:
        matched = next(r for r in graph["regions"] if r["id"] == spec["region"])
        assert spec["bounds"] == matched["bounds"], spec["id"]
    captured = capture_sources(specs)
    terrain_path = ROOT / "public" / master["terrain"]["url"].lstrip("/")
    grid = read(terrain_path)
    data = {"units": "meters", "axes": {"horizontal": "X east / Z north", "vertical": "Y up"},
            "bounds": master["bounds"], "regions": graph["regions"], "connections": graph["connections"],
            "runway": master["runway"], "buildingFootprints": [], "paths": [], "planting": [],
            "waterSurfaces": [], "cultivatedParcels": [], "sourceStructures": [],
            "ocean": {"level": master["waterLevel"], "source": str(terrain_path.relative_to(ROOT)),
                      "method": "Clip exported 10 m a-d-b terrain triangles at water elevation"},
            "landmarks": []}
    for spec in specs:
        for building in spec["buildings"]:
            x, z = building["center"]
            width, height, depth = building["dimensions"]
            data["buildingFootprints"].append({**building, "region": spec["region"],
                                               'evidenceStatus': 'REGISTERED', 'evidencePath': spec.get('buildingEvidence', {}).get('path'),
                                               "polygon": footprint(x, z, width, depth, building["yaw"])})
        ctx = captured[spec["region"]]
        for source_key, target_key in (("paths", "paths"), ("planting", "planting"),
                                       ("water", "waterSurfaces"), ("fields", "cultivatedParcels"),
                                       ("structures", "sourceStructures")):
            data[target_key].extend(getattr(ctx, source_key))
        layout = spec["layout"]
        if "hero" in layout:
            p = layout["hero"]["position"]
            position = [p[0], p[2]]
        else:
            position = layout["landmark"]
        label = {"REG_MEADOW": "WINDMILL", "REG_PORT": "LIGHTHOUSE",
                 "REG_ALPINE": "WATCHTOWER", "REG_CANYON": "STONE ARCH"}[spec["region"]]
        data["landmarks"].append({"region": spec["region"], "label": label, "position": position})
    network = module('regional_network_plan')
    data['humanLanduseEvidence'] = human_evidence(specs, network.PLAN)
    add_open_landscape(specs, data)
    add_human_landuse(specs, data, network.PLAN, network.CONNECTIONS)
    from audit_landscape_boundaries import build_boundary_report
    data["boundaryAudit"] = build_boundary_report()
    built_audit_path = OUT / 'built_network_validation.json'
    if built_audit_path.exists():
        built = read(built_audit_path)
        exports = [e for region in built['regions'].values() for e in region['evidence'] if e['path'].endswith('.glb')]
        current_exports = all((ROOT / e['path']).stat().st_size == e['bytes'] and
                              (ROOT / e['path']).stat().st_mtime_ns == e['modifiedNanoseconds'] for e in exports)
        data['builtNetworkAudit'] = {
            **file_evidence(built_audit_path),
            'evidenceStatus': built['evidenceStatus'] if current_exports else 'STALE',
            'passes': built['passes'] and current_exports,
            'totals': built['totals'], 'sourceExports': exports,
            'regionalConnections': [{key: connection[key] for key in
                ('id', 'maximumOpenSeamMeters', 'maximumCrossSectionHeightDifferenceMeters')}
                for connection in built['regionalConnections']],
            'method': 'Actual exported GLB mesh identities, source counts, route coverage and regional seam geometry.'}
    inputs = [master_path, OUT / "region_graph.json", terrain_path,
              SOURCE / "scene_kit.py", SOURCE / "build_meadow_harbor.py", SOURCE / "build_alpine_canyon.py",
              SOURCE / "open_landscape.py", SOURCE / "draw_layout.py",
              SOURCE / "audit_landscape_boundaries.py", OUT / "landscape_boundary_audit.json",
              SOURCE / 'regional_network_plan.py', SOURCE / 'regional_network_helpers.py',
              SOURCE / 'regional_network_canyon.py']
    inputs += [OUT / spec["id"] / "scene_spec.json" for spec in specs]
    data["provenance"] = [{"path": str(p.relative_to(ROOT)).replace("\\", "/"),
                            "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in inputs]
    data['provenance'] += [spec['buildingEvidence'] for spec in specs if 'buildingEvidence' in spec]
    data["provenance"] += [{"path": item["path"], "sha256": item["sha256"], "evidenceStatus": item["status"]}
                           for item in data["openLandscapeEvidence"] if "path" in item]
    data['provenance'] += [item['report'] for item in data['humanLanduseEvidence'] if item['report']]
    if 'builtNetworkAudit' in data:
        data['provenance'].append(file_evidence(built_audit_path))
    data["limitations"] = [
        "Generic building polygons show declared wall footprints; roof/balcony projections are not claimed.",
        "Building footprints use actual asset_registry dimensions, positions and yaw. Planned human parcels remain a separate outline layer until a corresponding saved building is registered.",
        "Human roads and fields are GENERATED only when sourceApplied is true and planSha256 matches the current shared PLAN. Otherwise their overlays are PLANNED; exportIntegrated is reported separately.",
        "Obsolete pre-human generated infill is excluded in favor of current explicit placement plans. Base tree removals require a matching applied human clearance report.",
        "Additional hangars, quay, docks, platforms and tower bodies use selected source calls.",
        "Base planting uses source centers; infill trees use the placement report's clearanceRadius, not a measured mesh silhouette.",
        "Open-landscape validation reports take precedence; placement-plan fallbacks are explicitly PLANNED, not proof of generated geometry.",
        "Low ground cover includes recorded infill drifts, shrubs, rocks and stone margins; it does not enumerate every pre-existing garden botanical.",
        "Ground-cover records without source object IDs receive stable semantic IDs; evidencePath and sourceRecordIndex identify the actual record.",
        "Road overlays retain exact source centerlines and widths; they do not prove collision or human traversal.",
        "Ocean contour uses exported float32 terrain heights; lake/oasis polygons replay the exact source contour routine.",
        "Region connection markers reproduce region_graph.json; builtNetworkAudit records coverage and height checks on the actual exported road surfaces.",
    ]
    (OUT / "semantic_layout_data.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    ocean = ocean_polygons(grid, master["waterLevel"])
    all_layers = {"water", "fields", "planting", "ground_cover", "roads", "footprints", "clearance", "graph", "heroes"}
    render(OUT / "semantic_layout.png", master["bounds"], specs, data, ocean, all_layers,
           "FOUR HORIZONS / SEMANTIC LAYOUT")
    overlays = {"roads": {"roads", "water", "graph"},
                "human_landuse": {"roads", "fields", "footprints", "water"},
                "footprints": {"footprints", "roads"},
                "water": {"water"},
                "flight_clearance": {"clearance", "footprints", "graph"},
                "planting": {"planting", "fields", "roads"},
                "ground_cover": {"ground_cover", "water", "roads"}}
    for name, layers in overlays.items():
        render(OUT / f"{name}_overlay.png", master["bounds"], specs, data, ocean, layers,
               "FOUR HORIZONS / " + name.replace("_", " ").upper())
    for spec in specs:
        render(OUT / spec["id"] / "semantic_layout.png", spec["bounds"], [spec], data,
               ocean, all_layers, spec["label"].upper() + " / SEMANTIC LAYOUT", single=True)
        for name in ("planting", "ground_cover", "human_landuse"):
            render(OUT / spec["id"] / f"{name}_overlay.png", spec["bounds"], [spec], data,
                   ocean, overlays[name], spec["label"].upper() + " / " + name.replace("_", " ").upper(), single=True)
    report = {"regionIds": [s["region"] for s in specs], "registeredBuildingFootprints": len(data["buildingFootprints"]),
              "sourcePaths": len(data["paths"]), "plantingPositions": len(data["planting"]),
              "waterSurfacePolygons": len(data["waterSurfaces"]), "oceanClippedPolygons": len(ocean),
              "sourceStructureFootprints": len(data["sourceStructures"]), "cultivatedParcels": len(data["cultivatedParcels"]),
              "groundCoverPositions": len(data["groundCover"]), "openLandscapeEvidence": data["openLandscapeEvidence"],
              'humanLanduseEvidence': data['humanLanduseEvidence'], 'plannedBuildingParcels': len(data['plannedBuildingParcels']),
              'builtNetworkAudit': data.get('builtNetworkAudit'),
              "boundaryAudit": {"path": "artifacts/four-horizons/landscape_boundary_audit.json",
                                "passes": data["boundaryAudit"]["passes"],
                                "generatedBiomes": data["boundaryAudit"]["generatedBiomes"],
                                "plannedBiomes": data["boundaryAudit"]["plannedBiomes"]},
              "outputImages": 1+len(overlays)+len(specs)*4,
              "checks": {"regionBoundsMatchGraph": True, "stableRegionIdsMatchGraph": True,
                         "uniquePlantingIds": len({item['id'] for item in data['planting']}) == len(data['planting']),
                         'uniquePathIds': len({item['id'] for item in data['paths']}) == len(data['paths']),
                         'plannedParcelsSeparateFromRegistered': not ({item['id'] for item in data['plannedBuildingParcels']} & {item['id'] for item in data['buildingFootprints']}),
                         "allLandscapeIdsRegionQualified": all(item['id'].split('/')[0] in REGION_COLORS for item in data['groundCover'])},
              "limitations": data["limitations"], "provenance": data["provenance"]}
    (OUT / "semantic_layout_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in {"limitations", "provenance"}}, indent=2))


if __name__ == "__main__":
    main()
