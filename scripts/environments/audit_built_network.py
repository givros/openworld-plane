"""Read actual exported world geometry and compare it with the saved registries.

No Blender files or meshes are changed. A report is explicitly provisional until
the coordinator invokes --final after all four final exports have completed.
"""
import argparse
import hashlib
import json
import math
import mmap
import struct
from pathlib import Path

from audit_terrain_fit_paths import _multiply,_node_matrix
from regional_network_helpers import ROOT,ARTIFACTS
from regional_network_plan import CONNECTIONS

REGIONS={'verdant-airfield':'REG_MEADOW','azure-port':'REG_PORT','alpine-lake':'REG_ALPINE','sunstone-oasis':'REG_CANYON'}


def _read(path):
    raw=path.read_bytes()
    return json.loads(raw),{'path':path.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(raw).hexdigest()}


def _sha(path):
    digest=hashlib.sha256()
    with path.open('rb') as handle:
        while block:=handle.read(8*1024*1024):digest.update(block)
    return digest.hexdigest()


class GLB:
    def __init__(self,path):
        self.path=path;self.handle=path.open('rb');self.data=mmap.mmap(self.handle.fileno(),0,access=mmap.ACCESS_READ)
        magic,version,total=struct.unpack_from('<4sII',self.data,0)
        if magic!=b'glTF' or version!=2 or total!=len(self.data):raise ValueError('Incomplete GLB: '+str(path))
        length,_=struct.unpack_from('<II',self.data,12)
        self.doc=json.loads(self.data[20:20+length]);self.binary=20+length+8
        self.parents={child:i for i,node in enumerate(self.doc['nodes']) for child in node.get('children',[])}
        self.transforms={};self.geometry={}
        self.nodes={node.get('name',node.get('extras',{}).get('semantic_id')):i
                    for i,node in enumerate(self.doc['nodes']) if 'mesh' in node}

    def close(self):self.data.close();self.handle.close()

    def transform(self,index):
        if index not in self.transforms:
            own=_node_matrix(self.doc['nodes'][index])
            self.transforms[index]=_multiply(self.transform(self.parents[index]),own) if index in self.parents else own
        return self.transforms[index]

    def accessor(self,index):
        a=self.doc['accessors'][index];view=self.doc['bufferViews'][a['bufferView']]
        count={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
        code={5120:'b',5121:'B',5122:'h',5123:'H',5125:'I',5126:'f'}[a['componentType']]
        fmt='<'+code*count;stride=view.get('byteStride',struct.calcsize(fmt))
        offset=self.binary+view.get('byteOffset',0)+a.get('byteOffset',0)
        return [struct.unpack_from(fmt,self.data,offset+i*stride) for i in range(a['count'])]

    def triangle_count(self,index):
        return sum(self.doc['accessors'][p['indices'] if 'indices' in p else p['attributes']['POSITION']]['count']//3
                   for p in self.doc['meshes'][index]['primitives'] if p.get('mode',4)==4)

    def surface(self,name):
        if name in self.geometry:return self.geometry[name]
        if name not in self.nodes:return None
        index=self.nodes[name];node=self.doc['nodes'][index];matrix=self.transform(index)
        triangles=[];grid={}
        for p in self.doc['meshes'][node['mesh']]['primitives']:
            if p.get('mode',4)!=4:continue
            vertices=[tuple(sum(matrix[c+4*k]*v[k] for k in range(3))+matrix[c+12] for c in range(3))
                      for v in self.accessor(p['attributes']['POSITION'])]
            indices=[i[0] for i in self.accessor(p['indices'])] if 'indices' in p else list(range(len(vertices)))
            for offset in range(0,len(indices),3):
                a,b,c=[vertices[i] for i in indices[offset:offset+3]]
                up=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2])
                if up<=1e-12:continue # exclude grounded undersides and vertical walls
                ix=len(triangles);triangles.append((a,b,c))
                for x in range(math.floor(min(v[0] for v in (a,b,c))/20),math.floor(max(v[0] for v in (a,b,c))/20)+1):
                    for z in range(math.floor(min(v[2] for v in (a,b,c))/20),math.floor(max(v[2] for v in (a,b,c))/20)+1):
                        grid.setdefault((x,z),[]).append(ix)
        result={'triangles':triangles,'grid':grid};self.geometry[name]=result
        return result

    def height(self,name,point,tolerance=.0002):
        surface=self.surface(name)
        if not surface:return None
        x,z=point;found=[];ix,iz=math.floor(x/20),math.floor(z/20)
        candidates={i for gx in range(ix-1,ix+2) for gz in range(iz-1,iz+2) for i in surface['grid'].get((gx,gz),())}
        for index in candidates:
            a,b,c=surface['triangles'][index]
            denominator=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2])
            if abs(denominator)<1e-14:continue
            u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/denominator
            v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/denominator;w=1-u-v
            # Physical edge tolerance, not a fixed barycentric tolerance on long faces.
            area=abs(denominator)
            lengths=[math.hypot(b[0]-c[0],b[2]-c[2]),math.hypot(c[0]-a[0],c[2]-a[2]),math.hypot(a[0]-b[0],a[2]-b[2])]
            if all(weight>=-tolerance*length/area for weight,length in zip((u,v,w),lengths)):
                found.append(u*a[1]+v*b[1]+w*c[1])
        return max(found) if found else None

    def section_intervals(self,name,center,tangent,lateral,extent=.5):
        """Exact triangle intersections with a short line crossing a region seam."""
        surface=self.surface(name)
        if not surface:return []
        tx,tz=tangent;nx,nz=-tz,tx;intervals=[]
        for triangle in surface['triangles']:
            projected=[((v[0]-center[0])*tx+(v[2]-center[1])*tz,
                        (v[0]-center[0])*nx+(v[2]-center[1])*nz) for v in triangle]
            if min(v[1] for v in projected)>lateral or max(v[1] for v in projected)<lateral:continue
            hits=[]
            for a,b in zip(projected,projected[1:]+projected[:1]):
                if a[1]==lateral:hits.append(a[0])
                if (a[1]<lateral<b[1]) or (b[1]<lateral<a[1]):
                    hits.append(a[0]+(b[0]-a[0])*(lateral-a[1])/(b[1]-a[1]))
            if len(hits)>=2:
                a,b=max(-extent,min(hits)),min(extent,max(hits))
                if b>a:intervals.append([a,b])
        return intervals


