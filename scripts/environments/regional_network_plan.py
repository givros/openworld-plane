"""Authored human land use before ecological infill, in existing world metres.

PLAN uses the current source-building catalog without stretching geometry.
Road widths are complete carriageway widths. Region ownership is spatial;
shared connections are authored once and referenced by adjacent plans.
"""
import math

from regional_network_helpers import attach_frontages, field, prototype_catalog, route


CONNECTIONS = [
    {'id': 'HCON_MEADOW_PORT', 'regions': ['verdant-airfield', 'azure-port'], 'position': [800, -60], 'width': 7.0, 'tangent': [1, 0]},
    {'id': 'HCON_MEADOW_ALPINE', 'regions': ['verdant-airfield', 'alpine-lake'], 'position': [60, 800], 'width': 4.8, 'tangent': [-170, 50]},
    {'id': 'HCON_PORT_CANYON', 'regions': ['azure-port', 'sunstone-oasis'], 'position': [1450, 800], 'width': 4.8, 'tangent': [-80, 170]},
    {'id': 'HCON_ALPINE_CANYON', 'regions': ['alpine-lake', 'sunstone-oasis'], 'position': [800, 1000], 'width': 4.8, 'tangent': [160, -100]},
]


def _blank(identity):
    return {'identity': identity, 'routes': [], 'settlements': [], 'fields': []}


def _add_field(plan, identity, center, width, depth, crop, points, yaw=0):
    access = route(identity + '/access', points, 2.6, 'field-access')
    plan['routes'].append(access)
    plan['fields'].append(field(identity, center, width, depth, crop, access['id'], yaw))


def _omit_crossroads(plan, settlement, cross_z, half=11):
    removed = {b['entryRoute'] for b in settlement['buildings'] if abs(b['z'] - cross_z) < half}
    settlement['buildings'] = [b for b in settlement['buildings'] if b['entryRoute'] not in removed]
    plan['routes'] = [r for r in plan['routes'] if r['id'] not in removed]


def _meadow():
    p = _blank('A working agricultural district: airfield bypass, market village, vine hamlets and accessible crop parcels.')
    prototypes = prototype_catalog('verdant-airfield')
    p['routes'] += [
        route('HL_Meadow/AirfieldBypass', [(-370,-157),(-420,-220),(-420,-345),(-390,-405),(-310,-410),(-100,-445),(100,-445),(300,-445),(470,-410)],9,'express','asphalt'),
        route('HL_Meadow/PortRoad',[(470,-410),(620,-280),(730,-65),(800,-60)],7,'primary','asphalt',['HCON_MEADOW_PORT']),
        route('HL_Meadow/NorthValleyRoad',[(-370,139),(-345,215),(-260,269),(-260,430),(-150,430),(-150,500),(-100,500),(0,500),(60,570),(60,610),(200,680),(320,710),(230,750),(60,800)],4.8,'primary','gravel',['HCON_MEADOW_ALPINE']),
        route('HL_Meadow/EastVillageApproach',[(470,-410),(414,-390)],7,'primary'),
        route('HL_Meadow/OrchardLink',[(414,-190),(360,-65),(364,58)],4.8),
        route('HL_Meadow/EastFarmLane',[(430,257),(365,315),(365,610),(60,610)],4.8),
    ]
    streets = [route('HL_Meadow/MarketVillage/WestLane',[(344,-390),(344,-190)]),
               route('HL_Meadow/MarketVillage/EastLane',[(414,-390),(414,-190)])]
    town = attach_frontages(p,'HL_Meadow/MarketVillage',[380,-290],'cottage',streets,prototypes)
    _omit_crossroads(p,town,-290)
    p['routes'] += [route('HL_Meadow/MarketVillage/SouthCross',[(344,-390),(414,-390)]),
                    route('HL_Meadow/MarketVillage/NorthCross',[(344,-190),(414,-190)]),
                    route('HL_Meadow/MarketVillage/MarketCross',[(344,-290),(414,-290)],4.8)]
    attach_frontages(p,'HL_Meadow/GrainHamlet',[-310,-345],'cottage',
        [route('HL_Meadow/GrainHamlet/Lane',[(-362,-345),(-258,-345)])],prototypes,22)
    p['routes'].append(route('HL_Meadow/GrainHamlet/Approach',[(-310,-410),(-240,-385),(-240,-345),(-258,-345)],4.8))
    attach_frontages(p,'HL_Meadow/VineHamlet',[-50,500],'cottage',
        [route('HL_Meadow/VineHamlet/Lane',[(-100,500),(0,500)])],prototypes,22)
    # Existing fields are retained; new compact parcels create the crop/road/hamlet sequence.
    _add_field(p,'HL_Meadow/VineyardWest',(-260,500),110,100,'vineyard',[(-260,430),(-260,450)])
    _add_field(p,'HL_Meadow/VineyardEast',(480,315),110,80,'vineyard',[(430,257),(430,275),(480,275)])
    _add_field(p,'HL_Meadow/MarketVegetables',(530,-240),110,125,'vegetables',[(414,-190),(475,-190),(475,-240)])
    _add_field(p,'HL_Meadow/NorthBarley',(170,530),115,100,'barley',[(60,570),(95,570),(112.5,530)])
    # Every pre-existing grain parcel acquires a farm gate on the same public network.
    for identity, points in [
        ('OriginalField00',[(-362,-345),(-430,-390),(-450,-470),(-503.5,-538)]),
        ('OriginalField01',[(-370,-157),(-445,-210),(-482,-276)]),
        ('OriginalField02',[(-370,-157),(-450,-135),(-470,-75),(-490,-25),(-516,46)]),
        ('OriginalField03',[(-345,215),(-450,270),(-450,416),(-485,416)]),
        ('OriginalField04',[(300,-445),(305,-570),(305,-670),(428,-670),(428,-646.5)]),
        ('OriginalField05',[(365,475),(350,390),(365,365),(501,365),(501,377)]),
    ]: p['routes'].append(route('HL_Meadow/'+identity+'/access',points,2.6,'field-access'))
    return p


