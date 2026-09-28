"""Run with Blender --background --python this_file -- --biome ID --pass 1."""
import bpy, sys, os, json, math, argparse, struct, time, subprocess
from pathlib import Path
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).parent))
from scene_kit import Context, terrain, raw_ground, xyz, color

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/four-horizons';PUBLIC=ROOT/'public/environments'
DEFINITIONS=[
 {'id':'verdant-airfield','label':'Verdant Airfield','region':'REG_MEADOW','origin':[-800,-800],'center':{'x':0,'z':0},'landmark':'Windmill and rebuilt flight field','review':{'camera':[-535,150,-235],'target':[-340,5,10],'aircraft':[-280,90,-155]}},
 {'id':'azure-port','label':'Azure Port','region':'REG_PORT','origin':[800,-800],'center':{'x':1600,'z':0},'landmark':'Lighthouse and terracotta waterfront','review':{'camera':[1975,195,-295],'target':[1710,20,0],'aircraft':[1745,105,-235]}},
 {'id':'alpine-lake','label':'Alpine Lake','region':'REG_ALPINE','origin':[-800,800],'center':{'x':0,'z':1600},'landmark':'Glacial lake and mountain watchtower','review':{'camera':[460,290,1040],'target':[-80,72,1590],'aircraft':[245,165,1260]}},
 {'id':'sunstone-oasis','label':'Sunstone Oasis','region':'REG_CANYON','origin':[800,800],'center':{'x':1600,'z':1600},'landmark':'Natural sandstone arch and oasis market','review':{'camera':[1110,260,1100],'target':[1590,45,1540],'aircraft':[1325,150,1320]}},
]
for d in DEFINITIONS:
 x,z=d['origin'];d['bounds']={'minX':x,'maxX':x+1600,'minZ':z,'maxZ':z+1600};d['url']='/environments/'+d['id']+'.glb'
SPATIAL_INTENTS={
 'verdant-airfield':{
  'destination':'Active rural flight field and compact village west of its apron',
  'sequence':'Open runway turf, cultivated parcels, enclosed village lane, orchard and wooded field margins',
  'protectedOpenSpace':'Operational runway and approach corridor; working crop parcels remain visibly cultivated',
  'interstitialTreatment':'Small meadow clearings, field-related hedges and stone margins, layered herbs and flowers, connected irregular copses',
  'scaleAnchor':'360m runway, approximately10m village houses, true botanical-scale groundcover'},
 'azure-port':{
  'destination':'Compact merchant quarters, market and working waterfront beneath a lighthouse',
  'sequence':'Wooded coastal approach, planted park, narrow streets, market opening and broad water view',
  'protectedOpenSpace':'Market circulation, quays, harbor water and moorings',
  'interstitialTreatment':'Coastal grove gradients, scrub and rock groups responding to approaches and shore slope'},
 'alpine-lake':{
  'destination':'Lakeside chalet village with docks and mountain watchtower',
  'sequence':'Wooded foothill approach, glimpses of the lake, chalet lanes, open promenade and exposed high ridge',
  'protectedOpenSpace':'Lake surface, bank access, tower trail and exposed snow summits',
  'interstitialTreatment':'Connected irregular foothill forest with mixed ages, heath and scree above the lower canopy'},
 'sunstone-oasis':{
  'destination':'Courtyard market beside an oasis and an eroded natural stone arch',
  'sequence':'Dry scrub and stony wadi, shaded market alleys, palm grove, open water, arch trail and exposed sandstone',
  'protectedOpenSpace':'Oasis water, courtyard approaches, market use areas and geological silhouettes',
  'interstitialTreatment':'Water-related palm thickets, scrub along dry channels, talus and eroded rock groups; no uniform green pasture'}
}

