"""Articulated botanical kit adapted to the user's Willowmere / Fleur du Lac craft.

The models use actual branches, folded/lobed leaves, needle sprays, petals and
curved blades. There are no opaque crown hulls, billboard cards, decimated LODs
or shadow substitutes. Mesh data is shared between all full-detail instances.

Public placement coordinates are world X/Y/Z with Y up, matching Context.
Internal prototype coordinates use Blender Z up, as in the reference builders.
"""

import hashlib
import json
import math
from pathlib import Path
import random


TAU = math.tau
REFERENCE_METHODS = [
    "E:/Dev/forest-lake-test-with-skill-test/artifacts/givros_test/willowmere/scripts/vegetation.py",
    "E:/Dev/forest-lake-test-with-skill/artifacts/fleur_du_lac/scripts/vegetation.py",
    "E:/Dev/forest-lake-test-with-skill/artifacts/fleur_du_lac/scripts/refine_small_foliage.py",
]


def _runtime():
    global bpy, Vector
    import bpy
    from mathutils import Vector


def _stable(value):
    return int.from_bytes(hashlib.sha256(str(value).encode("utf-8")).digest()[:4], "little")


class Mesh:
    def __init__(self):
        self.vertices, self.faces, self.slots, self.smooth = [], [], [], []
        self.leaf_count = 0

    def add(self, vertices, faces, slot=0, smooth=False):
        start = len(self.vertices)
        self.vertices.extend(tuple(p) for p in vertices)
        self.faces.extend(tuple(start + i for i in f) for f in faces)
        self.slots.extend([slot] * len(faces))
        self.smooth.extend([smooth] * len(faces))

    def tube(self, points, radii, sides=7, slot=0):
        points = [Vector(p) for p in points]
        vertices, faces = [], []
        for i, point in enumerate(points):
            axis = points[min(i + 1, len(points) - 1)] - points[max(0, i - 1)]
            if axis.length < 1e-8:
                axis = Vector((0, 0, 1))
            axis.normalize()
            helper = Vector((0, 1, 0)) if abs(axis.y) < .85 else Vector((1, 0, 0))
            side = axis.cross(helper).normalized()
            other = axis.cross(side).normalized()
            for j in range(sides):
                a = TAU * j / sides
                vertices.append(point + (side * math.cos(a) + other * math.sin(a)) * radii[i])
        for i in range(len(points) - 1):
            for j in range(sides):
                faces.append((i * sides + j, i * sides + (j + 1) % sides,
                              (i + 1) * sides + (j + 1) % sides, (i + 1) * sides + j))
        faces.extend([tuple(reversed(range(sides))),
                      tuple((len(points) - 1) * sides + j for j in range(sides))])
        self.add(vertices, faces, slot, smooth=True)

    def leaf(self, center, direction, length, width, roll=0, slot=0, lobed=False):
        """Shallow folded blades retain their real edges from either side."""
        center, axis = Vector(center), Vector(direction).normalized()
        side = axis.cross(Vector((0, 0, 1)))
        if side.length < .01:
            side = axis.cross(Vector((0, 1, 0)))
        side.normalize()
        normal = axis.cross(side).normalized()
        side = side * math.cos(roll) + normal * math.sin(roll)
        normal = axis.cross(side).normalized()
        if lobed:
            outline = [(0, -.5), (-.27, -.39), (-.51, -.27), (-.34, -.16),
                       (-.55, -.025), (-.34, .10), (-.47, .245), (-.23, .32),
                       (0, .50), (.23, .32), (.47, .245), (.34, .10),
                       (.55, -.025), (.34, -.16), (.51, -.27), (.27, -.39)]
        else:
            outline = [(0, -.5), (-.35, -.32), (-.50, 0), (-.31, .32),
                       (0, .5), (.31, .32), (.5, 0), (.35, -.32)]
        verts = [center + normal * length * .045]
        verts += [center + side * a * width + axis * b * length
                  + normal * (b * b * width * .16) for a, b in outline]
        faces = [(0, 1 + i, 1 + (i + 1) % len(outline)) for i in range(len(outline))]
        self.add(verts, faces, slot)
        self.leaf_count += 1

    def needle(self, start, end, width, slot=0, roll=0):
        a, b = Vector(start), Vector(end)
        axis = (b - a).normalized()
        side = axis.cross(Vector((0, 0, 1)))
        if side.length < .01:
            side = axis.cross(Vector((0, 1, 0)))
        side.normalize()
        normal = axis.cross(side).normalized()
        side = side * math.cos(roll) + normal * math.sin(roll)
        mid = a.lerp(b, .47)
        ridge = mid + Vector((0, 0, width * .26))
        self.add([a, mid - side * width, b, mid + side * width, ridge],
                 [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)], slot)
        self.leaf_count += 1

    def blade(self, root, heading, height, width, bend, slot=0, segments=8):
        root = Vector(root)
        forward = Vector((math.cos(heading), math.sin(heading), 0))
        side = Vector((-math.sin(heading), math.cos(heading), 0))
        verts, faces = [], []
        for j in range(segments + 1):
            t = j / segments
            center = root + forward * (bend * t * t) + Vector((0, 0, height * (t - .15 * t ** 3)))
            half = max(width * .015, width * (.66 + .6 * math.sin(math.pi * t)) * (1 - t) ** .65)
            verts.extend([center - side * half, center + Vector((0, 0, half * .16)), center + side * half])
        for j in range(segments):
            a, b = j * 3, (j + 1) * 3
            faces.extend([(a, b, a + 1), (a + 1, b, b + 1), (a + 1, b + 1, a + 2), (a + 2, b + 1, b + 2)])
        self.add(verts, faces, slot)
        self.leaf_count += 1

    def cloud(self, center, radii, count, rng, length=(.25, .43), ratio=(.46, .65), lobed=False):
        center = Vector(center)
        for j in range(count):
            a = j * 2.3999632297 + rng.uniform(-.32, .32)
            vertical = 1 - 2 * (j + .5) / count
            horizontal = math.sqrt(max(0, 1 - vertical * vertical))
            radius = rng.uniform(.67, 1.04) if j % 4 else rng.uniform(.15, .75)
            p = center + Vector((math.cos(a) * horizontal * radii[0] * radius,
                                 math.sin(a) * horizontal * radii[1] * radius,
                                 vertical * radii[2] * radius))
            direction = (math.cos(a) + rng.uniform(-.5, .5), math.sin(a) + rng.uniform(-.5, .5),
                         rng.uniform(-.40, .80))
            size = rng.uniform(*length)
            shade = rng.choices([0, 1, 2, 3], [15, 39, 34, 12])[0]
            self.leaf(p, direction, size, size * rng.uniform(*ratio), rng.uniform(-.90, .90), shade, lobed)

    def finish(self, name, materials):
        data = bpy.data.meshes.new(name)
        data.from_pydata(self.vertices, [], self.faces)
        for mat in materials:
            data.materials.append(mat)
        for poly, slot, smooth in zip(data.polygons, self.slots, self.smooth):
            poly.material_index, poly.use_smooth = slot, smooth
        data.update()
        data["botanical_elements"] = self.leaf_count
        data["full_detail_shared_prototype"] = True
        data["solid_canopy_hulls"] = False
        data["geometry_provenance"] = "Original botanical construction adapted from user's Willowmere and Fleur du Lac methods"
        return data


