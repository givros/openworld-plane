"""Read-only GLB and synthetic validation for terrain-conforming legacy routes."""
import argparse
import json
import math
import mmap
import struct
from pathlib import Path

from regional_network_helpers import ARTIFACTS,ROOT,ground_function
from terrain_fit_paths import fit_mesh


def fixture_audit():
    def ground(x,z):
        # Same cell/diagonal topology, deliberately different adjacent gradients.
        x0=math.floor(x/10)*10;z0=math.floor(z/10)*10
        tx=(x-x0)/10;tz=(z-z0)/10
        raw=lambda x,z:math.sin(x*.31)*2+math.cos(z*.23)*1.5
        a=raw(x0,z0);b=raw(x0,z0+10);d=raw(x0+10,z0)
        if tx+tz<=1:return a+(d-a)*tx+(b-a)*tz
        c=raw(x0+10,z0+10)
        return c+(b-c)*(1-tx)+(d-c)*(1-tz)
    records=[]
    for name,points,raise_by in (
        ('crossed-grid-and-diagonal',[(-4,-3),(23,4),(12,27)],0),
        ('existing-raised-contact',[(-4,-3),(23,4),(12,27)],3.6),
        ('grid-edge',[(-10,0),(10,0),(0,10)],0),
        ('negative-coordinates',[(-37,-41),(-11,-26),(-33,-12)],0)):
        vertices=[(x,ground(x,z)+.08+(raise_by if i==1 else 0),z) for i,(x,z) in enumerate(points)]
        result=fit_mesh(vertices,[(0,1,2)],ground)
        report=result['report'];report['id']=name
        assert abs(report['projectedAreaDifference'])<1e-7,report
        assert report['continuousContactProven'],report
        assert report['maxOriginalPlaneLossMeters']<1e-8,report
        assert report['float32ZeroAreaTriangles']==0,report
        # Sample actual output triangles, independently from the clipping proof.
        worst=math.inf
        for face in result['faces']:
            triangle=[result['vertices'][i] for i in face]
            for weights in ((1/3,1/3,1/3),(.7,.2,.1),(.1,.7,.2),(.2,.1,.7)):
                x,y,z=[sum(p[c]*w for p,w in zip(triangle,weights)) for c in range(3)]
                worst=min(worst,y-ground(x,z))
        assert worst>=.08-1e-8,(name,worst)
        report['minimumInteriorSampleClearanceMeters']=worst
        records.append(report)
    return {'passes':True,'fixtures':records}


def _multiply(a,b):
    return [sum(a[r+4*k]*b[k+4*c] for k in range(4)) for c in range(4) for r in range(4)]


def _node_matrix(node):
    if 'matrix' in node:return node['matrix']
    x,y,z,w=node.get('rotation',[0,0,0,1]);sx,sy,sz=node.get('scale',[1,1,1]);tx,ty,tz=node.get('translation',[0,0,0])
    return [(1-2*(y*y+z*z))*sx,2*(x*y+z*w)*sx,2*(x*z-y*w)*sx,0,
            2*(x*y-z*w)*sy,(1-2*(x*x+z*z))*sy,2*(y*z+x*w)*sy,0,
            2*(x*z+y*w)*sz,2*(y*z-x*w)*sz,(1-2*(x*x+y*y))*sz,0,tx,ty,tz,1]


def audit_glb(path):
    ground=ground_function();reports=[]
    with path.open('rb') as handle,mmap.mmap(handle.fileno(),0,access=mmap.ACCESS_READ) as data:
        magic,version,total=struct.unpack_from('<4sII',data,0)
        assert magic==b'glTF' and version==2
        json_length,json_type=struct.unpack_from('<II',data,12)
        document=json.loads(data[20:20+json_length]);binary_offset=20+json_length+8
        def accessor(index):
            a=document['accessors'][index];view=document['bufferViews'][a['bufferView']]
            count={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
            code={5120:'b',5121:'B',5122:'h',5123:'H',5125:'I',5126:'f'}[a['componentType']]
            format='<'+code*count;size=struct.calcsize(format);stride=view.get('byteStride',size)
            offset=binary_offset+view.get('byteOffset',0)+a.get('byteOffset',0)
            return [struct.unpack_from(format,data,offset+i*stride) for i in range(a['count'])]
        parents={child:index for index,node in enumerate(document['nodes']) for child in node.get('children',[])}
        transforms={}
        def transform(index):
            if index not in transforms:
                own=_node_matrix(document['nodes'][index])
                transforms[index]=_multiply(transform(parents[index]),own) if index in parents else own
            return transforms[index]
        for index,node in enumerate(document['nodes']):
            if not node.get('extras',{}).get('ground_route') or '/Network/' in node.get('name',''):continue
            matrix=transform(index)
            for primitive in document['meshes'][node['mesh']]['primitives']:
                positions=accessor(primitive['attributes']['POSITION'])
                vertices=[tuple(sum(matrix[c+4*k]*p[k] for k in range(3))+matrix[c+12] for c in range(3)) for p in positions]
                indices=[x[0] for x in accessor(primitive['indices'])] if 'indices' in primitive else list(range(len(vertices)))
                triangles=[indices[i:i+3] for i in range(0,len(indices),3)]
                result=fit_mesh(vertices,triangles,ground)
                report={'id':node['name'],**result['report'],'sourceAttributes':list(primitive['attributes']),
                        'sourceMaterialIndex':primitive.get('material')};reports.append(report)
                print(json.dumps({'id':node['name'],'before':report['maxPreviousPenetrationMeters'],'triangles':report['resultTriangles'],'float32Zero':report['float32ZeroAreaTriangles']}),flush=True)
    return {'source':str(path),'sourceBytes':path.stat().st_size,'readOnly':True,
            'method':'Actual exported GLB positions and hierarchy; pure clipping against exact source terrain',
            'objects':len(reports),'addedTriangles':sum(r['addedTriangles'] for r in reports),
            'maxPreviousPenetrationMeters':max((r['maxPreviousPenetrationMeters'] for r in reports),default=0),
            'maxAreaDifferenceSquareMeters':max((abs(r['projectedAreaDifference']) for r in reports),default=0),
            'float32ZeroAreaTriangles':sum(r['float32ZeroAreaTriangles'] for r in reports),
            'float32InvertedTriangles':sum(r['float32InvertedTriangles'] for r in reports),
            'maxRemainingPenetrationMeters':max((r['maxRemainingPenetrationMeters'] for r in reports),default=0),
            'maxOriginalPlaneLossMeters':max((r['maxOriginalPlaneLossMeters'] for r in reports),default=0),
            'minimumClearanceMeters':min((r['minimumClearanceMeters'] for r in reports),default=None),
            'routes':reports}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--biome',default='alpine-lake');parser.add_argument('--fixture-only',action='store_true')
    args=parser.parse_args();report={'fixture':fixture_audit()}
    if not args.fixture_only:report['actualSource']=audit_glb(ROOT/'public/environments'/f'{args.biome}.glb')
    out=ARTIFACTS/args.biome/'terrain_route_fit_readonly_validation.json';out.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print('TERRAIN_ROUTE_FIT_READONLY',str(out),flush=True)