def write_json(path,data):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(data,indent=2),encoding='utf-8')
def shared_spec():
 PUBLIC.mkdir(parents=True,exist_ok=True);OUT.mkdir(parents=True,exist_ok=True)
 heights=[struct.unpack('f',struct.pack('f',raw_ground(-800+x*10,-800+z*10)))[0] for z in range(321) for x in range(321)]
 (PUBLIC/'terrain.json').write_text(json.dumps({'columns':321,'rows':321,'cellSize':10,'minX':-800,'minZ':-800,'heights':heights,'diagonal':'a-d-b'},separators=(',',':')))
 manifest={'version':1,'name':'Four Horizons','bounds':{'minX':-800,'maxX':2400,'minZ':-800,'maxZ':2400},'waterLevel':-5,'terrain':{'url':'/environments/terrain.json','columns':321,'rows':321,'cellSize':10,'minX':-800,'minZ':-800},'biomes':DEFINITIONS}
 for d in manifest['biomes']:
  registry=OUT/d['id']/'asset_registry.json'
  d['source']=json.loads(registry.read_text())['source'] if registry.exists() else {'objects':0,'triangles':0}
 write_json(PUBLIC/'world-manifest.json',manifest)
 spec={**manifest,'units':'meters','axes':{'runtime':'X east, Y up, Z north','blender':'X east, Y south, Z up'},'scope':{'explicit':['Replace the old world completely','Four different generated biomes','Apply givros-environment-builder to each authored prompt'],'inferred':['Connected 3.2 km square island','Preserve aircraft, controls, inspection and cinematic','Integrate existing flight runtime instead of adding walking application','Detailed stylized daytime architecture and vegetation','All buildings closed exteriors, no interior navigation requested']},'runway':{'bounds':[-12,12,-180,180],'elevation':0,'flightClearance':{'x':[-65,260],'z':[-390,400]}},'terrain':{**manifest['terrain'],'waterLevels':{'ocean':-5,'alpineLake':38,'oasis':19},'edgeFadeMeters':135,'biomeBlendMeters':300},'quality':{'compression':False,'decimation':False,'lod':False,'adaptiveQuality':False,'source':'Original deterministic Blender geometry'},'cameras':'Each region has overview, reverse, and hero cameras; final contact sheet includes 9 views.'}
 spec['cameras']='Thirteen source inspection views per region: aerial, reverse, hero, topdown, street, shore, hero-reverse, transition, village, landscape, ground-cover, human-network and vineyard-ground.'
 spec['regionalComposition']=SPATIAL_INTENTS
 spec['densityReference']={'project':'Create cozy fishing lake scene','observedProperties':['Closely framed clearings','Continuous canopy, understory and groundcover hierarchy','Plants and stones remain present in usable open ground'],'application':'Adapt composition and botanical scale to this flight landscape; reference cell dimensions are not copied.'}
 spec['planningGrid']={'purpose':'Authoring and ownership only; internal borders are not forest walls','north':'+Z','cellSizeMeters':1600,'preservedScaleAnchors':['Existing flight physics and 360m runway','Human-scale replacement architecture'],'boundaryValidation':'Shared terrain sampling plus actual cross-region planting and transition views'}
 write_json(OUT/'scene_spec.json',spec)
 edges=[('REG_MEADOW','REG_PORT',[800,0]),('REG_MEADOW','REG_ALPINE',[0,800]),('REG_PORT','REG_CANYON',[1600,800]),('REG_ALPINE','REG_CANYON',[800,1600])]
 write_json(OUT/'region_graph.json',{'regions':[{'id':d['region'],'biome':d['id'],'bounds':d['bounds']} for d in DEFINITIONS],'connections':[{'id':'CON_'+str(i),'regions':[a,b],'position':[p[0],raw_ground(*p),p[1]],'transitionWidth':300,'type':'continuous terrain / aerial travel'} for i,(a,b,p) in enumerate(edges)]})
 write_json(OUT/'scene_connections.json',{'transform':'All GLBs use shared global X/Y/Z coordinates, identity instance transforms','elevationDatum':'runway zero','connections':[{'regions':[a,b],'at':p,'height':raw_ground(*p)} for a,b,p in edges]})
 # The inhabited network owns actual road crossings and parcel approaches.
 from regional_network_plan import PLAN, CONNECTIONS
 spec['scope']['explicit'] += ['Connected hamlets, villages and city extensions','Vineyards and other agricultural fields beside accessible rural roads','Realistic connected paths and roads following terrain']
 spec['humanLanduse'] = PLAN
 write_json(OUT/'scene_spec.json',spec)
 route_records=[]
 for d in DEFINITIONS:
  reservations=OUT/d['id']/'landscape_reservations.json'
  if reservations.exists():route_records.extend(json.loads(reservations.read_text()).get('paths',[]))
 graph={'regions':[{'id':d['region'],'biome':d['id'],'bounds':d['bounds']} for d in DEFINITIONS],
        'connections':CONNECTIONS,'routes':route_records,
        'destinations':[{'region':owner,'id':s['id'],'position':s['center'],'type':'settlement','buildings':len(s['buildings'])} for owner,p in PLAN.items() for s in p['settlements']],
        'fieldAccess':[{'region':owner,'id':f['id'],'accessRoute':f['accessRoute']} for owner,p in PLAN.items() for f in p['fields']]}
 write_json(OUT/'region_graph.json',graph)
 write_json(OUT/'scene_connections.json',{'transform':'All GLBs share global coordinates with identity transforms','elevationDatum':'runway zero','connections':CONNECTIONS})
 write_json(OUT/'animation_manifest.json',{'environment':'static','reason':'No animated environment systems requested','preservedRuntime':'Existing aircraft, flight effects and atmosphere remain animated.'})

