"""Save and export only the verified canyon market-path elevation correction."""
import hashlib
import json
import os
import sys
from array import array
from pathlib import Path
import bpy

sys.path.insert(0, str(Path(__file__).parent))
from build_world import OUT, PUBLIC, write_json
from fast_gltf_export import fast_gltf_references
from market_plaza_repair import PATH, PLAZA, repair_market_plaza, source_geometry, contact_audit, audit_export, compare_unaffected_export


def protected_attributes(mesh):
    digest = hashlib.sha256()
    digest.update(str([(p.loop_start, p.loop_total, p.material_index) for p in mesh.polygons]).encode())
    digest.update(str([loop.vertex_index for loop in mesh.loops]).encode())
    for attr in mesh.attributes:
        if attr.name in ('position', '.edge_verts', '.corner_vert', '.corner_edge'):
            continue
        prop, size = ('vector', 3) if attr.data_type == 'FLOAT_VECTOR' else ('color', 4) if attr.data_type in ('FLOAT_COLOR', 'BYTE_COLOR') else ('vector', 2) if attr.data_type == 'FLOAT2' else ('value', 1)
        code = 'f' if attr.data_type in ('FLOAT_VECTOR', 'FLOAT_COLOR', 'BYTE_COLOR', 'FLOAT2', 'FLOAT') else 'i'
        values = array(code, [0]) * (len(attr.data) * size)
        attr.data.foreach_get(prop, values)
        digest.update(attr.name.encode()); digest.update(values.tobytes())
    digest.update(str([m.name for m in mesh.materials]).encode())
    return digest.hexdigest()


directory = OUT / 'sunstone-oasis'
source = directory / 'Four_Horizons_sunstone_oasis.blend'
pending_source = directory / 'Four_Horizons_sunstone_oasis.market-pending.blend'
pending_glb = directory / 'sunstone-oasis.market-pending.glb'
canonical_glb = PUBLIC / 'sunstone-oasis.glb'
bpy.ops.wm.open_mainfile(filepath=str(source))
objects = {o.name: o for o in bpy.context.scene.objects}
target = objects[PATH]
before_attributes = protected_attributes(target.data)
before_counts = (len(target.data.vertices), len(target.data.polygons))
before_names = sorted(objects)
report = repair_market_plaza()
if protected_attributes(target.data) != before_attributes or before_counts != (len(target.data.vertices), len(target.data.polygons)):
    raise RuntimeError('The targeted repair changed protected topology, UVs or material assignments.')
if sorted(o.name for o in bpy.context.scene.objects) != before_names:
    raise RuntimeError('The targeted repair changed source object identities.')
report['protectedSourceAttributesSha256'] = before_attributes
report['protectedSourceAttributesPreserved'] = True
report['idempotenceVerified'] = repair_market_plaza().get('idempotent') is True
write_json(directory / 'market_plaza_contact_validation.json', {**report, 'sourceApplied': False, 'exportIntegrated': False})
bpy.ops.wm.save_as_mainfile(filepath=str(pending_source), compress=False)
bpy.ops.wm.open_mainfile(filepath=str(pending_source))
fresh = repair_market_plaza()
if not fresh.get('idempotent'):
    raise RuntimeError('The reopened source was not already repaired.')
if protected_attributes(bpy.context.scene.objects[PATH].data) != before_attributes:
    raise RuntimeError('Protected source attributes changed when reopening.')
os.replace(pending_source, source)
report.update(sourceApplied=True, exportIntegrated=False, freshSourceReopenVerified=True)
human_path = directory / 'human_landuse_validation.json'
human = json.loads(human_path.read_text())
human['exportIntegrated'] = False
write_json(human_path, human)
write_json(directory / 'market_plaza_contact_validation.json', report)
print('BLEND_SAVED', source, flush=True)
with fast_gltf_references():
    bpy.ops.export_scene.gltf(filepath=str(pending_glb), export_format='GLB', use_selection=False,
                            export_cameras=False, export_lights=False, export_animations=False,
                            export_yup=True, export_apply=False, export_extras=True,
                            export_texcoords=True, export_normals=True, export_materials='EXPORT',
                            export_draco_mesh_compression_enable=False)
report['exportContact'] = audit_export(pending_glb)
if not report['exportContact']['passes']:
    raise RuntimeError('Exported market contact is not strictly separated.')
report['exportPreservation'] = compare_unaffected_export(canonical_glb, pending_glb)
os.replace(pending_glb, canonical_glb)
report.update(exportIntegrated=True, affectedSourceViewsStatus='pending',
              affectedSourceViews=['village', 'human-network'])
human.update(exportIntegrated=True, marketPlazaContactCorrected=True)
write_json(human_path, human)
spec_path = directory / 'scene_spec.json'
spec = json.loads(spec_path.read_text())
spec['humanLanduse']['built'] = human
spec['marketPlazaContact'] = 'market_plaza_contact_validation.json'
write_json(spec_path, spec)
ground_path = directory / 'ground_contact_validation.json'
ground = json.loads(ground_path.read_text())
ground['marketPlazaContact'] = report
write_json(ground_path, ground)
write_json(directory / 'market_plaza_contact_validation.json', report)
print('GLB_READY', json.dumps(report['exportContact']), flush=True)
