"""Ground profiles, full projection envelopes and access for the human layer."""
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from regional_network_helpers import ARTIFACTS, ground_function
from open_landscape import _footprint


def building_record(building):
    return {'id': building['id'], 'center': [building['x'], building['z']],
            'dimensions': [building['w'], building['h'], building['d']], 'yaw': building['yaw']}


def building_polygon(building):
    return Polygon(_footprint(building_record(building)))


def field_polygon(field):
    x,z=field['center'];w,d=field['width'],field['depth'];c,s=math.cos(field.get('yaw',0)),math.sin(field.get('yaw',0))
    return Polygon([(x+u*c+v*s,z-u*s+v*c) for u,v in [(-w/2,-d/2),(w/2,-d/2),(w/2,d/2),(-w/2,d/2)]])


def road_profile(road, ground):
    maximum=0;maximum_cross=0;wet=[];worst=None;length=0
    for a,b in zip(road['points'],road['points'][1:]):
        distance=math.dist(a,b);length+=distance
        if distance<.001:continue
        dx,dz=(b[0]-a[0])/distance,(b[1]-a[1])/distance
        n=max(1,math.ceil(distance/4))
        previous=ground(*a)
        for i in range(n+1):
            x,z=a[0]+(b[0]-a[0])*i/n,a[1]+(b[1]-a[1])*i/n
            h=ground(x,z)
            if i:
                grade=abs(h-previous)/(distance/n)
                if grade>maximum:maximum,worst=grade,[x,z]
            half=road['width']/2
            cross=abs(ground(x-dz*half,z+dx*half)-ground(x+dz*half,z-dx*half))/road['width']
            maximum_cross=max(maximum_cross,cross)
            if h<=-4.6:wet.append([x,z])
            previous=h
    return {'id':road['id'],'type':road['type'],'lengthMeters':length,'maximumGrade':maximum,
            'maximumCrossSlope':maximum_cross,'worstGradePosition':worst,'submergedSamples':wet}


def inspect_plan(plan):
    ground=ground_function();all_buildings=[];all_fields=[];all_roads=[]
    originals={biome:json.loads((ARTIFACTS/biome/('landscape_reservations_before_human_layer.json' if
        (ARTIFACTS/biome/'landscape_reservations_before_human_layer.json').exists() else 'landscape_reservations.json')).read_text()) for biome in plan}
    hard=[];original_fields=[];original_roads=[]
    for biome,record in originals.items():
        hard += [(item['id'],Polygon(_footprint(item))) for item in record['buildings']]
        hard += [(item['id'],Polygon(item['polygon']).buffer(0)) for item in record['structures']+record['water']]
        original_fields += [(item['id'],Polygon(item['polygon'])) for item in record['fields']]
        original_roads += [(item['id'],LineString(item['points']).buffer(item['width']/2+.2)) for item in record['paths']]
    for biome,record in plan.items():
        all_buildings += [(biome,b,building_polygon(b)) for settlement in record['settlements'] for b in settlement['buildings']]
        all_fields += [(biome,f,field_polygon(f)) for f in record['fields']]
        all_roads += [(biome,r,LineString(r['points']).buffer(r['width']/2+.15)) for r in record['routes'] if len(r['points'])>1]
    issues=[];profiles=[];building_relief=[]
    for biome,b,polygon in all_buildings:
        heights=[ground(x,z) for x,z in polygon.exterior.coords]
        relief=max(heights)-min(heights)
        building_relief.append({'id':b['id'],'reliefMeters':relief})
        if relief>1.000001:issues.append({'kind':'building-ground-relief','id':b['id'],'relief':relief})
        for name,obstacle in hard+original_fields+original_roads:
            area=polygon.intersection(obstacle).area
            if area>.01:issues.append({'kind':'building-original-overlap','id':b['id'],'other':name,'area':area})
        for other_biome,other,other_polygon in all_buildings:
            if other['id']<=b['id']:continue
            area=polygon.intersection(other_polygon).area
            if area>.01:issues.append({'kind':'building-building-overlap','id':b['id'],'other':other['id'],'area':area})
        for _,f,f_polygon in all_fields:
            if polygon.intersection(f_polygon).area>.01:issues.append({'kind':'building-field-overlap','id':b['id'],'other':f['id']})
        for _,r,r_polygon in all_roads:
            if r['id']==b['entryRoute']:continue
            area=polygon.intersection(r_polygon).area
            if area>.01:issues.append({'kind':'building-road-overlap','id':b['id'],'other':r['id'],'area':area})
    for biome,r,polygon in all_roads:
        profile=road_profile(r,ground);profiles.append(profile)
        if profile['submergedSamples']:issues.append({'kind':'road-underwater','id':r['id'],'samples':profile['submergedSamples']})
        limit=.16 if r['type'] in ('entry','field-access') else .13
        if profile['maximumGrade']>limit:
            issues.append({'kind':'road-grade','id':r['id'],'grade':profile['maximumGrade'],'at':profile['worstGradePosition']})
        for name,obstacle in hard:
            area=polygon.intersection(obstacle).area
            if area>.02:issues.append({'kind':'road-original-overlap','id':r['id'],'other':name,'area':area})
        for name,obstacle in original_fields:
            area=polygon.intersection(obstacle).area
            if area>5:issues.append({'kind':'road-original-field-overlap','id':r['id'],'other':name,'area':area})
        for _,f,f_polygon in all_fields:
            area=polygon.intersection(f_polygon).area
            if area>5 and r['id']!=f['accessRoute']:issues.append({'kind':'road-field-overlap','id':r['id'],'other':f['id'],'area':area})
    for biome,f,polygon in all_fields:
        for name,obstacle in hard+original_fields+original_roads:
            area=polygon.intersection(obstacle).area
            if area>5:issues.append({'kind':'field-original-overlap','id':f['id'],'other':name,'area':area})
        for _,other,other_polygon in all_fields:
            if other['id']<=f['id']:continue
            area=polygon.intersection(other_polygon).area
            if area>5:issues.append({'kind':'field-field-overlap','id':f['id'],'other':other['id'],'area':area})
    clearing={}
    for biome in plan:
        volumes=[polygon.buffer(2.5) for owner,_,polygon in all_buildings if owner==biome]
        volumes += [polygon.buffer(2) for owner,_,polygon in all_fields if owner==biome]
        volumes += [polygon.buffer(2) for owner,_,polygon in all_roads if owner==biome]
        occupied=unary_union(volumes)
        clearing[biome]=[tree['id'] for tree in originals[biome]['trees'] if occupied.intersects(Point(tree['center']).buffer(tree['height']*{'oak':.56,'pine':.34,'palm':.47,'cypress':.16}.get(tree.get('style'),.56)))]
    network=[]
    for original in originals.values():
        network.extend(item for item in original['paths'] if 'Furrow' not in item['id'])
    network.extend(road for data in plan.values() for road in data['routes'])
    lines=[LineString(road['points']) for road in network]
    tree=STRtree(lines);parents=list(range(len(lines)))
    def component(i):
        while parents[i]!=i:parents[i]=parents[parents[i]];i=parents[i]
        return i
    for i,line in enumerate(lines):
        for j in tree.query(line.buffer(.05)):
            j=int(j)
            if j>i and line.distance(lines[j])<.05:parents[component(j)]=component(i)
    express_index=next(i for i,r in enumerate(network) if r['id']=='HL_Meadow/AirfieldBypass')
    source_component=component(express_index)
    disconnected=[r['id'] for i,r in enumerate(network) if r['id'].startswith('HL_') and component(i)!=source_component]
    if disconnected:issues.append({'kind':'disconnected-new-routes','ids':disconnected})
    result={'status':'PLANNED','passes':not issues,'counts':{biome:{'buildings':sum(len(s['buildings']) for s in data['settlements']),
        'routes':len(data['routes']),'fields':len(data['fields']),'existingTreesReplacedForLandUse':len(clearing[biome])} for biome,data in plan.items()},
        'issues':issues,'roadProfiles':profiles,'buildingGroundRelief':building_relief,'removedPlantingIds':clearing,
        'network':{'newRoutesConnectedToAirfieldBypass':not disconnected,'disconnectedNewRoutes':disconnected,
                   'definition':'Exact authored route centerlines with ≤5 cm join tolerance, including existing source streets; no runtime traversal claim.'}}
    (ARTIFACTS/'regional_network_plan_audit.json').write_text(json.dumps(result,indent=2))
    return result


