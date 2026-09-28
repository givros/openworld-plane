"""Pure shared spatial records for the inhabited Four Horizons layer."""
import ast
import json
import math
from pathlib import Path

from layout_datums import entry_anchor

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / 'artifacts/four-horizons'


def ground_function():
    names = {'smooth', 'mix', 'rectmask', 'raw_ground', 'ground'}
    nodes = ast.parse((Path(__file__).parent / 'scene_kit.py').read_text(encoding='utf-8')).body
    functions = [node for node in nodes if isinstance(node, ast.FunctionDef) and node.name in names]
    environment = {'math': math}
    exec(compile(ast.Module(body=functions, type_ignores=[]), 'human_landuse_terrain', 'exec'), environment)
    return environment['ground']


def prototype_catalog(biome):
    registry = json.loads((ARTIFACTS / biome / 'asset_registry.json').read_text(encoding='utf-8'))
    family = {'verdant-airfield': 'cottage', 'azure-port': 'mediterranean',
              'alpine-lake': 'chalet', 'sunstone-oasis': 'adobe'}[biome]
    candidates = [record for record in registry['buildings'] if record.get('family') == family
                  and 7 <= record['dimensions'][0] <= 12.5 and 6 <= record['dimensions'][2] <= 11]
    return [{key: record[key] for key in ('id', 'dimensions', 'family', 'yaw', 'center', 'variant')}
            for record in candidates[:8]]


def route(identity, points, width=4.8, kind='secondary', material='gravel', connections=()):
    return {'id': identity, 'points': [list(point) for point in points], 'width': width,
            'type': kind, 'material': material, 'connections': list(connections)}


def point_on_line(points, distance):
    for a, b in zip(points, points[1:]):
        length = math.dist(a, b)
        if distance <= length:
            dx, dz = (b[0] - a[0]) / length, (b[1] - a[1]) / length
            return (a[0] + dx * distance, a[1] + dz * distance), (dx, dz)
        distance -= length
    a, b = points[-2:]; length = math.dist(a, b)
    return tuple(b), ((b[0] - a[0]) / length, (b[1] - a[1]) / length)


def frontage(settlement_id, street, prototypes, spacing=20, sides=(-1, 1), setback=3.2):
    """Place detached complete prototypes along an authored frontage centerline.

    setback is wall face to carriageway edge; source projections remain at most
    1.65 m deep. Entries use the actual shared facade-bay datum.
    """
    length = sum(math.dist(a, b) for a, b in zip(street['points'], street['points'][1:]))
    buildings, entries = [], []
    distances = [12 + index * spacing for index in range(max(0, math.floor((length - 24) / spacing) + 1))]
    for side in sides:
        for index, distance in enumerate(distances):
            prototype = prototypes[(index + (3 if side > 0 else 0)) % len(prototypes)]
            w, h, d = prototype['dimensions']
            (px, pz), (tx, tz) = point_on_line(street['points'], distance)
            nx, nz = -tz * side, tx * side
            offset = d / 2 + street['width'] / 2 + setback
            x, z = px + nx * offset, pz + nz * offset
            yaw = math.atan2(-nx, -nz)
            name = f'{settlement_id}/{street["id"].split("/")[-1]}/house-{side:+d}-{index:02d}'
            entry = list(entry_anchor(x, z, w, d, yaw))
            # The actual door bay may be laterally offset from the house center.
            # Project that bay onto the selected frontage, preserving its normal.
            dot = (entry[0] - px) * tx + (entry[1] - pz) * tz
            street_anchor = [px + dot * tx, pz + dot * tz]
            entry_id = name + '/entry'
            buildings.append({'id': name, 'prototypeId': prototype['id'], 'x': x, 'z': z,
                'w': w, 'd': d, 'h': h, 'yaw': yaw, 'style': prototype['family'],
                'entryAnchor': entry, 'entryRoute': entry_id, 'frontageRoute': street['id']})
            entries.append(route(entry_id, [entry, street_anchor], 1.8, 'entry'))
    return buildings, entries


def attach_frontages(plan, identity, center, style, streets, prototypes, spacing=20):
    buildings = []
    for street in streets:
        lots, entries = frontage(identity, street, prototypes, spacing)
        buildings.extend(lots); plan['routes'].extend([street, *entries])
    result = {'id': identity, 'center': list(center), 'style': style, 'buildings': buildings}
    plan['settlements'].append(result)
    return result


def field(identity, center, width, depth, crop, access_route, yaw=0):
    return {'id': identity, 'center': list(center), 'width': width, 'depth': depth,
            'yaw': yaw, 'crop': crop, 'accessRoute': access_route}


_ROADBED_GRAPH = None


def _segment_intersections(a,b,c,d):
    """All exact authored centerline junctions, including collinear joins."""
    ux,uz=b[0]-a[0],b[1]-a[1];vx,vz=d[0]-c[0],d[1]-c[1]
    determinant=ux*vz-uz*vx
    if abs(determinant)>1e-9:
        t=((c[0]-a[0])*vz-(c[1]-a[1])*vx)/determinant
        q=((c[0]-a[0])*uz-(c[1]-a[1])*ux)/determinant
        return [[a[0]+t*ux,a[1]+t*uz]] if -.000001<=t<=1.000001 and -.000001<=q<=1.000001 else []
    if abs((c[0]-a[0])*uz-(c[1]-a[1])*ux)>1e-6:return []
    def on(p,first,last):
        return min(first[0],last[0])-1e-6<=p[0]<=max(first[0],last[0])+1e-6 and min(first[1],last[1])-1e-6<=p[1]<=max(first[1],last[1])+1e-6
    return [list(p) for p in (a,b,c,d) if on(p,a,b) and on(p,c,d)]