def _materials(ctx):
    if hasattr(ctx, "_detailed_vegetation_materials"):
        return ctx._detailed_vegetation_materials
    palettes = {
        "wood": ["634629", "796040"],
        "oak": ["527337", "6B8943", "7D9B53", "95AF68"],
        "pine": ["31593E", "416D4A", "527F53", "68915E"],
        "cypress": ["345A3C", "436D43", "527D4C", "6B925A"],
        "palm": ["476E30", "62883C", "7C9E4E", "97B764"],
        "shrub": ["3F6939", "588247", "739751", "90AF65"],
        "grass": ["5A773D", "718B45", "8B9E58", "ACAF73"],
        "fern": ["3F6938", "5E8842", "7D9D4D", "9FB865"],
        "flower": ["54763F", "668449", "BF618E", "D785A7", "F6EACA", "D8A949"],
        "lavender": ["54713F", "627E47", "806299", "9B7AAF", "B49BC4", "8E78AA"],
        "litter": ["66543A", "867349", "A38857", "B59C71"],
    }
    mats = {}
    for kind, values in palettes.items():
        mats[kind] = []
        for i, color in enumerate(values):
            name = f"VEG_{'Bark' if kind == 'wood' else 'Leaf'}_{kind}_{i}"
            ctx.material(name, color, roughness=.87 if kind == "wood" else .78)
            mat = ctx.materials[name]
            mat.use_backface_culling = False
            mat["semantic_role"] = "plant_structure" if kind == "wood" else "foliage"
            mat["doubleSided"] = True
            mat["foliage_normals"] = "Single physical folded blade; two-sided material; no reversed duplicate faces"
            # Plain exportable Principled colors and geometry; no emissive shade fill.
            mats[kind].append(mat)
    ctx._detailed_vegetation_materials = mats
    return mats


