"""Pure source-derived occupied hulls for custom rigid world landmarks.

These are planting reservations, not substitute geometry or walk colliders.
The natural arch keeps its usable high underpass open: only its two roots up
to twenty meters above local terrain reserve new vegetation.
"""
import ast
import math
from pathlib import Path


TAG = 'source-landmark-hull-v1'


def _ground():
    names = {'smooth', 'mix', 'rectmask', 'raw_ground', 'ground'}
    path = Path(__file__).with_name('scene_kit.py')
    tree = ast.parse(path.read_text(encoding='utf-8'))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    env = {'math': math}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(path), 'exec'), env)
    return env['ground']


def _hull(points):
    points = sorted(set(points))
    if len(points) < 3:
        return []
    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    lower, upper = [], []
    for p in points:
        while len(lower) > 1 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(points):
        while len(upper) > 1 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return [list(point) for point in lower[:-1] + upper[:-1]]


class _Occupied:
    def __init__(self):
        self.ground, self.points = _ground(), {}

    def _key(self, name):
        if name.startswith('Meadow_Windmill_'):
            return 'Meadow_Windmill_Assembly'
        if name.startswith('Meadow_ControlTower_'):
            return 'Meadow_ControlTower_Assembly'
        if name.startswith('Meadow_FuelTank'):
            return 'Meadow_FuelTank_Assembly_' + ''.join(c for c in name if c.isdigit())
        if name.startswith('Harbor_Lighthouse_'):
            return 'Harbor_Lighthouse_Assembly'
        if name.startswith('ALP_Tower_'):
            return 'ALP_StoneWatchtower'
        if name.startswith(('CAN_Mesa_', 'CAN_Spire_')) and '_Stratum_' in name:
            return name.split('_Stratum_')[0]
        return None

    def _record(self, name, points):
        key = self._key(name)
        if key:
            self.points.setdefault(key, []).extend(points)

    def _arch_root(self, polygon):
        """Clip each real face to the envelope occupied by new vegetation."""
        result = []
        for a, b in zip(polygon, polygon[1:] + polygon[:1]):
            ha = a[1] - self.ground(a[0], a[2]) - 20
            hb = b[1] - self.ground(b[0], b[2]) - 20
            if ha <= 0:
                result.append(a)
            if (ha <= 0) != (hb <= 0):
                t = ha / (ha - hb)
                result.append(tuple(a[i] + (b[i] - a[i]) * t for i in range(3)))
        if len(result) < 3:
            return
        side = 'North' if sum(p[2] for p in result) / len(result) >= 1550 else 'South'
        self.points.setdefault('CAN_NaturalArch_' + side + 'Root', []).extend((p[0], p[2]) for p in result)

    def mesh(self, name, vertices, faces, material):
        if name.startswith('CAN_NaturalArch_ErodedStratum_'):
            for face in faces:
                self._arch_root([vertices[i] for i in face])
        else:
            self._record(name, ((v[0], v[2]) for v in vertices))

    def box(self, name, x, y, z, w, h, d, material, yaw=0):
        c, s = math.cos(yaw), math.sin(yaw)
        self._record(name, ((x + u * c + v * s, z - u * s + v * c)
                           for u, v in ((-w/2, -d/2), (w/2, -d/2), (w/2, d/2), (-w/2, d/2))))

    def cyl(self, name, x, y, z, radius, height, material, vertices=12, top=None):
        r = max(radius, top or 0)
        self._record(name, ((x + math.cos(i * math.tau / vertices) * r,
                             z + math.sin(i * math.tau / vertices) * r) for i in range(vertices)))

    def beam(self, name, a, b, r, material):
        self._record(name, ((p[0] + math.cos(i * math.tau / 16) * r,
                             p[2] + math.sin(i * math.tau / 16) * r) for p in (a, b) for i in range(16)))

    def collection(self, *args, **kwargs): pass
    def material(self, *args, **kwargs): pass
    def path(self, *args, **kwargs): pass
    def tree(self, *args, **kwargs): pass
    def building(self, *args, **kwargs): pass
    def rock(self, *args, **kwargs): pass


def augment_landmark_reservations(exclusions, biome):
    """Update the supplied reservation dictionary using deterministic sources."""
    aliases = {'REG_MEADOW': 'verdant-airfield', 'REG_PORT': 'azure-port',
               'REG_ALPINE': 'alpine-lake', 'REG_CANYON': 'sunstone-oasis'}
    biome = aliases.get(biome, biome)
    if biome not in aliases.values():
        return exclusions
    from build_alpine_canyon import build_alpine, build_canyon
    from build_meadow_harbor import build_meadow, build_harbor
    builders = {'verdant-airfield': build_meadow, 'azure-port': build_harbor,
                'alpine-lake': build_alpine, 'sunstone-oasis': build_canyon}
    capture = _Occupied()
    builders[biome](capture)
    region = next(key for key, value in aliases.items() if value == biome)
    records = []
    for name, points in sorted(capture.points.items()):
        polygon = _hull(points)
        if not polygon:
            continue
        root = name.startswith('CAN_NaturalArch_')
        records.append({'id': region + '/' + name, 'polygon': polygon, 'reservationSource': TAG,
                        'source': 'Deterministic source geometry projected occupied hull',
                        'headroomMeters': 20 if root else None,
                        'scope': 'Arch root below planting headroom; central underpass retained' if root
                                 else 'Whole landmark projection including roof or rock overhang'})
    exclusions['structures'] = [record for record in exclusions.get('structures', [])
                               if record.get('reservationSource') != TAG] + records
    return exclusions
