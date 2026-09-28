"""Original editable meadow airfield and Mediterranean harbor biome assemblies.

The shared builder owns Y-up coordinates, terrain sampling and semantic registration.
This module only emits source geometry through the documented scene context.
"""

import math
import random


def _materials(ctx):
    for name, color, roughness, metallic in [
        ("meadow_crop_green", (0.35, 0.48, 0.12), .94, 0),
        ("meadow_field_soil", (0.26, 0.16, 0.085), 1, 0),
        ("meadow_hangar", (0.33, 0.41, 0.40), .66, .25),
        ("meadow_hangar_roof", (0.50, 0.58, 0.55), .58, .3),
        ("meadow_runway_mark", (0.92, 0.89, 0.72), .86, 0),
        ("meadow_canvas", (0.89, 0.84, 0.65), .87, 0),
        ("harbor_teal", (0.065, 0.31, 0.33), .68, .08),
        ("harbor_boat_red", (0.48, 0.08, 0.045), .67, .04),
        ("harbor_bronze", (0.42, 0.30, 0.12), .52, .5),
        ("harbor_paving", (0.54, 0.51, 0.43), .94, 0),
        ("harbor_rope", (0.48, 0.37, 0.20), .99, 0),
    ]:
        ctx.material(name, color, roughness=roughness, metallic=metallic)


def _fence(ctx, name, points, height=1.7, spacing=7):
    """Connected two-rail farm fence, sampling every support onto the land."""
    for segment, (a, b) in enumerate(zip(points, points[1:])):
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        count = max(1, math.ceil(length / spacing))
        posts = []
        for index in range(count + 1):
            t = index / count
            x, z = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            g = ctx.ground(x, z)
            ctx.box(f"{name}_S{segment}_Post{index}", x, g + height / 2, z,
                    .23, height, .23, "timber")
            posts.append((x, g, z))
        for index, (p, q) in enumerate(zip(posts, posts[1:])):
            for level in (.42, .84):
                ctx.beam(f"{name}_S{segment}_Rail{index}_{level}",
                         (p[0], p[1] + height * level, p[2]),
                         (q[0], q[1] + height * level, q[2]), .10, "timber")


def _bench(ctx, name, x, z, y=None, yaw=0):
    g = ctx.ground(x, z) if y is None else y
    c, s = math.cos(yaw), math.sin(yaw)

    def part(suffix, u, v, h, w, depth, material):
        ctx.box(name + suffix, x + u * c + v * s, g + h, z - u * s + v * c,
                w, .13 if material == "timber" else .56, depth, material, yaw=yaw)

    for u in (-1.1, 1.1):
        part(f"_Support{u}", u, 0, .30, .16, 1, "metal")
    for v in (-.36, -.12, .12, .36):
        part(f"_Seat{v}", 0, v, .64, 2.8, .19, "timber")
    for h in (1.0, 1.25):
        part(f"_Back{h}", 0, .46, h, 2.8, .13, "timber")
    for u in (-1.12, 1.12):
        ctx.beam(f"{name}_BackBrace{u}",
                 (x + u * c + .46 * s, g + .3, z - u * s + .46 * c),
                 (x + u * c + .46 * s, g + 1.35, z - u * s + .46 * c), .07, "metal")


def _lamp(ctx, name, x, z, y=None, height=5.7):
    g = ctx.ground(x, z) if y is None else y
    ctx.cyl(name + "_Base", x, g + .25, z, .31, .5, "stone", vertices=12)
    ctx.cyl(name + "_Column", x, g + height / 2, z, .10, height, "metal", vertices=8)
    ctx.box(name + "_Lantern", x, g + height, z, .65, .9, .65, "cream")
    ctx.cyl(name + "_Roof", x, g + height + .55, z, .54, .3, "metal", vertices=4, top=0)
    for dx in (-.33, .33):
        for dz in (-.33, .33):
            ctx.box(name + f"_Frame{dx}_{dz}", x + dx, g + height, z + dz,
                    .06, .95, .06, "metal")