def _oak(variant, mats):
    rng = random.Random(84310 + variant * 337)
    wood, leaf = Mesh(), Mesh()
    h = 12.0 + variant * .35
    lean = Vector((rng.uniform(-.38, .38), rng.uniform(-.28, .28), 0))
    trunk = [lean * (t / 8) ** 1.4 + Vector((0, 0, h * .79 * t / 8)) for t in range(9)]
    wood.tube(trunk, [.48 * (1 - t / 10) ** 1.25 + .025 for t in range(9)], 12)
    for i in range(8):
        a = TAU * i / 8 + rng.uniform(-.15, .15)
        wood.tube([(math.cos(a) * 1.15, math.sin(a) * 1.15, .02),
                   (math.cos(a) * .52, math.sin(a) * .52, .19), (0, 0, .80)], [.055, .17, .25], 7)
    for j in range(19):
        a = j * TAU / 12
        start = rng.uniform(.18, 1.2)
        stop = rng.uniform(2.0, 4.1)
        points = []
        for k in range(5):
            z = start + (stop - start) * k / 4
            t = z / (h * .79)
            radius = .48 * (1 - t * .8) ** 1.25 + .025
            points.append(lean * t ** 1.4 + Vector((math.cos(a) * radius, math.sin(a) * radius, z)))
        wood.tube(points, [.006, .021, .023, .015, .004], 5, slot=1)
    for j in range(13):
        a = j * 2.399963 + rng.uniform(-.25, .25)
        start_z = h * (.28 + j * .027)
        reach = (3.7 if j < 9 else 2.5) * rng.uniform(.90, 1.12)
        start = lean * (start_z / h) + Vector((0, 0, start_z))
        end = Vector((math.cos(a) * reach, math.sin(a) * reach,
                      h * (.64 if j < 9 else .82) + rng.uniform(-.45, .6)))
        elbow = start.lerp(end, .55) + Vector((0, 0, .2))
        wood.tube([start, start.lerp(elbow, .45), elbow, end], [.21, .15, .092, .025], 9)
        for k in range(4):
            heading = a + (k - 1.5) * .43
            base = elbow.lerp(end, .22 + k * .23)
            tip = base + Vector((math.cos(heading) * rng.uniform(.75, 1.2),
                                 math.sin(heading) * rng.uniform(.75, 1.2), rng.uniform(.26, .80)))
            wood.tube([base, base.lerp(tip, .6), tip], [.045, .022, .005], 6)
            for fork in (-1, 1):
                fork_tip = tip + Vector((math.cos(heading + fork * .68) * .52,
                                         math.sin(heading + fork * .68) * .52, .18))
                wood.tube([base.lerp(tip, .68), fork_tip], [.015, .003], 5)
        # Overlapping branch-scale leaf clusters form a full asymmetric crown.
        center = end + Vector((0, 0, .28))
        size = rng.uniform(1.68, 1.93)
        leaf.cloud(center, (size * 1.04, size * .95, size * .86), 360, rng,
                   length=(.27, .43), ratio=(.50, .66), lobed=True)
    leaf.cloud((lean.x, lean.y, h * .9), (1.88, 1.65, 1.4), 390, rng,
               length=(.26, .42), ratio=(.50, .66), lobed=True)
    # Interior foliage links neighboring clusters without an opaque filler volume.
    leaf.cloud((lean.x, lean.y, h * .65), (2.5, 2.35, 1.65), 480, rng,
               length=(.27, .43), ratio=(.50, .66), lobed=True)
    return wood, leaf


