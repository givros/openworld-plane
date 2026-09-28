import bpy,sys
from pathlib import Path
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).parent))
from build_world import OUT
from scene_kit import ground,xyz
poses={'alpine-lake':([145,49,1510],[-110,38,1490]),'sunstone-oasis':([1460,25,1310],[1510,20,1470])}
for name in sys.argv[sys.argv.index('--')+1:]:
    p,t=poses[name];p[1]=max(p[1],ground(p[0],p[2])+3)
    source=OUT/name/('Four_Horizons_'+name.replace('-','_')+'.blend')
    bpy.ops.wm.open_mainfile(filepath=str(source))
    scene=bpy.context.scene;cam=scene.objects['CAM_shore'];cam.location=xyz(p)
    cam.rotation_euler=(Vector(xyz(t))-cam.location).to_track_quat('-Z','Y').to_euler();scene.camera=cam
    try:
        prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='OPTIX';prefs.get_devices()
        for device in prefs.devices:device.use=device.type!='CPU'
        if any(device.use for device in prefs.devices):scene.cycles.device='GPU'
    except Exception:pass
    bpy.ops.wm.save_as_mainfile(filepath=str(source),compress=False)
    scene.render.filepath=str(OUT/name/'renders/pass-4-shore.png');bpy.ops.render.render(write_still=True)
    print('SHORE_CAMERA_FIXED',name,p,flush=True)
