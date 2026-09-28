"""Render the verified editable master when the local GPU is available."""
import json
import sys
import time
from pathlib import Path
import bpy

sys.path.insert(0, str(Path(__file__).parent))
from build_world import OUT, write_json
from master_inventory import evaluated_master_inventory, validate_master_inventory

bpy.ops.wm.open_mainfile(filepath=str(OUT / 'Four_Horizons.blend'))
preferences = bpy.context.preferences.addons['cycles'].preferences
preferences.compute_device_type = 'OPTIX'
preferences.get_devices()
for device in preferences.devices:
    device.use = device.type != 'CPU'
if any(device.use for device in preferences.devices):
    bpy.context.scene.cycles.device = 'GPU'
report = json.loads((OUT / 'master_validation.json').read_text())
inventory = evaluated_master_inventory()
validate_master_inventory(inventory, report)
actual = inventory['objects']
if '--wait-for-gpu' in sys.argv:
    marker = Path(sys.argv[sys.argv.index('--wait-for-gpu') + 1])
    print('MASTER_LOADED_WAITING_FOR_GPU', str(marker), flush=True)
    deadline = time.monotonic() + 3600
    while not marker.exists():
        if time.monotonic() > deadline:
            raise RuntimeError('The local GPU render slot was not released.')
        time.sleep(2)
bpy.context.scene.render.filepath = str(OUT / 'renders/master-overview.png')
bpy.ops.render.render(write_still=True)
report.update(render='renders/master-overview.png', renderStatus='complete', reopenedForRender=True, freshProcessInventory=inventory)
write_json(OUT / 'master_validation.json', report)
print('MASTER_RENDER_VERIFIED', actual, flush=True)