def _pine(variant, mats):
    rng = random.Random(31907 + variant * 311)
    wood, leaf = Mesh(), Mesh()
    height = 16 + variant * .6
    wood.tube([(0, 0, 0), (.08, -.04, height * .35), (.06, .13, height * .72), (.14, .16, height)],
              [.37, .26, .12, .012], 12)
    for root in range(7):
        a = root * TAU / 7
        wood.tube([(math.cos(a) * .85, math.sin(a) * .85, .015), (0, 0, .5)], [.05, .18], 6)
    for tier in range(12):
        level = 2.60 + tier * 1.14 + rng.uniform(-.20, .20)
        reach = 4.70 * (1 - tier / 13.4)
        branch_count = 7 if tier < 7 else 6
        for branch in range(branch_count):
            a = branch * TAU / branch_count + tier * .69 + rng.uniform(-.10, .1)
            radial = Vector((math.cos(a), math.sin(a), 0))
            side = Vector((-math.sin(a), math.cos(a), 0))
            start = Vector((0, 0, level + rng.uniform(-.36, .36)))
            end = start + radial * reach * rng.uniform(.87, 1.10) + Vector((0, 0, rng.uniform(.10, .90)))
            middle = start.lerp(end, .6) - Vector((0, 0, rng.uniform(.10, .38)))
            wood.tube([start, middle, end], [.095 * (1 - tier / 17), .044, .004], 7)
            # Each living bough has alternating lateral twigs carrying individual
            # tapered needle sprays, including its middle instead of only its tip.
            for j in range(9):
                t = .17 + j * .096
                source = start.lerp(end, t) + Vector((0, 0, -.16 * math.sin(t * math.pi) + rng.uniform(-.20, .20)))
                twig_length = reach * .36 * (math.sin(math.pi * t) ** .5) + .12
                for sign in (-1, 1):
                    tip = source + side * twig_length * sign + radial * .16 + Vector((0, 0, rng.uniform(-.43, .80)))
                    wood.tube([source, source.lerp(tip, .58), tip], [.018, .009, .002], 5)
                    # Volumetric short shoots overlap across the living bough,
                    # unlike a flat fern fan. Each has an explicit attachment
                    # and opaque articulated needles with varied blade normals.
                    for k in range(12):
                        q = (k + .35) / 12
                        shoot_root = source.lerp(tip, q)
                        heading = a + k * 2.399963 + sign * .4
                        direction = Vector((math.cos(heading), math.sin(heading), rng.uniform(-.7, 1.0))).normalized()
                        shoot_end = shoot_root + direction * rng.uniform(.18, .32)
                        for needle_i in range(3):
                            nangle = heading + (needle_i - 1) * .72
                            needle_axis = Vector((math.cos(nangle), math.sin(nangle), rng.uniform(-.35, .9))).normalized()
                            needle_length = rng.uniform(.36, .59)
                            root = shoot_root.lerp(shoot_end, .25 + needle_i * .27)
                            leaf.needle(root, root + needle_axis * needle_length, rng.uniform(.045, .069),
                                        rng.choices([0, 1, 2, 3], [13, 42, 34, 11])[0], rng.uniform(-1.35, 1.35))
    # Tight ascending new growth finishes the apex without a flat cut-off.
    for j in range(21):
        a = j * 2.399963
        z = height - 2.1 + j * .095
        radius = max(.04, .65 * (1 - j / 23))
        base = Vector((.12, .15, z))
        tip = base + Vector((math.cos(a) * radius, math.sin(a) * radius, .32))
        wood.tube([base, tip], [.016, .002], 5)
        for k in range(14):
            t = k / 14
            p = base.lerp(tip, t)
            heading = a + k * 2.4
            leaf.needle(p, p + Vector((math.cos(heading) * .19, math.sin(heading) * .19, .16)), .021, 2 + (k % 2))
    return wood, leaf


def _cypress(variant, mats):
    rng = random.Random(4213 + variant * 203)
    wood, leaf = Mesh(), Mesh()
    height = 11.5 + variant * .4
    wood.tube([(0, 0, 0), (.05, -.04, height * .55), (.08, .03, height)], [.25, .12, .008], 10)
    for j in range(24):
        level = .75 + j * (height - 1.0) / 24
        radius = 1.10 * math.sin(math.pi * (level + .20) / (height + .55)) ** .55 + .08
        for k in range(5):
            a = j * 2.399963 + k * TAU / 5
            start = Vector((0, 0, level))
            end = start + Vector((math.cos(a) * radius, math.sin(a) * radius, .4))
            wood.tube([start, end], [.029, .003], 5)
            for spray in range(39):
                t = rng.uniform(.17, 1.12)
                p = start.lerp(end, t) + Vector((rng.uniform(-.25, .25), rng.uniform(-.25, .25), rng.uniform(-.30, .48)))
                leaf.leaf(p, (math.cos(a) * .4, math.sin(a) * .4, 1), rng.uniform(.28, .50),
                          rng.uniform(.085, .14), rng.uniform(-math.pi, math.pi), rng.randrange(4))
    leaf.cloud((.04, .03, height - .3), (.34, .34, .68), 120, rng, (.20, .34), (.18, .27))
    return wood, leaf


