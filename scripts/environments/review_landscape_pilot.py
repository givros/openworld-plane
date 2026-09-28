"""Matching wide and near-ground evidence for the meadow density correction."""
import sys
from pathlib import Path
import bpy
sys.path.insert(0, str(Path(__file__).parent))
from build_world import OUT, camera
from scene_kit import ground

label = sys.argv[sys.argv.index('--')+1] if '--' in sys.argv else 'after'
directory = OUT/'verdant-airfield'
source = directory/'Four_Horizons_verdant_airfield.blend'
if label == 'before': source = directory/'checkpoints/before-open-landscape.blend'
bpy.ops.wm.open_mainfile(filepath=str(source))
try:
    prefs=bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type='OPTIX';prefs.get_devices()
    for device in prefs.devices: device.use=device.type!='CPU'
    if any(device.use for device in prefs.devices): bpy.context.scene.cycles.device='GPU'
except Exception: pass
views = [
 ('whole-region', [850,580,-930], [-30,5,0]),
 ('landscape', [340,46,-248], [472,ground(472,-153)+1,-153]),
 ('ground-cover', [302,max(3,ground(302,22)+2),22], [324,ground(324,51)+1,51]),
]
for name,p,t in views:
    bpy.context.scene.camera=camera('PILOT_'+name,p,t,32)
    bpy.context.scene.render.filepath=str(directory/'comparisons'/f'landscape-{label}-{name}.png')
    bpy.ops.render.render(write_still=True)
print('LANDSCAPE_PILOT_REVIEW',label,flush=True)