def _port():
    p = _blank('An inland urban quarter linked to the existing harbor, surrounded by vine estates and two farming hamlets.')
    prototypes = prototype_catalog('azure-port')
    p['routes'] += [
        route('HL_Port/MeadowJoin',[(800,-60),(810,-60)],7,'primary','gravel',['HCON_MEADOW_PORT']),
        route('HL_Port/InlandAvenue',[(1120,-40),(1180,180),(1230,320),(1360,380)],7,'primary','asphalt'),
        route('HL_Port/CityHarborLink',[(1460,460),(1570,460),(1710,415)],7,'primary','asphalt'),
        route('HL_Port/OasisRoad',[(1460,540),(1530,630),(1450,800)],4.8,'primary','gravel',['HCON_PORT_CANYON']),
        route('HL_Port/SouthEstateRoad',[(1120,-40),(1080,-260),(1120,-420),(1170,-500),(1310,-530),(1480,-490)],7,'primary'),
    ]
    streets = [route('HL_Port/InlandQuarter/'+name,[(x,380),(x,540)],5.5,'secondary','asphalt')
               for x,name in [(1360,'WinemakersLane'),(1410,'MarketLane'),(1460,'MerchantsLane')]]
    town = attach_frontages(p,'HL_Port/InlandQuarter',[1410,460],'mediterranean',streets,prototypes)
    _omit_crossroads(p,town,460)
    for label,z in [('South',380),('Market',460),('North',540)]:
        p['routes'].append(route('HL_Port/InlandQuarter/'+label+'Cross',[(1360,z),(1460,z)],5.5,'secondary','asphalt'))
    attach_frontages(p,'HL_Port/WestFarmstead',[1060,170],'mediterranean',
        [route('HL_Port/WestFarmstead/Lane',[(1008,170),(1112,170)])],prototypes,22)
    p['routes'].append(route('HL_Port/WestFarmstead/Approach',[(1112,170),(1180,180)],4.8))
    attach_frontages(p,'HL_Port/SouthVintners',[1170,-565],'mediterranean',
        [route('HL_Port/SouthVintners/Lane',[(1118,-565),(1222,-565)])],prototypes,22)
    p['routes'].append(route('HL_Port/SouthVintners/Approach',[(1170,-500),(1250,-525),(1250,-565),(1222,-565)],4.8))
    _add_field(p,'HL_Port/WesternVineyard',(1020,410),115,140,'vineyard',[(1180,180),(1120,285),(1077.5,340),(1077.5,410)])
    _add_field(p,'HL_Port/MarketVineyard',(1220,490),120,110,'vineyard',[(1230,320),(1295,395),(1280,490)])
    _add_field(p,'HL_Port/SouthVegetables',(1240,-305),120,120,'vegetables',[(1080,-260),(1160,-255),(1180,-305)])
    _add_field(p,'HL_Port/SouthGrain',(1490,-630),130,90,'barley',[(1480,-490),(1425,-550),(1425,-630)])
    return p