def _palm(variant, mats):
    rng = random.Random(19831 + variant * 291)
    wood, leaf = Mesh(), Mesh()
    height = 11.2 + variant * .7
    lean = Vector((.42 + variant * .09, -.20, 0))
    trunk = [lean * (j / 18) ** 1.65 + Vector((0, 0, height * j / 18)) for j in range(19)]
    radii = [.31 * (1 - .38 * j / 18) for j in range(19)]
    wood.tube(trunk, radii, 12)
    for ring in range(38):
        t = (ring + .3) / 39
        center = lean * t ** 1.65 + Vector((0, 0, height * t))
        r = .31 * (1 - .38 * t)
        for arc in range(8):
            a, b = arc * TAU / 8, (arc + 1) * TAU / 8
            wood.tube([center + Vector((math.cos(a) * r, math.sin(a) * r, 0)),
                       center + Vector((math.cos(b) * r, math.sin(b) * r, .025))], [.016, .012], 4, 1)
    crown = lean + Vector((0, 0, height))
    for frond in range(20):
        a = frond * 2.399963 + rng.uniform(-.12, .12)
        length = rng.uniform(4.0, 5.3)
        lift = .8 if frond < 9 else 1.45 if frond < 16 else 2.3
        droop = 1.5 if frond < 9 else .65 if frond < 16 else .15
        radial = Vector((math.cos(a), math.sin(a), 0))
        side = Vector((-math.sin(a), math.cos(a), 0))
        points = [crown + radial * length * (j / 16) + Vector((0, 0,
                  lift * math.sin(j / 16 * math.pi * .85) - droop * (j / 16) ** 2)) for j in range(17)]
        wood.tube(points, [.075 * (1 - j / 18) + .004 for j in range(17)], 6, 1)
        for j in range(1, 30):
            t = j / 30
            p = crown + radial * length * t + Vector((0, 0, lift * math.sin(t * math.pi * .85) - droop * t * t))
            length_leaf = (.2 + math.sin(math.pi * t) ** .7) * rng.uniform(.82, 1.02)
            for sign in (-1, 1):
                axis = side * sign * .93 + radial * .25 + Vector((0, 0, -.27 - t * .20))
                leaf.leaf(p + axis * length_leaf * .44, axis, length_leaf, .155 * (1 - .46 * t),
                          sign * .20, rng.choices([0, 1, 2, 3], [10, 40, 35, 15])[0])
    # Short crownshaft petiole stubs resolve the junction of all fronds.
    for j in range(18):
        a = j * TAU / 18
        p = crown + Vector((math.cos(a) * .26, math.sin(a) * .26, -.38))
        q = crown + Vector((math.cos(a) * .5, math.sin(a) * .5, .08))
        wood.tube([p, q], [.11, .035], 6, 1)
    return wood, leaf