def _points(points,spacing=10):
    for a,b in zip(points,points[1:]):
        count=max(1,math.ceil(math.dist(a,b)/spacing))
        for i in range(count):yield [a[c]+(b[c]-a[c])*i/count for c in range(2)]
    yield points[-1]


def audit(final=False):
    plan,plan_evidence=_read(ARTIFACTS/'regional_network_plan.json')
    regions={};readers={};issues=[]
    try:
        for biome,p in plan.items():
            prefix=REGIONS[biome];directory=ARTIFACTS/biome
            registry,registry_evidence=_read(directory/'asset_registry.json')
            human,human_evidence=_read(directory/'human_landuse_validation.json')
            path=ROOT/'public/environments'/f'{biome}.glb';before=path.stat()
            reader=GLB(path);readers[biome]=reader
            names=set(reader.nodes);saved={item['id'] for item in registry['objects']}
            source_meshes=[n for n in reader.doc['nodes'] if 'mesh' in n]
            counts={'objects':len(source_meshes),
                    'triangles':sum(reader.triangle_count(n['mesh']) for n in source_meshes),
                    'uniqueMeshes':len({n['mesh'] for n in source_meshes})}
            buildings=[]
            for settlement in p['settlements']:
                for house in settlement['buildings']:
                    identity=prefix+'/Settlement/'+house['id']
                    record=next((b for b in registry['buildings'] if b['id']==identity),None)
                    parts=record.get('editableComponents',[]) if record else []
                    missing=[name for name in parts if name not in names]
                    buildings.append({'id':identity,'registered':record is not None,'components':len(parts),
                                      'missingComponents':missing,'entryRoute':house['entryRoute']})
                    if not record or not parts or missing:issues.append({'region':biome,'building':identity,'missingComponents':missing})
            routes=[]
            for route in p['routes']:
                name=prefix+'/Network/'+route['id']+('/entry-ramp' if route['type']=='entry' else '/surface')
                missing_points=[point for point in _points(route['points']) if reader.height(name,point) is None]
                row={'id':route['id'],'sourceObject':name,'type':route['type'],'present':name in names,
                     'surfaceSampleSpacingMeters':10,'uncoveredCenterlineSamples':missing_points}
                routes.append(row)
                if not row['present'] or missing_points:issues.append({'region':biome,'route':route['id'],'uncoveredSamples':missing_points})
            fields=[]
            for item in p['fields']:
                name=prefix+'/Agriculture/'+item['id']
                objects=[value for value in names if value.startswith(name+'/')]
                crop_objects=[value for value in objects if any('/'+tag in value for tag in ('crop-','vine-','olive-'))]
                row={'id':item['id'],'crop':item['crop'],'soilPresent':name+'/cultivated-soil' in names,
                     'sourceObjects':len(objects),'modeledCropObjects':len(crop_objects),'accessRoute':item['accessRoute']}
                fields.append(row)
                if not row['soilPresent'] or not crop_objects:issues.append({'region':biome,'field':item['id'],'issue':'Missing soil or actual crop meshes'})
            state=bool(human.get('groundContactsCorrected') and human.get('exportIntegrated'))
            match={key:counts[key]==registry['source'][key] for key in counts}
            # Exporters may split one source mesh by its materials; triangle/object counts and IDs are authoritative.
            missing_names=sorted(saved-names);extra_names=sorted(names-saved)
            if not all(match[k] for k in ('objects','triangles')) or missing_names or extra_names:
                issues.append({'region':biome,'issue':'Export/registry mismatch','countsMatch':match,'missingIds':missing_names,'unregisteredIds':extra_names})
            plan_hash=hashlib.sha256(json.dumps(p,sort_keys=True).encode()).hexdigest()
            if human['planSha256']!=plan_hash:issues.append({'region':biome,'issue':'Applied plan fingerprint mismatch'})
            if final and not state:issues.append({'region':biome,'issue':'Final ground contact export is not confirmed'})
            digest=_sha(path);after=path.stat()
            if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise RuntimeError('Export changed during audit; retry '+biome)
            regions[biome]={'evidenceStatus':'FINAL' if final and state else 'PROVISIONAL',
                           'groundContactsExportConfirmed':state,'actualExport':counts,'sourceRegistry':registry['source'],
                           'countsMatch':match,'registryIdsMatchExport':not missing_names and not extra_names,
                           'buildingCount':len(buildings),'entryCount':sum(r['type']=='entry' for r in routes),
                           'routeCount':len(routes),'fieldCount':len(fields),'buildings':buildings,'routes':routes,'fields':fields,
                           'evidence':[registry_evidence,human_evidence,{'path':path.relative_to(ROOT).as_posix(),
                               'sha256':digest,'bytes':after.st_size,'modifiedNanoseconds':after.st_mtime_ns}]}
            print('BUILT_NETWORK_REGION',biome,counts,'houses',len(buildings),'routes',len(routes),flush=True)
        connections=[]
        for connection in CONNECTIONS:
            x,z=connection['position'];tx,tz=connection['tangent'];length=math.hypot(tx,tz);nx,nz=-tz/length,tx/length
            samples=[];sides=[]
            for biome in connection['regions']:
                candidates=[r for r in plan[biome]['routes'] if connection['id'] in r.get('connections',[])]
                if candidates:
                    road=candidates[0];name=REGIONS[biome]+'/Network/'+road['id']+'/surface'
                    verge=REGIONS[biome]+'/Network/'+road['id']+'/graded-verge'
                else:
                    reservations=json.loads((ARTIFACTS/biome/'landscape_reservations_before_human_layer.json').read_text())
                    old=[r for r in reservations['paths'] if min(math.dist(connection['position'],p) for p in (r['points'][0],r['points'][-1]))<.01]
                    if not old:raise ValueError('No actual source road candidate for connection '+connection['id'])
                    name=old[0]['id'];verge=None
                patch_name=REGIONS[biome]+'/Network/RegionalJoint/'+connection['id']+'/surface'
                patches=[patch_name] if patch_name in readers[biome].nodes else []
                sides.append({'biome':biome,'road':name,'verge':verge,'jointPatches':patches})
            for offset in (-.45,-.225,0,.225,.45):
                point=[x+nx*connection['width']*offset,z+nz*connection['width']*offset]
                heights=[readers[s['biome']].height(s['road'],point) for s in sides]
                fallback=[readers[s['biome']].height(s['verge'],point) if s['verge'] else None for s in sides]
                samples.append({'position':point,'roadHeights':heights,'vergeHeights':fallback,
                                'jointPatchHeights':[readers[s['biome']].height(patch,point) for s in sides for patch in s['jointPatches']],
                                'surfaceHeightDifferenceMeters':abs(heights[0]-heights[1]) if all(v is not None for v in heights) else None})
            center=samples[2];missing=sum(any(v is None for v in s['roadHeights']) for s in samples)
            differences=[s['surfaceHeightDifferenceMeters'] for s in samples if s['surfaceHeightDifferenceMeters'] is not None]
            strip_gaps=[]
            for fraction in (-.49,-.375,-.25,-.125,0,.125,.25,.375,.49):
                lateral=fraction*connection['width'];intervals=[]
                for side in sides:
                    intervals+=readers[side['biome']].section_intervals(side['road'],[x,z],[tx/length,tz/length],lateral)
                    for patch in side['jointPatches']:
                        intervals+=readers[side['biome']].section_intervals(patch,[x,z],[tx/length,tz/length],lateral)
                merged=[]
                for a,b in sorted(intervals):
                    if merged and a<=merged[-1][1]+.0002:merged[-1][1]=max(merged[-1][1],b)
                    else:merged.append([a,b])
                gaps=[];cursor=-.5
                for a,b in merged:
                    if a-cursor>.0002:gaps.append([cursor,a])
                    cursor=max(cursor,b)
                if .5-cursor>.0002:gaps.append([cursor,.5])
                strip_gaps.append({'lateralMeters':lateral,'uncoveredLongitudinalIntervalsMeters':gaps})
            max_gap=max((b-a for section in strip_gaps for a,b in section['uncoveredLongitudinalIntervalsMeters']),default=0)
            row={**connection,'actualSurfaces':sides,'crossSectionSamples':samples,'missingCarriagewaySamples':missing,
                 'centerSurfaceHeightDifferenceMeters':center['surfaceHeightDifferenceMeters'],
                 'maximumCrossSectionHeightDifferenceMeters':max(differences,default=None),
                 'seamStripCoverage':strip_gaps,'maximumOpenSeamMeters':max_gap}
            connections.append(row)
            if center['surfaceHeightDifferenceMeters'] is None or center['surfaceHeightDifferenceMeters']>.04:
                issues.append({'connection':connection['id'],'issue':'Missing center contact or height discontinuity','actual':row})
            if max_gap>.002:issues.append({'connection':connection['id'],'issue':'Open seam between actual carriageway caps','maximumOpenSeamMeters':max_gap})
        totals={key:sum(region[key] for region in regions.values()) for key in ('buildingCount','entryCount','routeCount','fieldCount')}
        expected={'buildingCount':192,'entryCount':192,'routeCount':265,'fieldCount':15}
        if totals!=expected:issues.append({'issue':'Built totals differ from accepted layer','actual':totals,'expected':expected})
        result={'evidenceStatus':'FINAL' if final else 'PROVISIONAL','passes':not issues,'totals':totals,'expectedTotals':expected,
                'regions':regions,'regionalConnections':connections,'issues':issues,'planEvidence':plan_evidence,
                'method':'Read actual GLB mesh instances, semantic IDs, triangle indices and transformed positions; compare saved source registries and sample rendered road surfaces.',
                'limitations':['Provisional evidence must be regenerated after all four final exports.',
                    'Centerline coverage and five samples across each regional join are geometric checks, not a vehicle simulation.',
                    'Recorded SHA-256 values identify the exact audited export and registry bytes.']}
        (ARTIFACTS/'built_network_validation.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print('BUILT_NETWORK_AUDIT',result['evidenceStatus'],json.dumps(totals),'issues',len(issues),flush=True)
        return result
    finally:
        for reader in readers.values():reader.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--final',action='store_true');args=parser.parse_args()
    audit(args.final)
