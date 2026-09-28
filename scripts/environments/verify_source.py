"""Reopen final Blender sources, inspect geometry, and render thirteen evidence views."""
import bpy,sys,json,math
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from build_world import ROOT,OUT,DEFINITIONS,camera,write_json
from scene_kit import ground,xyz
from mathutils import Vector

heroes={
 'verdant-airfield':([-365,5,-151],[-384,4,-127]),
 'azure-port':([1683,12,-179],[1697,14,-165]),
 'alpine-lake':([221,50,1417],[210,53.1,1438]),
 'sunstone-oasis':([1320,32,1604],[1312.1,33.5,1623])}
streets={
 'verdant-airfield':([-370,2,-148],[-370,3,-70]),
 'azure-port':([1743,11,-174],[1743,13,-111]),
 'alpine-lake':([221,49.7,1402],[221,50,1484]),
 'sunstone-oasis':([1336,31.7,1610],[1336,32,1692])}
shores={
 'verdant-airfield':([412,20,-430],[470,4,-560]),
 'azure-port':([1880,16,-120],[1830,13,95]),
 'alpine-lake':([144.539,43.458,1515.847],[-100,41,1510]),
 'sunstone-oasis':([1575.399,26.45,1523.082],[1390,28,1565])}

def verify(d,pass_index=6):
 directory=OUT/d['id'];source=directory/('Four_Horizons_'+d['id'].replace('-','_')+'.blend')
 bpy.ops.wm.open_mainfile(filepath=str(source));scene=bpy.context.scene
 try:
  prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='OPTIX';prefs.get_devices()
  for device in prefs.devices:device.use=device.type!='CPU'
  if any(device.use for device in prefs.devices):scene.cycles.device='GPU'
 except Exception:pass
 inventory=json.loads((directory/'asset_registry.json').read_text());meshes=[o for o in scene.objects if o.type=='MESH']
 actual=0;invalid=[];zero=[];checked=set();triangle_counts={}
 for obj in meshes:
  if obj.data.name not in triangle_counts:obj.data.calc_loop_triangles();triangle_counts[obj.data.name]=len(obj.data.loop_triangles)
  actual+=triangle_counts[obj.data.name]
  if obj.data.name in checked:continue
  checked.add(obj.data.name)
  for v in obj.data.vertices:
   if not all(math.isfinite(a) for a in v.co):invalid.append(obj.name);break
  for tri in obj.data.loop_triangles:
   if tri.area<1e-12:zero.append(obj.name);break
 checks={'reopened':True,'objects':len(meshes),'triangles':actual,'expected':inventory['source'],'sourceCountsMatch':len(meshes)==inventory['source']['objects'] and actual==inventory['source']['triangles'],'nonfiniteMeshes':invalid,'degenerateMeshes':zero,'externalImages':[im.filepath for im in bpy.data.images if im.filepath and not im.packed_file and im.source=='FILE']}
 if not checks['sourceCountsMatch'] or invalid:raise RuntimeError(json.dumps(checks))
 c=d['center'];r=d['review'];p,t=heroes[d['id']]
 scene.objects['CAM_Hero'].location=xyz(p);scene.objects['CAM_Hero'].rotation_euler=(Vector(xyz(t))-Vector(xyz(p))).to_track_quat('-Z','Y').to_euler()
 views=[('aerial',scene.objects['CAM_Aerial']),('reverse',scene.objects['CAM_Reverse']),('hero',scene.objects['CAM_Hero'])]
 top=camera('CAM_Topdown',[c['x'],1700,c['z']+.1],[c['x'],0,c['z']],42);top.data.type='ORTHO';top.data.ortho_scale=1750;views.append(('topdown',top))
 for name,pair in [('street',streets[d['id']]),('shore',shores[d['id']])]:
  eye=list(pair[0]);eye[1]=max(eye[1],ground(eye[0],eye[2])+3)
  views.append((name,camera('CAM_'+name,eye,pair[1],32)))
 # Opposite hero viewpoint, biome boundary approach, and a village overview.
 reversep=[t[0]+(t[0]-p[0])*1.3,max(t[1]+15,p[1]),t[2]+(t[2]-p[2])*1.3]
 # The rear garden now contains full tree crowns. Inspect the same house from
 # the opposite direction along its street, with a clear facade sightline.
 if d['id']=='verdant-airfield':reversep=[-369,12,-103]
 reversep[1]=max(reversep[1],ground(reversep[0],reversep[2])+12)
 views.append(('hero-reverse',camera('CAM_HeroReverse',reversep,t,38)))
 views.append(('transition',camera('CAM_Transition',[c['x']+560,160,c['z']-540],[c['x']+170,35,c['z']-150],38)))
 villages={'alpine-lake':([330,128,1320],[242,52,1460]),'sunstone-oasis':([1475,102,1556],[1370,32,1650]),
           'verdant-airfield':([-498,85,-164],[-366,3,-10]),'azure-port':([1837,93,-216],[1730,18,-55])}
 p,t=villages[d['id']];views.append(('village',camera('CAM_Village',p,t,40)))
 # Explicit evidence for the user's rejected empty interstitial grass plains.
 landscape_views={
  'verdant-airfield':([340,46,-248],[472,5,-153]),
  'azure-port':([1450,58,-335],[1534,10,-248]),
  'alpine-lake':([105,108,1205],[-62,55,1210]),
  'sunstone-oasis':([1535,92,1855],[1640,38,1790])}
 close_views={
  'verdant-airfield':([302,3,22],[324,1,51]),
  'azure-port':([1528,12,-280],[1554,10,-253]),
  'alpine-lake':([65,53,1200],[85,52,1224]),
  'sunstone-oasis':([1544,40,1795],[1570,38,1825])}
 network_views={
  'verdant-airfield':([510,115,-425],[380,0,-285]),
  'azure-port':([1535,125,340],[1400,10,460]),
  'alpine-lake':([590,220,970],[280,52,1280]),
  'sunstone-oasis':([1565,145,1925],[1335,34,1755])}
 agriculture_views={
  'verdant-airfield':([437,2,277],[460,2,306]),
  'azure-port':([1166,12,446],[1190,11,480]),
  'alpine-lake':([-215,2,915],[-175,1,1010]),
  'sunstone-oasis':([1014,2,1915],[980,1,1740])}
 for name,pair in [('landscape',landscape_views[d['id']]),('ground-cover',close_views[d['id']]),
                   ('human-network',network_views[d['id']]),('vineyard-ground',agriculture_views[d['id']])]:
  p,t=map(list,pair);p[1]=max(p[1],ground(p[0],p[2])+(2 if name in ('ground-cover','vineyard-ground') else 35))
  t[1]=ground(t[0],t[2])+1
  views.append((name,camera('CAM_'+name,p,t,32)))
 bpy.ops.wm.save_as_mainfile(filepath=str(source),compress=False)
 for name,cam in views:
  scene.camera=cam;scene.render.filepath=str(directory/'renders'/(f'pass-{pass_index}-'+name+'.png'));bpy.ops.render.render(write_still=True)
 checks['renders']=[f'renders/pass-{pass_index}-'+name+'.png' for name,_ in views];write_json(directory/'source_validation.json',checks)
 view_records=[]
 for name,cam in views:
  forward=cam.rotation_euler.to_quaternion() @ Vector((0,0,-1));target=cam.location+forward*20
  runtime=lambda p:[p.x,p.z,-p.y]
  view_records.append({'id':name,'camera':runtime(cam.location),'target':runtime(target),
   'fov':math.degrees(2*math.atan(cam.data.sensor_width*scene.render.resolution_y/scene.render.resolution_x/(2*cam.data.lens))),
   'orthographic':cam.data.type=='ORTHO','source':f'renders/pass-{pass_index}-{name}.png'})
 write_json(directory/'inspection_cameras.json',view_records)
 print('SOURCE_VERIFIED',d['id'],json.dumps({k:v for k,v in checks.items() if k!='renders'}),flush=True)

requested=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
pass_index=6
if '--pass' in requested:
 index=requested.index('--pass');pass_index=int(requested[index+1]);del requested[index:index+2]
for definition in DEFINITIONS:
 if not requested or definition['id'] in requested:verify(definition,pass_index)