def _botanical(kind, variant, mats):
    rng = random.Random(77820 + _stable(kind) % 10000 + variant * 113)
    mesh = Mesh()
    if kind == "grass":
        for blade in range(62):
            a = rng.random() * TAU
            radius = rng.uniform(0, .24)
            h = rng.uniform(.16, .43)
            mesh.blade((math.cos(a) * radius, math.sin(a) * radius, .006), a + rng.uniform(-.3, .3),
                       h, rng.uniform(.0055, .011), h * rng.uniform(.3, .72), rng.randrange(4))
        return mesh, mats["grass"]
    if kind == "fern":
        for frond in range(9):
            a = frond * TAU / 9 + rng.uniform(-.12, .12)
            length = rng.uniform(.64, .98)
            points = [Vector((math.cos(a) * length * j / 13, math.sin(a) * length * j / 13,
                              .02 + .48 * math.sin(j / 13 * 2.4))) for j in range(14)]
            mesh.tube(points, [.009 * (1 - j / 15) for j in range(14)], 4)
            for j in range(1, 13):
                t = j / 13
                size = .20 * math.sin(math.pi * t) ** .7
                for sign in (-1, 1):
                    heading = a + sign * 1.02
                    axis = Vector((math.cos(heading), math.sin(heading), .12))
                    mesh.leaf(points[j] + axis * size * .44, axis, size, size * .28, sign * .22, 1 + j % 3)
        return mesh, mats["fern"]
    if kind == "reed":
        for i in range(21):
            a = i * 2.399963
            radius = rng.uniform(.04, .34)
            root = Vector((math.cos(a) * radius, math.sin(a) * radius, 0))
            h = rng.uniform(.8, 1.7)
            tip = root + Vector((math.cos(a) * .11, math.sin(a) * .11, h))
            mesh.tube([root, root.lerp(tip, .55), tip], [.012, .008, .005], 5)
            for j in range(3):
                mesh.blade(root.lerp(tip, .12 + .2 * j), a + j * 2.1,
                           h * .44, .027, h * .31, j % 4, 9)
            if i % 4 == 0:
                mesh.tube([tip, tip + Vector((0, 0, .19))], [.035, .025], 8, 3)
        return mesh, mats["grass"]
    if kind == "leaf_litter":
        for j in range(28):
            x, y = rng.uniform(-.55, .55), rng.uniform(-.55, .55)
            a = rng.random() * TAU
            mesh.leaf((x, y, rng.uniform(.008, .02)), (math.cos(a), math.sin(a), .02),
                      rng.uniform(.075, .13), rng.uniform(.035, .06), rng.uniform(-.12, .12), j % 4, j % 3 == 0)
        return mesh, mats["litter"]
    if kind == "shrub":
        for j in range(15):
            a = j * 2.399963
            end = Vector((math.cos(a) * rng.uniform(.25, .53), math.sin(a) * rng.uniform(.25, .53),
                          rng.uniform(.65, 1.05)))
            mesh.tube([(0, 0, 0), end * .50 + Vector((0, 0, .06)), end], [.026, .014, .004], 5)
        mesh.cloud((0, 0, .67), (.75, .71, .57), 430, rng, (.12, .22), (.50, .74))
        return mesh, mats["shrub"]
    # Petal-based garden plants retain small stems, leaves and individual florets.
    lavender = kind == "lavender"
    palette = mats["lavender"] if lavender else mats["flower"]
    stems = 23 if lavender else 13 if kind == "rose" else 17
    for i in range(stems):
        a = i * 2.399963
        r = math.sqrt((i + .5) / stems) * (.35 if lavender else .37)
        h = rng.uniform(.36, .74) if lavender else rng.uniform(.34, .62) if kind == "rose" else rng.uniform(.19, .47)
        base = Vector((math.cos(a) * r * .6, math.sin(a) * r * .6, 0))
        tip = Vector((math.cos(a) * r, math.sin(a) * r, h))
        mesh.tube([base, base.lerp(tip, .6), tip], [.009, .005, .0025], 5)
        for j in range(3):
            aa = a + j * 2.399
            axis = Vector((math.cos(aa), math.sin(aa), .35))
            size = .12 if lavender else .17
            mesh.leaf(base.lerp(tip, .24 + .19 * j) + axis * size * .3, axis,
                      size, .026 if lavender else .065, .20, 1)
        if lavender:
            for level in range(7):
                center = tip + Vector((0, 0, .022 * level))
                for petal in range(4):
                    aa = petal * TAU / 4 + level * .68
                    axis = Vector((math.cos(aa), math.sin(aa), .25))
                    mesh.leaf(center + axis * .022, axis, .044, .026, 0, 2 + (i + level) % 4)
        else:
            petals = 9 if kind == "daisy" else 7
            for level in range(1 if kind == "daisy" else 2):
                for petal in range(petals):
                    aa = petal * TAU / petals + level * .5
                    axis = Vector((math.cos(aa), math.sin(aa), .05 + level * .5))
                    mesh.leaf(tip + axis * (.051 - .015 * level) + Vector((0, 0, .016 * level)), axis,
                              .09 - level * .018, .028 if kind == "daisy" else .072,
                              0, 4 if kind == "daisy" else 2 + level)
            mesh.tube([tip, tip + Vector((0, 0, .018))], [.024, .020], 9, 5)
    return mesh, palette


def _instance(ctx, name, data, x, y, z, scale, yaw, role, prototype):
    obj = bpy.data.objects.new(ctx.region + "/" + name, data)
    ctx.current.objects.link(obj)
    obj.location, obj.scale, obj.rotation_euler.z = (x, -z, y), (scale, scale, scale), -yaw
    obj["semantic_id"] = ctx.region + "/" + name
    obj["material_role"] = "foliage" if role != "branching_wood" else "bark"
    obj["asset_role"] = role
    obj["source_mesh"] = data.name
    obj["prototype_id"] = prototype
    obj["full_geometry_shadow"] = True
    obj["static_environment"] = True
    ctx.entries.append({"id": obj.name, "mesh": data.name,
                        "material": obj["material_role"], "position": [x, y, z],
                        "prototype": prototype, "components": role})
    return obj