def write_reservations(plan, audit):
    """Write the complete human-layer reservations before any region generation."""
    if not audit['passes']:raise RuntimeError('Cannot publish a failing human land-use plan.')
    aliases={'verdant-airfield':'REG_MEADOW','azure-port':'REG_PORT','alpine-lake':'REG_ALPINE','sunstone-oasis':'REG_CANYON'}
    for biome,data in plan.items():
        directory=ARTIFACTS/biome;source=directory/'landscape_reservations.json'
        checkpoint=directory/'landscape_reservations_before_human_layer.json'
        if not checkpoint.exists():checkpoint.write_bytes(source.read_bytes())
        record=json.loads(checkpoint.read_text())
        region=aliases[biome]
        for settlement in data['settlements']:
            for building in settlement['buildings']:
                item=building_record(building);item['id']=region+'/'+item['id'];item['entryAnchor']=building['entryAnchor']
                item['prototypeId']=building['prototypeId'];record['buildings'].append(item)
                polygon=building_polygon(building).buffer(2.5,join_style='mitre')
                record['structures'].append({'id':item['id']+'/parcel','polygon':list(map(list,polygon.exterior.coords))[:-1],
                    'reservationSource':'human-landuse-parcel-v1'})
        record['paths'].extend({**r,'id':region+'/'+r['id']} for r in data['routes'])
        record['fields'].extend({**f,'id':region+'/'+f['id'],'polygon':list(map(list,field_polygon(f).exterior.coords))[:-1]} for f in data['fields'])
        removed=set(audit['removedPlantingIds'][biome]);record['trees']=[tree for tree in record['trees'] if tree['id'] not in removed]
        record['removedPlantingIds']=sorted(removed)
        source.write_text(json.dumps(record,indent=2),encoding='utf-8')
        (directory/'human_landuse_plan.json').write_text(json.dumps({**data,'removedPlantingIds':sorted(removed)},indent=2),encoding='utf-8')
    (ARTIFACTS/'regional_network_plan.json').write_text(json.dumps(plan,indent=2),encoding='utf-8')


if __name__=='__main__':
    from regional_network_plan import PLAN
    result=inspect_plan(PLAN)
    print(json.dumps({'counts':result['counts'],'issueCount':len(result['issues']),'issues':result['issues']},indent=2))
    if '--write-reservations' in __import__('sys').argv:write_reservations(PLAN,result)
