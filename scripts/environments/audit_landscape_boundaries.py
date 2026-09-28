"""Independent semantic occupied-volume checks for the four landscape sources.

Generated placement reports take precedence over plans. This is a placement
envelope audit, not an assertion that source triangles or final renders pass.
No Blender, image library, or numeric dependency is imported.
"""
from __future__ import annotations

import ast
import hashlib
import json
import math
import statistics
from pathlib import Path

from open_landscape import ALIASES, REGIONS, REGIONAL_INTENTS, Reservations

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/four-horizons'
BOUNDARIES = [
    ('meadow-port', 'verdant-airfield', 'azure-port', 'x', -800, 800),
    ('meadow-alpine', 'verdant-airfield', 'alpine-lake', 'z', -800, 800),
    ('port-canyon', 'azure-port', 'sunstone-oasis', 'z', 800, 2400),
    ('alpine-canyon', 'alpine-lake', 'sunstone-oasis', 'x', 800, 2400),
]


def _ground():
    names = {'smooth', 'mix', 'rectmask', 'raw_ground', 'ground'}
    source = ast.parse((ROOT / 'scripts/environments/scene_kit.py').read_text(encoding='utf-8'))
    functions = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
    environment = {'math': math}
    exec(compile(ast.Module(body=functions, type_ignores=[]), 'boundary_terrain', 'exec'), environment)
    return environment['ground']


def _read(path):
    raw = path.read_bytes()
    return json.loads(raw), {'path': path.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(raw).hexdigest()}


def _grid(records, cell=32):
    bins = {}
    for item in records:
        x, z = item['center']
        bins.setdefault((math.floor(x / cell), math.floor(z / cell)), []).append(item)
    return bins


def _nearby(bins, x, z, radius=32, cell=32):
    ix, iz = math.floor(x / cell), math.floor(z / cell)
    span = math.ceil(radius / cell)
    for i in range(ix - span, ix + span + 1):
        for j in range(iz - span, iz + span + 1):
            yield from bins.get((i, j), ())


def _canopy(item):
    return item.get('clearanceRadius', item['height'] * {'oak': .56, 'pine': .34, 'palm': .47, 'cypress': .16}.get(item.get('style'), .56))


def _longest_run(samples):
    current = longest = 0
    for value in samples:
        current = current + 20 if value else 0
        longest = max(longest, current)
    return longest