def tree(ctx, name, x, z, height, style="oak"):
    """Dense species-specific full-detail tree. Existing Context.tree signature."""
    _runtime()
    mats = _materials(ctx)
    if style not in {"oak", "pine", "cypress", "palm"}:
        style = "oak"
    if height <= 3.8 and style in {"oak", "cypress"}:
        # Existing callers sometimes requested tree-sized shrubs: give those a
        # shrub growth habit instead of a miniature mature tree on a long pole.
        return plant(ctx, name, x, z, kind="shrub", scale=height / 1.25)
    variant = _stable(f"{style}:{round(x, 2)}:{round(z, 2)}") % 3
    key = ("detailed_tree", style, variant)
    if not hasattr(ctx, "_botanical_prototypes"):
        ctx._botanical_prototypes = {}
    if key not in ctx._botanical_prototypes:
        wood, foliage = {"oak": _oak, "pine": _pine, "cypress": _cypress, "palm": _palm}[style](variant, mats)
        maxheight = max(p[2] for p in wood.vertices + foliage.vertices)
        wood_data = wood.finish(f"BOT_{style}_{variant}_BranchingWood", mats["wood"])
        leaf_data = foliage.finish(f"BOT_{style}_{variant}_ArticulatedFoliage", mats[style])
        ctx._botanical_prototypes[key] = (wood_data, leaf_data, maxheight)
    wood, foliage, source_height = ctx._botanical_prototypes[key]
    scale = height / source_height
    yaw = (_stable(name + str(x)) % 10000) / 10000 * TAU
    ground = ctx.ground(x, z)
    prototype = f"{style}/{variant}"
    trunk = _instance(ctx, name + "/branching-wood", wood, x, ground, z, scale, yaw, "branching_wood", prototype)
    canopy = _instance(ctx, name + "/articulated-foliage", foliage, x, ground, z, scale, yaw, "tree_foliage", prototype)
    trunk["reference_height_m"] = height
    canopy["individual_leaf_elements"] = foliage["botanical_elements"]
    return [trunk, canopy]


def plant(ctx, name, x, z, kind="fern", scale=1.0, y=None, yaw=None):
    """Place one botanical clump in physical meters; y optionally overrides ground."""
    if not hasattr(ctx, "_object"):
        return None  # Geometry-free semantic-map capture remains usable outside Blender.
    _runtime()
    if kind not in {"fern", "grass", "reed", "lavender", "daisy", "rose", "shrub", "leaf_litter", "mixed"}:
        raise ValueError("Unknown botanical kind: " + kind)
    if kind == "mixed":
        kind = ("grass", "fern", "daisy", "lavender")[_stable(name) % 4]
    mats = _materials(ctx)
    variant = _stable(name) % 3
    key = ("botanical", kind, variant)
    if not hasattr(ctx, "_botanical_prototypes"):
        ctx._botanical_prototypes = {}
    if key not in ctx._botanical_prototypes:
        mesh, palette = _botanical(kind, variant, mats)
        ctx._botanical_prototypes[key] = mesh.finish(f"BOT_{kind}_{variant}_WholePlant", palette)
    if y is None:
        y = ctx.ground(x, z)
    if yaw is None:
        yaw = (_stable(name + ":yaw") % 10000) / 10000 * TAU
    return _instance(ctx, name, ctx._botanical_prototypes[key], x, y, z, scale, yaw,
                     "botanical_" + kind, f"{kind}/{variant}")


def plant_bed(ctx, name, x, z, width, depth, kind="mixed", spacing=.75, seed=0, y=None):
    """Plant a rectangular reserved bed with deterministic organic offsets.

    Bed dimensions/spacing are meters. Keep this envelope outside access routes.
    Empty planting cells remain intentional; no simplification happens at runtime.
    """
    if not hasattr(ctx, "_object"):
        return []
    rng = random.Random(seed + _stable(name))
    nx, nz = max(1, int(width / spacing)), max(1, int(depth / spacing))
    objects = []
    for iz in range(nz):
        for ix in range(nx):
            if rng.random() < .13:
                continue
            px = x - width / 2 + (ix + .5 + rng.uniform(-.22, .22)) * width / nx
            pz = z - depth / 2 + (iz + .5 + rng.uniform(-.22, .22)) * depth / nz
            chosen = rng.choices(["grass", "fern", "daisy", "lavender"], [5, 2, 2, 1])[0] if kind == "mixed" else kind
            objects.append(plant(ctx, f"{name}_{ix:02}_{iz:02}", px, pz, chosen,
                                 rng.uniform(.82, 1.15), y=y))
    return objects