def camera(name,position,target,lens=40):
 data=bpy.data.cameras.new(name);obj=bpy.data.objects.new(name,data);bpy.context.scene.collection.objects.link(obj)
 obj.location=xyz(position);direction=Vector(xyz(target))-obj.location;obj.rotation_euler=direction.to_track_quat('-Z','Y').to_euler();data.lens=lens;data.clip_end=15000;return obj
def lighting():
 scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=20;scene.cycles.use_denoising=True
 scene.render.resolution_x=1280;scene.render.resolution_y=800;scene.render.resolution_percentage=100
 scene.world.color=(.3,.3,.3);scene.world.use_nodes=True;world=scene.world.node_tree.nodes.get('Background');world.inputs[0].default_value=(.43,.59,.72,1);world.inputs[1].default_value=.7
 sun=bpy.data.lights.new('Late morning sun','SUN');sun.energy=2.6;sun.angle=math.radians(12);o=bpy.data.objects.new('Late morning sun',sun);scene.collection.objects.link(o);o.rotation_euler=(.45,-.55,-.6)
 scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast';scene.view_settings.exposure=.35
 # Prefer available local GPU compute, retain CPU correctness when unavailable.
 try:
  prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='OPTIX';prefs.get_devices()
  for dev in prefs.devices:dev.use=dev.type!='CPU'
  if any(dev.use for dev in prefs.devices):scene.cycles.device='GPU'
 except Exception:pass
def inventory(ctx):
 meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
 triangles=0;counts={}
 for o in meshes:
  if o.data.name not in counts:o.data.calc_loop_triangles();counts[o.data.name]=len(o.data.loop_triangles)
  triangles+=counts[o.data.name]
 return {'source':{'objects':len(meshes),'triangles':triangles,'uniqueMeshes':len({o.data.name for o in meshes})},'provenance':'Original authored procedural geometry; no external assets','compression':False,'objects':ctx.entries,'buildings':ctx.buildings}

