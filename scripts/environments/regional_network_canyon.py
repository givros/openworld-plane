"""Terrain-informed canyon settlement and cultivated-valley records."""
from regional_network_helpers import route, field, attach_frontages, prototype_catalog
from layout_datums import entry_anchor


def build_canyon_plan():
    plan = {'routes': [], 'settlements': [], 'fields': [], 'relocations': [
        {'id': 'REG_CANYON/CAN_Desert_Talus_023', 'destination': [1169, 1844],
         'reason': 'Preserve the loose boulder at the NorthTerraces field margin'},
        {'id': 'REG_CANYON/CAN_Desert_Talus_025', 'destination': [1170, 1812],
         'reason': 'Preserve the loose boulder at the NorthTerraces field margin'},
        {'id': 'REG_CANYON/CAN_Desert_Talus_008', 'destination': [917, 1860],
         'reason': 'Preserve the loose boulder beside the WadiVineyards parcel'},
        {'id': 'REG_CANYON/CAN_Desert_Talus_047', 'destination': [950, 1950],
         'reason': 'Preserve the loose boulder beside the WadiVineyards parcel'},
        {'id': 'REG_CANYON/CAN_Desert_Talus_114', 'destination': [1735, 1280],
         'reason': 'Keep the VineyardHamlet house footprint clear and preserve its boulder nearby'},
    ]}
    prototypes = prototype_catalog('sunstone-oasis')
    # Extend the actual oasis medina on its existing 30 m northern terrace.
    # The earlier northern caravan road remains between the new frontages.
    streets = [route(f'HL_CAN_MedinaNorth/street-{i}', [(x, 1730), (x, 1832)],
                     4.6, material='can_courtyard_paving',
                     connections=('oasis-medina', 'medina-north'))
               for i, x in enumerate((1305, 1350, 1420))]
    attach_frontages(plan, 'HL_CAN_MedinaNorth', (1362, 1780), 'adobe', streets, prototypes, spacing=18)
    plan['routes'].extend([
        route('HL_CAN_MedinaNorth/south-cross', [(1305, 1730), (1420, 1730)], 4.8,
              material='can_courtyard_paving', connections=('oasis-medina', 'medina-north')),
        route('HL_CAN_MedinaNorth/north-cross', [(1305, 1832), (1420, 1832)], 4.4,
              material='can_courtyard_paving', connections=('medina-north', 'north-farms')),
    ])

    # Two smaller places occupy clear ground, rather than enlarging isolated
    # houses. Their streets meet existing regional routes at explicit anchors.
    west = route('HL_CAN_WadiGate/main-street', [(950, 1702), (1054, 1702)], 4.6,
                 material='sand', connections=('wadi-gate', 'western-caravan-road'))
    attach_frontages(plan, 'HL_CAN_WadiGate', (1000, 1702), 'adobe', [west], prototypes, spacing=18)
    plan['routes'].append(route('HL_CAN_WadiGate/caravan-connection',
        [(1054, 1702), (1054, 1730), (1050, 1730)], 4.8, material='sand',
        connections=('wadi-gate', 'western-caravan-road')))

    east = route('HL_CAN_VineyardHamlet/main-street', [(1663, 1245), (1755, 1245)], 4.6,
                 material='sand', connections=('vineyard-hamlet', 'southern-caravan-road'))
    attach_frontages(plan, 'HL_CAN_VineyardHamlet', (1705, 1245), 'adobe', [east], prototypes, spacing=18)
    plan['routes'].append(route('HL_CAN_VineyardHamlet/valley-connection',
        [(1310, 1170), (1390, 1160), (1530, 1130), (1650, 1170), (1755, 1210), (1755, 1245)],
        4.8, material='sand', connections=('southern-caravan-road', 'vineyard-hamlet')))

    farms = [
        ('NorthTerraces', (1230, 1820), 100, 100, 'vineyard',
         [(1305, 1832), (1287, 1832), (1287, 1820), (1280, 1820)], 'medina-north'),
        ('WadiVineyards', (980, 1890), 100, 100, 'vineyard',
         [(1054, 1730), (1070, 1830), (1070, 1890), (1030, 1890)], 'wadi-gate'),
        ('EastTerraces', (1530, 1210), 80, 80, 'vineyard',
         [(1663, 1245), (1620, 1245), (1600, 1225), (1570, 1225)], 'vineyard-hamlet'),
        ('SouthernOrchard', (1715, 1135), 80, 80, 'orchard',
         [(1650, 1170), (1649, 1182), (1715, 1182), (1715, 1175)], 'vineyard-hamlet'),
    ]
    for name, center, width, depth, crop, points, connection in farms:
        identity = 'HL_CAN_' + name
        access = route(identity + '/field-access', points, 3.0, 'field-access', 'sand',
                       connections=(connection, identity))
        plan['routes'].append(access)
        record = field(identity, center, width, depth, crop, access['id'])
        record['waterStrategy'] = 'Rain-fed terraced vines with a local storage cistern' if crop == 'vineyard' else 'Well-fed orchard courts'
        plan['fields'].append(record)
    # Four leading lots sit across slightly steeper terrain. Use an existing
    # compact complete house and move it along its own frontage, preserving all
    # buildings while keeping the full projection's corner relief below 1 m.
    adjustments = {
        'HL_CAN_WadiGate/main-street/house--1-00': (0, 1702, -1),
        'HL_CAN_WadiGate/main-street/house-+1-00': (3, 1702, 1),
        'HL_CAN_VineyardHamlet/main-street/house--1-00': (2, 1245, -1),
        'HL_CAN_VineyardHamlet/main-street/house-+1-00': (7, 1245, 1),
    }
    compact = next(p for p in prototypes if p['id'] == 'REG_CANYON/CAN_Courtyard_0_1_East')
    routes_by_id = {r['id']: r for r in plan['routes']}
    for settlement in plan['settlements']:
        for building in settlement['buildings']:
            if building['id'] not in adjustments:
                continue
            delta, street_z, side = adjustments[building['id']]
            w, h, d = compact['dimensions']
            building.update(prototypeId=compact['id'], w=w, h=h, d=d,
                            x=building['x'] + delta, z=street_z + side * (d / 2 + 5.5))
            anchor = list(entry_anchor(building['x'], building['z'], w, d, building['yaw']))
            building['entryAnchor'] = anchor
            routes_by_id[building['entryRoute']]['points'] = [anchor, [anchor[0], street_z]]
    return plan
