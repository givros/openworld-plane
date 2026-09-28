"""Fresh-open the canyon source and re-render its two affected evidence views."""
import json
import math
import sys
from pathlib import Path
import bpy

sys.path.insert(0, str(Path(__file__).parent))
from build_world import OUT, camera, write_json
from market_plaza_repair import repair_market_plaza
from master_inventory import evaluated_master_inventory, validate_master_inventory

directory = OUT / 'sunstone-oasis'
bpy.ops.wm.open_mainfile(filepath=str(directory / 'Four_Horizons_sunstone_oasis.blend'))
contact = repair_market_plaza()
if not contact.get('idempotent'):
    raise RuntimeError('The canonical source did not already contain the verified repair.')
spec = json.loads((directory / 'scene_spec.json').read_text())
inventory = evaluated_master_inventory()
validate_master_inventory(inventory, spec['source'])
preferences = bpy.context.preferences.addons['cycles'].preferences
preferences.compute_device_type = 'OPTIX'
preferences.get_devices()
for device in preferences.devices:
    device.use = device.type != 'CPU'
if not any(device.use for device in preferences.devices):
    raise RuntimeError('The assigned GPU render slot has no available compute device.')
scene = bpy.context.scene
scene.cycles.device = 'GPU'
records = json.loads((directory / 'inspection_cameras.json').read_text())
outputs = []
for record in records:
    if record['id'] not in ('village', 'human-network'):
        continue
    cam = camera('INSPECT_MarketRepair_' + record['id'], record['camera'], record['target'])
    cam.data.lens = cam.data.sensor_width * scene.render.resolution_y / scene.render.resolution_x / (2 * math.tan(math.radians(record['fov']) / 2))
    scene.camera = cam
    output = 'renders/pass-11-' + record['id'] + '.png'
    scene.render.filepath = str(directory / output)
    bpy.ops.render.render(write_still=True)
    outputs.append({'id': record['id'], 'render': output})
report = {'passes': True, 'freshCanonicalSourceReopened': True, 'sourceInventory': inventory,
          'minimumCrossingGapMeters': contact['currentContact']['minimumGapMeters'],
          'renders': outputs, 'sourceSavedByThisReview': False}
write_json(directory / 'market_plaza_render_validation.json', report)
print('MARKET_SOURCE_VIEWS_READY', json.dumps(report), flush=True)