def _windmill(ctx, x, z):
    ctx.collection("REG_MEADOW_HERO_WINDMILL")
    g = ctx.ground(x, z)
    bottom = min(ctx.ground(x + math.cos(i*math.tau/40)*11,
                           z + math.sin(i*math.tau/40)*11) for i in range(40)) - .05
    top = g + 1.1
    ctx.cyl("Meadow_Windmill_Foundation", x, (bottom+top)/2, z, 11, top-bottom, "stone", vertices=20)
    ctx.cyl("Meadow_Windmill_TaperedTower", x, g + 13.5, z, 8.6, 26, "plaster_ivory",
            vertices=24, top=5.8)
    for level, radius in ((1.8, 8.55), (8, 7.9), (16, 7.03), (25.8, 6.05)):
        ctx.cyl(f"Meadow_Windmill_MasonryBand_{level}", x, g + level, z,
                radius, .45, "stone", vertices=24)
    ctx.cyl("Meadow_Windmill_Roof", x, g + 29, z, 7.6, 7, "roof_slate", vertices=24, top=.5)
    # Closed entry is deeply inset between two structural reveals.
    ctx.box("Meadow_Windmill_DoorInset", x, g + 2.0, z + 8.2, 2.6, 4, .28, "timber")
    for sx in (-1, 1):
        ctx.box(f"Meadow_Windmill_DoorJamb{sx}", x + sx * 1.45, g + 2.1, z + 8.45,
                .4, 4.2, .6, "stone")
    ctx.box("Meadow_Windmill_DoorLintel", x, g + 4.3, z + 8.4, 3.3, .48, .65, "stone")
    for level, radius in ((11, 7.55), (19, 6.7)):
        for sx in (-1, 1):
            ctx.box(f"Meadow_Windmill_Window{level}_{sx}", x + sx * 2.8, g + level, z + radius,
                    1.15, 1.7, .22, "glass")
            ctx.box(f"Meadow_Windmill_WindowSill{level}_{sx}", x + sx * 2.8, g + level - .95,
                    z + radius + .16, 1.6, .2, .5, "stone")
    hub = (x, g + 23, z + 8.5)
    ctx.beam("Meadow_Windmill_MainShaft", (x, g + 23, z + 5.5), hub, .75, "timber")
    for blade in range(4):
        angle = math.pi / 4 + blade * math.pi / 2
        ux, uy = math.cos(angle), math.sin(angle)
        tx, ty = -uy, ux
        tip = (x + ux * 23, hub[1] + uy * 23, hub[2])
        ctx.beam(f"Meadow_Windmill_SailArm{blade}", hub, tip, .20, "timber")
        verts = []
        for radius, offset in ((6, .3), (22.5, .3), (22.5, 4.4), (6, 2.3)):
            verts.append((x + ux * radius + tx * offset,
                          hub[1] + uy * radius + ty * offset, hub[2] + .08))
        ctx.mesh(f"Meadow_Windmill_Canvas{blade}", verts, [(0, 1, 2, 3)], "meadow_canvas")
        for rib in range(7):
            radius = 6 + rib * 2.65
            extent = 2.3 + (radius - 6) / 16.5 * 2.1
            ctx.beam(f"Meadow_Windmill_SailRib{blade}_{rib}",
                     (x + ux * radius, hub[1] + uy * radius, hub[2] + .16),
                     (x + ux * radius + tx * extent,
                      hub[1] + uy * radius + ty * extent, hub[2] + .16), .085, "timber")
    # Mill yard, grain storage and service access stay outside the protected flight corridor.
    ctx.path("Meadow_Windmill_Approach", [(-345, 215), (-382, 276), (x, z + 15)], 6, "gravel")
    for i in range(7):
        sx, sz = x + 15 + (i % 3) * 2.2, z - 9 + (i // 3) * 2
        ctx.cyl(f"Meadow_Windmill_GrainBarrel{i}", sx, ctx.ground(sx, sz) + .85, sz,
                .7, 1.7, "timber", vertices=12)
    return {"id": "MEADOW_WINDMILL", "position": [x, g, z], "height": 46}


def _hangar(ctx, name, x, z, width=66, depth=74):
    """Barrel-vault hangar, east-facing structural portal and panelled sliding doors."""
    g = ctx.ground(x, z)
    wall, rise = 17, 9
    ctx.box(name + "_Slab", x, g + .24, z, depth + 2, .48, width + 2, "concrete")
    ctx.box(name + "_RearWall", x - depth / 2, g + wall / 2, z,
            .85, wall, width, "meadow_hangar")
    for side in (-1, 1):
        ctx.box(name + f"_SideWall{side}", x, g + wall / 2, z + side * width / 2,
                depth, wall, .7, "meadow_hangar")
        for rib in range(10):
            xx = x - depth / 2 + rib * depth / 9
            ctx.box(name + f"_SideRib{side}_{rib}", xx, g + wall / 2,
                    z + side * (width / 2 + .25), .35, wall, .35, "metal")
        ctx.box(name + f"_SideClerestory{side}", x, g + 14.7, z + side * (width / 2 + .38),
                depth - 6, 2.2, .08, "glass")
    segs = 18
    verts = []
    for xx in (x - depth / 2 - .8, x + depth / 2 + .8):
        for i in range(segs + 1):
            a = i * math.pi / segs
            verts.append((xx, g + wall + math.sin(a) * rise, z + math.cos(a) * (width / 2 + 1)))
    faces = [(i, i + 1, segs + 2 + i, segs + 1 + i) for i in range(segs)]
    ctx.mesh(name + "_VaultRoof", verts, faces, "meadow_hangar_roof")
    for end, xx in (("Front", x + depth / 2), ("Rear", x - depth / 2)):
        panelverts = [(xx, g + wall, z)] + [
            (xx, g + wall + math.sin(i * math.pi / segs) * rise,
             z + math.cos(i * math.pi / segs) * width / 2) for i in range(segs + 1)]
        ctx.mesh(name + f"_{end}VaultGable", panelverts,
                 [(0, i + 1, i + 2) for i in range(segs)], "meadow_hangar")
    for rib in range(10):
        xx = x - depth / 2 + rib * depth / 9
        for i in range(segs):
            a, b = i * math.pi / segs, (i + 1) * math.pi / segs
            ctx.beam(name + f"_RoofSeam{rib}_{i}",
                     (xx, g + wall + math.sin(a) * rise + .12, z + math.cos(a) * (width / 2 + 1)),
                     (xx, g + wall + math.sin(b) * rise + .12, z + math.cos(b) * (width / 2 + 1)),
                     .055, "metal")
    front = x + depth / 2 + .5
    for side in (-1, 1):
        ctx.box(name + f"_PortalJamb{side}", front, g + 8.5, z + side * (width / 2 - 2),
                1.4, 17, 4, "stone")
        ctx.box(name + f"_SlidingDoor{side}", front - .18, g + 7.5, z + side * (width / 4 - 1),
                .35, 15, width / 2 - 2.5, "meadow_hangar_roof")
    ctx.box(name + "_PortalLintel", front, g + 16, z, 1.4, 2, width, "metal")
    for panel in range(14):
        zz = z - width / 2 + 4 + panel * (width - 8) / 13
        ctx.box(name + f"_DoorRib{panel}", front + .10, g + 7.5, zz,
                .19, 14.8, .11, "metal")
    ctx.box(name + "_DoorRail", front + .8, g + 15.15, z, .4, .35, width + 4, "metal")
    ctx.path(name + "_Apron", [(front + 1, z), (-43, z)], width + 7, "concrete", lift=.035)


def build_meadow(ctx):
    _materials(ctx)
    rng = random.Random(74103)
    ctx.collection("REG_MEADOW_AIRFIELD")
    # A continuous paved strip with readable threshold, centerline, shoulder and taxiway.
    ctx.box("Meadow_Runway_Shoulder", 0, -.08, 0, 32, .18, 384, "gravel")
    ctx.box("Meadow_Runway_Surface", 0, .055, 0, 24, .16, 360, "asphalt")
    for z in range(-150, 151, 25):
        ctx.box(f"Meadow_Runway_CenterDash{z}", 0, .145, z, .52, .035, 10, "meadow_runway_mark")
    for side in (-1, 1):
        ctx.box(f"Meadow_Runway_Edge{side}", side * 10.5, .145, 0, .30, .035, 346, "meadow_runway_mark")
        for strip in range(5):
            ctx.box(f"Meadow_Runway_Threshold{side}_{strip}", (strip - 2) * 3.9,
                    .148, side * 165, 1.6, .04, 12, "meadow_runway_mark")
    ctx.path("Meadow_Taxiway", [(-37, -175), (-37, 175)], 11, "asphalt", lift=.035)
    for z in (-130, 0, 130):
        ctx.path(f"Meadow_Taxiway_Connector{z}", [(-37, z), (0, z)], 10, "asphalt", lift=.04)
    for i, z in enumerate((-112, 8, 125)):
        _hangar(ctx, f"Meadow_Hangar_{i:02}", -140, z, 64 if i != 1 else 72, 72)
    # Administration and tower form an attached, legible airfield campus.
    ctx.building("Meadow_FlightClub", -135, 240, 24, 15, 6.4, "plaster_ivory", "roof_slate", yaw=math.pi / 2)
    from layout_datums import entry_anchor
    club_entry=entry_anchor(-135,240,24,15,math.pi/2)
    ctx.path('Meadow_FlightClub/entry',[club_entry,(-89,club_entry[1]),(-43,194),(-43,125)],2.2,'concrete',lift=.08)
    ctx.path("Meadow_Airfield_ServiceLane", [(-191, -208), (-191, 243), (-170, 269), (-260, 269)],
             8, "gravel")
    g = ctx.ground(-101, 228)
    ctx.box("Meadow_ControlTower_Shaft", -101, g + 10, 228, 8, 20, 8, "plaster_ivory")
    ctx.box("Meadow_ControlTower_Deck", -101, g + 20, 228, 14, .65, 14, "concrete")
    ctx.box("Meadow_ControlTower_GlassCab", -101, g + 22.4, 228, 11.2, 4.2, 11.2, "glass")
    ctx.box("Meadow_ControlTower_Cap", -101, g + 24.8, 228, 13, .6, 13, "meadow_hangar_roof")
    for dx in (-5.7, 5.7):
        for dz in (-5.7, 5.7):
            ctx.box(f"Meadow_ControlTower_CabFrame{dx}_{dz}", -101 + dx, g + 22.4, 228 + dz,
                    .28, 4.6, .28, "metal")
    ctx.cyl("Meadow_ControlTower_Antenna", -101, g + 28, 228, .13, 6, "metal", vertices=8)
    ctx.cyl("Meadow_Windsock_Mast", -84, ctx.ground(-84, -223) + 5, -223, .15, 10, "metal", vertices=8)
    ctx.beam("Meadow_Windsock_Boom", (-84, 10, -223), (-79, 9.7, -223), .35, "roof_terracotta")
    for tank in range(2):
        x, z = -218, -125 + tank * 14
        ground = ctx.ground(x, z)
        ctx.cyl(f"Meadow_FuelTank{tank}", x, ground + 3, z, 4.8, 6, "meadow_hangar_roof", vertices=20)
        ctx.cyl(f"Meadow_FuelTankCap{tank}", x, ground + 6.2, z, 4.9, .45, "metal", vertices=20)
        ctx.box(f"Meadow_FuelTankPad{tank}", x, ground + .12, z, 12, .24, 12, "concrete")
    _fence(ctx, "Meadow_Airfield_WestBoundary", [(-229, -242), (-229, 196)], 1.3, 9)

    from settlement_landscape import rural_village, rural_landscape
    streets, plots = rural_village(ctx, _bench, _fence)
    landscape = rural_landscape(ctx, streets, plots, _fence)
    return {"biome":"meadow", "runway":{"center":[0,0,0],"width":24,"length":360},
            "village_buildings":21,"hero":_windmill(ctx,-420,350),
            "streets":[{"id":n,"points":p,"width":w} for n,p,w in streets],
            "parcels":plots,"landscape":landscape,
            "protected_flight_corridor":[-65,260,-390,400]}


def _quay(ctx):
    ctx.collection("REG_HARBOR_WATERFRONT")
    # A structural seawall fixes a level public edge independently of the sloping land.
    ctx.box("Harbor_Quay_StructuralWall", 1829, 1.8, 0, 24, 14.4, 606, "stone")
    ctx.box("Harbor_Quay_Coping", 1829, 9.25, 0, 26, .55, 609, "sandstone")
    for z in range(-294, 295, 12):
        ctx.box(f"Harbor_Quay_CopingJoint{z}", 1829, 9.56, z, 26, .02, .16, "stone")
    # Access stairs descend from the high promenade to working docks at water level.
    for index, z in enumerate((-180, 0, 185)):
        ctx.box(f"Harbor_DockAccess{index}_Landing", 1843, 8.98, z, 8, .65, 6.8, "stone")
        for step in range(21):
            height = 9.3 - step * .65
            ctx.box(f"Harbor_DockAccess{index}_Step{step}", 1846 + step * 1.28,
                    height - .325, z, 1.40, .65, 6.8, "stone")
        deck_y = -3.8
        ctx.box(f"Harbor_Dock{index}_MainDeck", 1920, deck_y, z, 100, .7, 8, "timber")
        for x in range(1870, 1971, 4):
            ctx.box(f"Harbor_Dock{index}_DeckJoint{x}", x, deck_y + .36, z, .13, .025, 8, "harbor_rope")
        for x in (1875, 1905, 1935, 1965):
            for dz in (-3.6, 3.6):
                ctx.cyl(f"Harbor_Dock{index}_Pile{x}_{dz}", x, -6, z + dz,
                        .6, 7, "timber", vertices=10)
        for finger, x in enumerate((1905, 1945)):
            ctx.box(f"Harbor_Dock{index}_Finger{finger}", x, deck_y, z + 21, 5, .65, 42, "timber")
            for zz in (z + 5, z + 22, z + 40):
                for dx in (-2.1, 2.1):
                    ctx.cyl(f"Harbor_Dock{index}_FingerPile{finger}_{zz}_{dx}", x + dx, -6, zz,
                            .45, 6.8, "timber", vertices=10)
    for i, z in enumerate(range(-273, 274, 39)):
        _lamp(ctx, f"Harbor_Promenade_Lamp{i:02}", 1820, z, y=9.53)
        _bench(ctx, f"Harbor_Promenade_Bench{i:02}", 1825, z + 7, y=9.53, yaw=math.pi / 2)
        ctx.cyl(f"Harbor_Quay_MooringBollard{i}", 1840, 10.12, z, .50, 1.1, "metal", vertices=10)
    # Breakwater is connected to the southern end of the quay.
    ctx.box("Harbor_Breakwater_Foundation", 1950, -1.0, -308, 254, 10, 17, "stone")
    ctx.box("Harbor_Breakwater_Walk", 1950, 4.25, -308, 256, .65, 18, "sandstone")
    for x in range(1840, 2071, 9):
        for dz in (-1, 1):
            ctx.box(f"Harbor_Breakwater_Parapet{x}_{dz}", x, 5.1, -308 + dz * 8,
                    8.7, 1.2, 1, "stone")
    for step in range(11):
        top = 9.5 - step * .5
        ctx.box(f"Harbor_Breakwater_AccessStep{step}", 1841 + step * 1.5,
                (top + 4) / 2, -304, 1.6, top - 4, 6, "sandstone")
    return {"promenade_y": 9.53, "docks_y": -3.45, "water_y": -5}


def _boat(ctx, name, x, z, scale=1, material="harbor_teal", sail=False):
    """Shaped keel, multi-chine shell, deck, sheer rail, cabin and rigging."""
    y = -4.8
    # Cross-sections progress from stern to a tapered raised bow.
    sections = [(-8, 2.25, .4), (-6, 3.25, .15), (2.8, 3.35, .15), (7, 2.1, .6), (9, .08, 1.6)]
    verts = []
    for zz, width, sheer in sections:
        for xx, yy in ((-width, 1.2 + sheer), (-width * .72, -.55), (0, -1.15),
                       (width * .72, -.55), (width, 1.2 + sheer)):
            verts.append((x + xx * scale, y + yy * scale, z + zz * scale))
    faces = []
    for k in range(len(sections) - 1):
        for side in range(4):
            a = k * 5 + side
            faces.append((a, a + 1, a + 6, a + 5))
    faces.extend([(0, 1, 2, 3, 4), (20, 24, 23, 22, 21)])
    ctx.mesh(name + "_Hull", verts, faces, material)
    deckverts = []
    for zz, width, sheer in sections:
        deckverts.extend([(x - width * .90 * scale, y + (1.05 + sheer) * scale, z + zz * scale),
                          (x + width * .90 * scale, y + (1.05 + sheer) * scale, z + zz * scale)])
    ctx.mesh(name + "_TimberDeck", deckverts, [(i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
                                             for i in range(4)], "timber")
    for side in (-1, 1):
        for i, (a, b) in enumerate(zip(sections, sections[1:])):
            ctx.beam(name + f"_SheerRail{side}_{i}",
                     (x + side * a[1] * scale, y + (1.28 + a[2]) * scale, z + a[0] * scale),
                     (x + side * b[1] * scale, y + (1.28 + b[2]) * scale, z + b[0] * scale),
                     .14 * scale, "cream")
    ctx.box(name + "_Cabin", x, y + 2.25 * scale, z - 2 * scale,
            4.1 * scale, 2.5 * scale, 4.2 * scale, "plaster_ivory")
    ctx.box(name + "_CabinRoof", x, y + 3.60 * scale, z - 2 * scale,
            4.7 * scale, .3 * scale, 4.8 * scale, material)
    ctx.box(name + "_WheelhouseGlass", x, y + 2.55 * scale, z + .13 * scale,
            3.3 * scale, 1.3 * scale, .1, "glass")
    mastheight = 17 if sail else 8
    ctx.beam(name + "_Mast", (x, y + 1.6 * scale, z + 1.5 * scale),
             (x, y + mastheight * scale, z + 1.5 * scale), .12 * scale, "timber")
    if sail:
        ctx.mesh(name + "_Mainsail", [
            (x + .2 * scale, y + 3 * scale, z + 1.5 * scale),
            (x + .2 * scale, y + 16.5 * scale, z + 1.5 * scale),
            (x + .2 * scale, y + 3 * scale, z - 6.4 * scale)], [(0, 1, 2)], "meadow_canvas")
    for destz in (-7, 8):
        ctx.beam(name + f"_Stay{destz}", (x, y + mastheight * scale, z + 1.5 * scale),
                 (x, y + 1.8 * scale, z + destz * scale), .025 * scale, "harbor_rope")


def _lighthouse(ctx, x=2059, z=-308):
    ctx.collection("REG_HARBOR_HERO_LIGHTHOUSE")
    base = 4.58
    ctx.cyl("Harbor_Lighthouse_Platform", x, base + .55, z, 13, 1.1, "stone", vertices=32)
    ctx.cyl("Harbor_Lighthouse_TaperedTower", x, base + 20.5, z, 7.6, 40,
            "plaster_ivory", vertices=32, top=4.7)
    for level in (7, 15, 23, 31):
        radius = 7.6 - (level - .5) / 40 * 2.9
        ctx.cyl(f"Harbor_Lighthouse_RedBand{level}", x, base + level, z,
                radius + .04, 2.4, "harbor_boat_red", vertices=32, top=radius - .13)
    ctx.box("Harbor_Lighthouse_Door", x, base + 2.2, z + 7.45, 2.9, 4.2, .30, "harbor_teal")
    for side in (-1, 1):
        ctx.box(f"Harbor_Lighthouse_DoorFrame{side}", x + side * 1.6, base + 2.3, z + 7.7,
                .37, 4.6, .55, "sandstone")
    ctx.box("Harbor_Lighthouse_DoorHead", x, base + 4.7, z + 7.7, 3.55, .45, .55, "sandstone")
    for i, level in enumerate((11, 20, 29, 36)):
        radius = 7.6 - level / 40 * 2.9
        ctx.box(f"Harbor_Lighthouse_Window{i}", x, base + level, z + radius,
                1.2, 2.1, .15, "glass")
        ctx.box(f"Harbor_Lighthouse_Sill{i}", x, base + level - 1.15, z + radius + .15,
                1.65, .20, .6, "sandstone")
    ctx.cyl("Harbor_Lighthouse_Gallery", x, base + 40.8, z, 7.4, 1.0, "sandstone", vertices=32)
    for i in range(24):
        a, b = i * math.tau / 24, (i + 1) * math.tau / 24
        p = (x + math.cos(a) * 7, base + 41.2, z + math.sin(a) * 7)
        q = (x + math.cos(a) * 7, base + 43, z + math.sin(a) * 7)
        ctx.beam(f"Harbor_Lighthouse_RailingPost{i}", p, q, .06, "metal")
        ctx.beam(f"Harbor_Lighthouse_RailingTop{i}", q,
                 (x + math.cos(b) * 7, base + 43, z + math.sin(b) * 7), .065, "metal")
    ctx.cyl("Harbor_Lighthouse_Lantern", x, base + 44.1, z, 4.45, 5.5, "glass", vertices=12)
    for i in range(12):
        a = i * math.tau / 12
        ctx.cyl(f"Harbor_Lighthouse_LanternFrame{i}", x + math.cos(a) * 4.48, base + 44.1,
                z + math.sin(a) * 4.48, .14, 5.8, "metal", vertices=6)
    ctx.cyl("Harbor_Lighthouse_Reflector", x, base + 44, z, 1.8, 2.4, "cream", vertices=16)
    ctx.cyl("Harbor_Lighthouse_CopperRoof", x, base + 48.2, z, 5.8, 3.6,
            "harbor_teal", vertices=24, top=.35)
    ctx.cyl("Harbor_Lighthouse_Finial", x, base + 51, z, .16, 2.2, "harbor_bronze", vertices=8)
    return {"id": "HARBOR_LIGHTHOUSE", "position": [x, base, z], "height": 52.1}


def build_harbor(ctx):
    from settlement_landscape import harbor_town, harbor_landscape
    _materials(ctx)
    streets, buildings, envelopes, park = harbor_town(ctx, _bench, _lamp, _fence)
    landscape=harbor_landscape(ctx,streets)
    waterfront=_quay(ctx)
    ctx.collection("REG_HARBOR_BOATS")
    for i,(x,z,scale) in enumerate(((1891,-158,1.2),(1928,-158,1.15),(1891,22,1.05),
                                    (1928,24,1.30),(1891,207,1.15),(1928,210,1.1),
                                    (2140,80,2.0),(2062,320,1.6))):
        _boat(ctx,f"Harbor_Boat{i:02}",x,z,scale,
              material="harbor_teal" if i%2 else "harbor_boat_red",sail=i in (3,6,7))
    ctx.collection("REG_HARBOR_SHORE_GEOLOGY")
    rng=random.Random(49851)
    for i,z in enumerate(range(-750,751,7)):
        if -335<z<335:continue
        x=1840+35*math.sin(z*.006)+rng.uniform(-7,7)
        ctx.rock(f"Harbor_ShoreRock{i:03}",x,z,rng.uniform(2.5,7),"sandstone")
    return {"biome":"harbor","buildings":buildings,"building_count":len(buildings)+1,
            "streets":[{"id":n,"points":p,"width":w} for n,p,w in streets],
            "landscape":landscape,"park":park,"projection_envelopes":envelopes,
            "waterfront":waterfront,"hero":_lighthouse(ctx)}