def _roadbed_graph(allroutes):
    global _ROADBED_GRAPH
    if allroutes is None:
        from regional_network_plan import PLAN
        allroutes=[r for region in PLAN.values() for r in region['routes']]
    elif isinstance(allroutes,dict):
        allroutes=[r for region in allroutes.values() for r in region['routes']]
    signature=tuple((r['id'],r['width'],tuple(map(tuple,r['points']))) for r in allroutes)
    if _ROADBED_GRAPH is not None and _ROADBED_GRAPH['signature']==signature:return _ROADBED_GRAPH
    ground=ground_function();nodes={};segments=[]
    def register(point,radius):
        key=tuple(round(float(v),6) for v in point)
        nodes[key]=max(nodes.get(key,0),radius)
    for r in allroutes:
        radius=r['width']/2+1.6
        for point in r['points']:register(point,radius)
        for a,b in zip(r['points'],r['points'][1:]):segments.append((a,b,radius))
    for index,(a,b,radius) in enumerate(segments):
        for c,d,other_radius in segments[index+1:]:
            if max(a[0],b[0])+1e-7<min(c[0],d[0]) or max(c[0],d[0])+1e-7<min(a[0],b[0]):continue
            if max(a[1],b[1])+1e-7<min(c[1],d[1]) or max(c[1],d[1])+1e-7<min(a[1],b[1]):continue
            for point in _segment_intersections(a,b,c,d):register(point,max(radius,other_radius))
    grid={};junctions=[]
    for (x,z),radius in nodes.items():
        # Disc support includes both roads' full cross-sections and grounded
        # shoulders at a turn or junction; every region receives the same datum.
        support=max([ground(x,z)]+[ground(x+math.cos(i*math.tau/24)*radius*f,z+math.sin(i*math.tau/24)*radius*f)
                                  for f in (.5,1) for i in range(24)])+.06
        node={'point':[x,z],'height':support,'radius':radius}
        junctions.append(node);grid.setdefault((math.floor(x/16),math.floor(z/16)),[]).append(node)
    _ROADBED_GRAPH={'signature':signature,'ground':ground,'nodes':junctions,'grid':grid}
    return _ROADBED_GRAPH


def roadbed_profile(road,allroutes=None):
    """Return {points, heights} at <=2 m spacing in absolute world Y.

    Each section is level across the carriageway and stands 6 cm above its
    highest terrain support, including 1.6 m of verge per side. Shared junction
    datums use a common world-space field with a smooth 12 m blend, so adjacent
    regions and intersecting roads produce identical junction heights. The
    caller must construct solid grounded side slopes/retaining faces under it.
    Existing roads outside allroutes still need a short end transition at joins.
    """
    graph=_roadbed_graph(allroutes);ground=graph['ground'];points=[];heights=[]
    width=road['width'];radius=width/2+1.6
    for a,b in zip(road['points'],road['points'][1:]):
        length=math.dist(a,b)
        if length<1e-7:continue
        tx,tz=(b[0]-a[0])/length,(b[1]-a[1])/length
        count=max(1,math.ceil(length/2));fractions={i/count for i in range(count+1)}
        for node in graph['nodes']:
            x,z=node['point'];along=(x-a[0])*tx+(z-a[1])*tz
            if -.00001<=along<=length+.00001 and abs((x-a[0])*tz-(z-a[1])*tx)<.00001:
                fractions.add(max(0,min(1,along/length)))
        for t in sorted(fractions):
            x,z=a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t
            base=max(ground(x-tz*radius*i/4,z+tx*radius*i/4) for i in range(-4,5))+.06
            center=ground(x,z)+.06;ix,iz=math.floor(x/16),math.floor(z/16)
            for i in range(ix-1,ix+2):
                for j in range(iz-1,iz+2):
                    for node in graph['grid'].get((i,j),()):
                        distance=math.dist([x,z],node['point'])
                        if distance>12:continue
                        blend=1-distance/12;blend=blend*blend*(3-2*blend)
                        base=max(base,center+max(0,node['height']-center)*blend)
            if points and math.dist(points[-1],[x,z])<1e-6:
                heights[-1]=max(heights[-1],base)
            else:points.append([x,z]);heights.append(base)
    repair=None
    if road['id'] in {'HL_CAN_WadiVineyards/field-access','HL_CAN_EastTerraces/field-access'}:
        # These two short farm approaches had isolated 26–27% ramps from the
        # junction blend. Raise their supported beds without lowering terrain,
        # moving the centerline, or changing either shared endpoint datum.
        before=heights[:]
        distances=[math.dist(a,b) for a,b in zip(points,points[1:])]
        for i in range(1,len(heights)):
            heights[i]=max(heights[i],heights[i-1]-.20*distances[i-1])
        for i in range(len(heights)-2,-1,-1):
            heights[i]=max(heights[i],heights[i+1]-.20*distances[i])
        maximum_raise=max(a-b for a,b in zip(heights,before))
        if abs(heights[0]-before[0])>1e-8 or abs(heights[-1]-before[-1])>1e-8 or maximum_raise>.25:
            raise RuntimeError('Local farm-road profile repair exceeded its verified support envelope.')
        repair={'method':'Local raise-only 20% longitudinal envelope','maximumRaiseMeters':maximum_raise,
                'startHeightUnchanged':True,'endHeightUnchanged':True}
    return {'points':points,'heights':heights,'crossfall':0,'supportClearanceMeters':.06,
            'junctionBlendMeters':12,'groundUnchanged':True,'solidSideSupportRequired':True,
            'localGradeRepair':repair}