def validate_fixture(output):
    """Build an isolated evidence scene and render full, reverse and close views."""
    _runtime()
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from scene_kit import Context
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    ctx = Context("VEGETATION_VALIDATION")
    ctx.ground = lambda x, z: 0.0
    ctx.collection("Isolated_Full_Detail_Botanicals")
    for name, x, z, height, style in [("Oak", -12, 0, 14, "oak"), ("Pine", 2, 0, 19, "pine"),
                                      ("Cypress", 12, 1, 13, "cypress"), ("Palm", 22, 0, 14, "palm")]:
        tree(ctx, name, x, z, height, style)
    for i, kind in enumerate(("fern", "grass", "reed", "lavender", "daisy", "rose", "shrub", "leaf_litter")):
        for j in range(3):
            plant(ctx, kind + str(j), -9 + i * 3.3, -8 + j * 1.05, kind=kind, scale=1)
    ctx.material("VEG_Fixture_Ground", "C4C5AB", roughness=.95)
    ctx.box("FixtureGround", 6, -.08, 0, 74, .16, 48, "VEG_Fixture_Ground")
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 40
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1100
    scene.render.resolution_percentage = 100
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs[0].default_value = (.48, .60, .74, 1)
    background.inputs[1].default_value = .65
    light = bpy.data.lights.new("Botanical daylight", "SUN")
    light.energy, light.angle = 2.6, math.radians(12)
    obj = bpy.data.objects.new("Botanical daylight", light)
    scene.collection.objects.link(obj)
    obj.rotation_euler = (.52, -.42, -.55)
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = .20
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        for device in prefs.devices:
            device.use = device.type != "CPU"
        if any(device.use for device in prefs.devices):
            scene.cycles.device = "GPU"
    except Exception:
        pass
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    cameras = [
        ("species-overview", (6, 18, -65), (5, 8, 0), 44),
        ("species-reverse-sky", (-32, 6, 31), (0, 10, 0), 43),
        ("oak-under-canopy", (-22, 5, -9), (-12, 8.2, 0), 39),
        ("pine-bough-detail", (7, 6.5, -8), (2, 8, 0), 48),
        ("botanical-close", (5, 2.5, -13), (2, .5, -6.8), 44),
    ]
    for name, position, target, lens in cameras:
        camera_data = bpy.data.cameras.new(name)
        camera = bpy.data.objects.new(name, camera_data)
        scene.collection.objects.link(camera)
        camera.location = (position[0], -position[2], position[1])
        direction = Vector((target[0], -target[2], target[1])) - camera.location
        camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        camera_data.lens = lens
        scene.camera = camera
        scene.render.filepath = str(output / (name + ".png"))
        bpy.ops.render.render(write_still=True)
    prototypes = []
    for mesh in bpy.data.meshes:
        if not mesh.name.startswith("BOT_"):
            continue
        mesh.calc_loop_triangles()
        prototypes.append({"id": mesh.name, "vertices": len(mesh.vertices), "triangles": len(mesh.loop_triangles),
                           "botanicalElements": mesh.get("botanical_elements", 0),
                           "invalidNormals": sum(v.vector.length < 1e-7 for v in mesh.corner_normals)})
    (output / "vegetation_validation.json").write_text(json.dumps({"references": REFERENCE_METHODS,
        "prototypes": prototypes, "fullGeometry": True, "compression": False, "opaqueCanopyCores": False,
        "views": [row[0] for row in cameras], "visualInspection": "Pending human/model image review"}, indent=2))
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "Botanical_Quality_Fixture.blend"), compress=False)
    print("BOTANICAL_FIXTURE_COMPLETE", json.dumps(prototypes), flush=True)


if __name__ == "__main__":
    import sys
    output = Path(__file__).resolve().parents[2] / "artifacts/four-horizons/comparisons/vegetation-v2"
    validate_fixture(output)