def build_boundary_report():
    """Return and write the current planned/generated boundary placement audit."""
    ground = _ground()
    evidence, reports, originals = {}, {}, {}
    human_plan_path=OUT/'regional_network_plan.json'
    human_plans=json.loads(human_plan_path.read_text()) if human_plan_path.exists() else {}
    merged = {key: [] for key in ('buildings', 'paths', 'fields', 'structures', 'water', 'trees')}
    trees, placements = [], []
    for biome in REGIONS:
        directory = OUT / biome
        reservations, reservation_evidence = _read(directory / 'landscape_reservations.json')
        originals[biome] = reservations
        for key in merged: merged[key].extend(reservations.get(key, []))
        for item in reservations.get('trees', []):
            trees.append({**item, 'owner': biome, 'source': 'BASE_SOURCE', 'id': item['id']})
        generated = directory / 'open_landscape_validation.json'
        planned = directory / 'open_landscape_placement_plan.json'
        human_validation=directory/'human_landuse_validation.json'
        human=json.loads(human_validation.read_text()) if human_validation.exists() else {}
        expected_human_hash=hashlib.sha256(json.dumps(human_plans[biome],sort_keys=True).encode()).hexdigest() if biome in human_plans else None
        human_current=not expected_human_hash or (human.get('sourceApplied') is True and human.get('planSha256')==expected_human_hash)
        generated_current=generated.exists() and human_current
        source = generated if generated_current else planned if planned.exists() else None
        evidence[biome] = {'status': 'UNAVAILABLE', 'reservations': reservation_evidence}
        if expected_human_hash:
            evidence[biome]['humanLayer']={'sourceApplied':human.get('sourceApplied',False),
                'expectedPlanSha256':expected_human_hash,'generatedPlanSha256':human.get('planSha256'),
                'sourceCurrent':human_current,'exportIntegrated':human.get('exportIntegrated',False)}
        if generated.exists() and not generated_current:
            _, stale_evidence=_read(generated)
            evidence[biome]['staleGeneratedPlacements']={**stale_evidence,
                'reason':'Placement source predates the current human land-use layer or its source commit; the current reserved placement plan is audited instead.'}
        if source is None: continue
        report, source_evidence = _read(source)
        reports[biome] = report
        status = 'GENERATED' if source == generated else 'PLANNED'
        evidence[biome].update(status=status, placements=source_evidence, counts=report['counts'])
        if generated_current and planned.exists():
            plan, plan_evidence = _read(planned)
            evidence[biome]['generatedMatchesPlan'] = {
                'plan': plan_evidence, 'countsExactlyEqual': report['counts'] == plan['counts'],
                'everyPlacementExactlyEqual': report['placements'] == plan['placements'],
                'regionalIntentEqual': report.get('regionalIntent') == plan.get('regionalIntent'),
                'ownershipEqual': report.get('ownership') == plan.get('ownership')}
        for category, records in report['placements'].items():
            for index, item in enumerate(records):
                entry = {**item, 'owner': biome, 'source': status, 'category': category,
                         'id': item.get('id', f'OPEN_{biome}/SEM_{category}_{index:06d}')}
                placements.append(entry)
                if category == 'trees': trees.append(entry)
    tree_grid = _grid(trees)
    maximum_canopy = max((_canopy(item) for item in trees), default=0)
    clearance_violations, reservations_violations, ownership_violations = [], [], []
    cross_pairs, canopy_pairs = set(), set()
    closest = None
    for item in trees:
        x, z = item['center']
        for other in _nearby(tree_grid, x, z, maximum_canopy * 2):
            if other['owner'] == item['owner']: continue
            key = tuple(sorted((item['id'], other['id'])))
            if key in cross_pairs: continue
            cross_pairs.add(key)
            distance = math.dist(item['center'], other['center'])
            if closest is None or distance < closest['distanceMeters']:
                closest = {'ids': list(key), 'distanceMeters': distance}
            if distance < _canopy(item) + _canopy(other): canopy_pairs.add(key)
            if item['source'] == 'BASE_SOURCE' and other['source'] == 'BASE_SOURCE': continue
            # Existing planting is respected by each proposal's same center
            # spacing constraint. Crown intersections are deliberately allowed.
            required = max(item.get('minimumTrunkSpacing', 0), other.get('minimumTrunkSpacing', 0))
            if required and distance + 1e-7 < required:
                clearance_violations.append({'ids': list(key), 'centers': [item['center'], other['center']],
                    'distanceMeters': distance, 'requiredMeters': required})
    rigid_props = [item for item in placements if item['category'] in ('rocks', 'stoneMargins')]
    prop_grid = _grid(rigid_props)
    rigid_prop_candidates = []
    maximum_prop = max((item['radius'] for item in rigid_props), default=0)
    for item in rigid_props:
        for other in _nearby(prop_grid, *item['center'], maximum_prop * 2):
            if item['owner'] >= other['owner']: continue
            distance = math.dist(item['center'], other['center'])
            if distance < item['radius'] + other['radius']:
                rigid_prop_candidates.append({'ids': [item['id'], other['id']],
                    'centers': [item['center'], other['center']], 'distanceMeters': distance,
                    'summedEnvelopeRadiiMeters': item['radius'] + other['radius']})
    placement_checks = {}
    for biome in REGIONS:
        reservations = Reservations(merged, biome)
        x0, x1, z0, z1 = REGIONS[biome]
        owned = [item for item in placements if item['owner'] == biome]
        for item in owned:
            x, z = item['center']
            radius = item.get('clearanceRadius', item.get('radius', .5))
            if not x0 <= x < x1 or not z0 <= z < z1:
                ownership_violations.append({'id': item['id'], 'owner': biome, 'center': item['center']})
            blocked = reservations.blocked(x, z, radius)
            if blocked:
                reservations_violations.append({'id': item['id'], 'owner': biome, 'category': item['category'],
                    'center': item['center'], 'radiusMeters': radius, 'reservationKind': blocked})
        placement_checks[biome] = {'checkedPlacements': len(owned), 'allNeighborReservationsIncluded': True}
    boundary_records = []
    for name, first, second, axis, start, end in BOUNDARIES:
        coordinate = 0 if axis == 'x' else 1
        pair_trees = [item for item in trees if item['owner'] in (first, second)]
        crossing = [item for item in pair_trees if abs(item['center'][coordinate] - 800) < _canopy(item)]
        crossing_generated = [item for item in crossing if item['source'] != 'BASE_SOURCE']
        samples, distances, open_runs, underwater = [], [], [], 0
        for along in range(start + 10, end, 20):
            x, z = (800, along) if axis == 'x' else (along, 800)
            height = ground(x, z)
            nearest = min((math.dist([x, z], item['center']) for item in _nearby(tree_grid, x, z, 160)), default=None)
            protected = any(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 < 1
                for owner in (first, second) for cx, cz, rx, rz in REGIONAL_INTENTS[owner]['protectedOpenings'])
            exposed = height > (125 if 'alpine-lake' in (first, second) else 58 if 'sunstone-oasis' in (first, second) else 1000)
            dry_wash = 'sunstone-oasis' in (first, second)
            underwater += height <= -4.6
            if height > -4.6 and nearest is not None: distances.append(nearest)
            # Diagnostic only: open boundary strips may be deliberate water,
            # high meadow or desert. Do not turn natural sparse land into trees.
            unexplained_open = height > -4.6 and not protected and not exposed and not dry_wash and (nearest is None or nearest > 35)
            open_runs.append(unexplained_open)
            samples.append({'position': [x, z], 'groundMeters': height, 'nearestTrunkMeters': nearest,
                'protectedOpening': protected, 'exposedHighGround': exposed,
                'dryWadiOrDesertComposition': dry_wash, 'openLandDiagnostic': unexplained_open})
        boundary_records.append({'id': name, 'regions': [first, second], 'axis': axis, 'coordinate': 800,
            'canopiesCrossingOwnershipLine': len(crossing), 'addedCanopiesCrossingOwnershipLine': len(crossing_generated),
            'crossingExamples': [item['id'] for item in crossing_generated[:12]],
            'landSamples': len(samples) - underwater, 'waterSamples': underwater,
            'medianNearestTrunkMetersOnLand': statistics.median(distances) if distances else None,
            'longestUnreservedLowlandOpeningMeters': _longest_run(open_runs),
            'samples': samples})
    graph, graph_evidence = _read(OUT / 'region_graph.json')
    module_hash = hashlib.sha256((ROOT / 'scripts/environments/open_landscape.py').read_bytes()).hexdigest()
    report = {'schemaVersion': 1, 'evidence': evidence, 'generationModuleSha256AtAudit': module_hash,
        'scope': 'Semantic occupied-envelope checks over exact generated placement reports when present, otherwise explicit plans. Source mesh intersections and visual seams require the separate source/runtime review.',
        'plannedBiomes': [key for key, value in evidence.items() if value['status'] == 'PLANNED'],
        'generatedBiomes': [key for key, value in evidence.items() if value['status'] == 'GENERATED'],
        'checks': placement_checks,
        'crossCellRigidTrunkClearanceViolations': clearance_violations,
        'crossCellRigidPropEnvelopeCandidates': rigid_prop_candidates,
        'rigidPropCheck': 'All added rocks and stone margins are checked across owners using complete horizontal source envelopes. Any candidate requires a source-triangle check before being called a penetration.',
        'crossCellCanopyOverlapsAllowed': len(canopy_pairs), 'closestCrossCellTrees': closest,
        'reservedOccupiedEnvelopeViolations': reservations_violations,
        'centerOwnershipViolations': ownership_violations, 'boundaries': boundary_records,
        'terrainContinuityContract': {'source': 'Shared world ground function and 10 m terrain lattice; source cell vertices include identical edge coordinates.',
            'infillTerrainPlanes': 0, 'mottleCoordinates': 'Shared world-space analytic field; independent of region and local scatter acceptance.',
            'renderedSeamVerification': 'Deferred to source/runtime images; this audit does not claim rendered color continuity.'},
        'connections': graph['connections'], 'connectionEvidence': graph_evidence,
        'passes': not clearance_violations and not reservations_violations and not ownership_violations and not rigid_prop_candidates}
    (OUT / 'landscape_boundary_audit.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


if __name__ == '__main__':
    result = build_boundary_report()
    print(json.dumps({key: result[key] for key in ('passes', 'plannedBiomes', 'generatedBiomes',
        'crossCellRigidTrunkClearanceViolations', 'reservedOccupiedEnvelopeViolations', 'centerOwnershipViolations',
        'crossCellCanopyOverlapsAllowed', 'closestCrossCellTrees')}, indent=2))
