"""Read-only source previews while the shared road repair is validated."""
import bpy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_world import OUT, camera
from scene_kit import ground

directory = OUT / 'alpine-lake'
bpy.ops.wm.open_mainfile(filepath=str(directory / 'Four_Horizons_alpine_lake.blend'))
scene = bpy.context.scene
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for device in prefs.devices:
        device.use = device.type != 'CPU'
    if any(device.use for device in prefs.devices):
        scene.cycles.device = 'GPU'
except Exception:
    pass

views = [
    ('human-network', [590, 220, 970], [280, ground(280, 1280) + 1, 1280], 32),
    ('pasture-ground', [-215, ground(-215, 915) + 2, 915],
     [-175, ground(-175, 1010) + 1, 1010], 32),
    ('old-road-contact', [167, ground(167, 1210) + 35, 1210],
     [162, ground(162, 1232) + .7, 1232], 36),
]
for name, eye, target, lens in views:
    selected = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if selected and name not in selected:
        continue
    scene.camera = camera('PREVIEW_' + name, eye, target, lens)
    scene.render.filepath = str(directory / 'comparisons' / ('landuse-preview-' + name + '.png'))
    bpy.ops.render.render(write_still=True)
    print('PREVIEW_RENDERED', name, flush=True)