def _alpine():
    p = _blank('The lake village grows along its level east terrace, with two lower-valley farming hamlets and pasture access.')
    prototypes = prototype_catalog('alpine-lake')
    streets = [route('HL_Alpine/EastTerrace/'+name,[(x,1362),(x,1532)])
               for x,name in [(367,'LakeLane'),(417,'UpperLane')]]
    town = attach_frontages(p,'HL_Alpine/EastTerrace',[392,1450],'chalet',streets,prototypes,19)
    _omit_crossroads(p,town,1454)
    p['routes'] += [route('HL_Alpine/EastTerrace/MarketLink',[(285,1454),(367,1454),(417,1454)],4.8),
        route('HL_Alpine/EastTerrace/NorthCross',[(367,1532),(417,1532)]),
        route('HL_Alpine/EastTerrace/SouthCross',[(367,1362),(417,1362)]),
        route('HL_Alpine/EastTerrace/ValleyApproach',[(155,1230),(260,1260),(340,1300),(367,1362)],4.8),
    ]
    attach_frontages(p,'HL_Alpine/SouthValley',[310,1130],'chalet',
        [route('HL_Alpine/SouthValley/Lane',[(258,1130),(362,1130)])],prototypes,22)
    p['routes'].append(route('HL_Alpine/SouthValley/Approach',[(115,1000),(215,1040),(258,1130)],4.8))
    p['routes'].append(route('HL_Alpine/LowerMeadowApproach',[(60,800),(-110,850),(60,970),(115,1000)],4.8,'primary','gravel',['HCON_MEADOW_ALPINE']))
    p['routes'].append(route('HL_Alpine/LowPassRoad',[(362,1130),(385,1180),(520,1170),(640,1100),(800,1000)],4.8,'primary','gravel',['HCON_ALPINE_CANYON']))
    attach_frontages(p,'HL_Alpine/WestPasture',[-170,1040],'chalet',
        [route('HL_Alpine/WestPasture/Lane',[(-222,1040),(-118,1040)])],prototypes,22)
    p['routes'].append(route('HL_Alpine/WestPasture/Approach',[(-222,1040),(-260,1070),(-270,1120)],4.8))
    _add_field(p,'HL_Alpine/ValleyBarley',(460,1100),110,90,'barley',[(362,1130),(390,1130),(405,1100)])
    _add_field(p,'HL_Alpine/WestHay',(-170,915),115,85,'pasture',[(-118,1040),(-105,975),(-112.5,915)])
    _add_field(p,'HL_Alpine/SouthHay',(20,1075),90,100,'pasture',[(115,1000),(92,1040),(65,1075)])
    return p


def build_plan():
    result = {'verdant-airfield': _meadow(), 'azure-port': _port(), 'alpine-lake': _alpine()}
    from regional_network_canyon import build_canyon_plan
    result['sunstone-oasis'] = build_canyon_plan()
    result['sunstone-oasis']['routes'].append(route('HL_Canyon/MedinaContinuity',[(1368,1708),(1368,1710)],4.4,'secondary','sand'))
    result['sunstone-oasis']['routes'].append(route('HL_Canyon/LowPassRoad',[(800,1000),(864,960),(900,1020),(960,970),(1000,1010),(1110,1005),(1125,1135),(1190,1170),(1240,1120),(1220,1020),(1240,990),(1370,970)],4.8,'primary','gravel',['HCON_ALPINE_CANYON']))
    return result


PLAN = build_plan()