def build(d,pass_index,blockout=False):
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
 ctx=Context(d['region']);ctx.collection('Terrain');terrain(ctx,d['origin'])
 # Each region contains its matching water tile; their exact edge contact creates one sea.
 x,z=d['origin'];sea_x0=-20000 if x==-800 else 800;sea_x1=20000 if x==800 else 800;sea_z0=-20000 if z==-800 else 800;sea_z1=20000 if z==800 else 800
 ctx.box('ocean',(sea_x0+sea_x1)/2,-5.12,(sea_z0+sea_z1)/2,sea_x1-sea_x0,.2,sea_z1-sea_z0,'water')
 layout={}
 if not blockout:
  if d['id'] in ('verdant-airfield','azure-port'):
   from build_meadow_harbor import build_meadow,build_harbor
   layout=(build_meadow if d['id']=='verdant-airfield' else build_harbor)(ctx) or {}
  else:
   from build_alpine_canyon import build_alpine,build_canyon
   layout=(build_alpine if d['id']=='alpine-lake' else build_canyon)(ctx) or {}
 lighting();review=d['review'];overview=camera('CAM_Aerial',review['camera'],review['target'])
 c=d['center'];reverse=camera('CAM_Reverse',[c['x']-520,340,c['z']+540],[c['x'],35,c['z']],42)
 # Stable close views deliberately show facade assemblies and vegetation at aircraft inspection distance.
 details={
 'verdant-airfield':([-371,3,-143],[-384,3.5,-127]),
 'azure-port':([1683,12,-179],[1697,14,-165]),
 'alpine-lake':([308,54,1355],[276,53,1365]),
 'sunstone-oasis':([1760,72,1390],[1830,80,1550])}
 p,t=details[d['id']];hero=camera('CAM_Hero',p,t,38)
 dir=OUT/d['id'];dir.mkdir(parents=True,exist_ok=True)
 for child in ('renders','checkpoints','references','comparisons'): (dir/child).mkdir(exist_ok=True)
 registry=inventory(ctx);write_json(dir/'asset_registry.json',registry)
 write_json(dir/'scene_spec.json',{**d,'units':'meters','buildings':ctx.buildings,'layout':layout,'environment_layout':getattr(ctx,'environment_layout',{}),'source':registry['source'],'navigation':'Existing aircraft game integration; closed building exteriors','palette':'scene_kit.py::PALETTE'})
 write_json(dir/'animation_manifest.json',{'static':True,'reason':'No environment animation requested'})
 bpy.context.scene.camera=overview
 bpy.ops.wm.save_as_mainfile(filepath=str(dir/('checkpoints/blockout.blend' if blockout else 'Four_Horizons_'+d['id'].replace('-','_')+'.blend')),compress=False)
 if not blockout:
  from fast_gltf_export import fast_gltf_references
  with fast_gltf_references():
   bpy.ops.export_scene.gltf(filepath=str(PUBLIC/(d['id']+'.glb')),export_format='GLB',use_selection=False,export_cameras=False,export_lights=False,export_animations=False,export_yup=True,export_apply=False,export_extras=True,export_texcoords=True,export_normals=True,export_materials='EXPORT',export_draco_mesh_compression_enable=False)
 for name,cam in [('aerial',overview),('reverse',reverse),('hero',hero)]:
  bpy.context.scene.camera=cam;bpy.context.scene.render.filepath=str(dir/'renders'/f'pass-{pass_index}-{name}.png');bpy.ops.render.render(write_still=True)
 print('REGION_FINISHED',d['id'],json.dumps(registry['source']),flush=True)

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--biome');parser.add_argument('--pass',dest='pass_index',type=int,default=1);parser.add_argument('--blockout',action='store_true');parser.add_argument('--manifest',action='store_true')
 args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
 if args.manifest:shared_spec();return
 if not args.biome:
  for d in DEFINITIONS:
   command=[bpy.app.binary_path,'--background','--python',str(Path(__file__).resolve()),'--','--biome',d['id'],'--pass',str(args.pass_index)]
   if args.blockout:command.append('--blockout')
   subprocess.run(command,check=True,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
  shared_spec();return
 for d in DEFINITIONS:
  if not args.biome or d['id']==args.biome:build(d,args.pass_index,args.blockout)
 shared_spec()
if __name__=='__main__':main()
