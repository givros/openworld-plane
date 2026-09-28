"""CPU-only identity and byte-equivalence checks for the local exporter adapter."""
from pathlib import Path
import hashlib
import json
import random
import sys
import time
import bpy

sys.path.insert(0,str(Path(__file__).parent))
from fast_gltf_export import IdentityReferenceIndex,fast_gltf_references
from io_scene_gltf2.io.com import gltf2_io
from io_scene_gltf2.blender.exp.exporter import GlTF2Exporter

OUT=Path(__file__).resolve().parents[2]/'artifacts/four-horizons/comparisons/exporter-audit'
OUT.mkdir(parents=True,exist_ok=True)
name='_GlTF2Exporter__append_unique_and_get_index'
original=getattr(GlTF2Exporter,name)
objects=[object.__new__(gltf2_io.Node) for _ in range(12000)]
rng=random.Random(617)
sequence=objects+[rng.choice(objects) for _ in range(5000)]
baseline=[];started=time.perf_counter()
expected=[original(baseline,obj) for obj in sequence]
baseline_seconds=time.perf_counter()-started
accelerator=IdentityReferenceIndex(original);target=[];started=time.perf_counter()
actual=[accelerator(target,obj) for obj in sequence]
accelerated_seconds=time.perf_counter()-started
assert actual==expected and all(a is b for a,b in zip(target,baseline))
strings=['KHR_a','KHR_b',''.join(['KHR','_a'])]
assert [IdentityReferenceIndex(original)([],value) for value in strings]==[0,0,0]
for values in [strings,[{'a':[1,2]},{'a':[2,3]},{'a':[1,2]}]]:
    a=[];b=[];fast=IdentityReferenceIndex(original)
    assert [original(a,value) for value in values]==[fast(b,value) for value in values] and a==b
foreign=object.__new__(gltf2_io.Node);target.append(foreign)
assert accelerator(target,foreign)==len(target)-1
target.reverse()
assert accelerator(target,objects[0])==target.index(objects[0])
descriptor=GlTF2Exporter.__dict__[name]
try:
    with fast_gltf_references():
        raise RuntimeError('intentional context restoration check')
except RuntimeError:
    pass
assert GlTF2Exporter.__dict__[name] is descriptor

bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
material=bpy.data.materials.new('Equivalence stone');material.diffuse_color=(.6,.52,.4,1)
for index in range(256):
    mesh=bpy.data.meshes.new(f'FixtureMesh_{index}')
    height=1+index*.003
    mesh.from_pydata([(0,0,0),(1,0,0),(0,1,0),(0,0,height)],[],[(0,2,1),(0,1,3),(1,2,3),(2,0,3)])
    mesh.materials.append(material)
    obj=bpy.data.objects.new(f'Fixture_{index}',mesh);bpy.context.scene.collection.objects.link(obj)
    obj.location=(index%16*2,index//16*2,0);obj['stable_id']=f'FIX_{index:04d}'
    if index%8==0:
        repeated=bpy.data.objects.new(f'Shared_{index}',mesh);bpy.context.scene.collection.objects.link(repeated);repeated.location=(index%16*2,index//16*2,3)

def export(path):
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=False,export_cameras=False,
        export_lights=False,export_animations=False,export_yup=True,export_apply=False,export_extras=True,
        export_texcoords=True,export_normals=True,export_materials='EXPORT',export_draco_mesh_compression_enable=False)

started=time.perf_counter();export(OUT/'baseline.glb');baseline_export_seconds=time.perf_counter()-started
started=time.perf_counter()
with fast_gltf_references() as export_stats:
    export(OUT/'accelerated.glb')
accelerated_export_seconds=time.perf_counter()-started
a=(OUT/'baseline.glb').read_bytes();b=(OUT/'accelerated.glb').read_bytes()
assert a==b,'Accelerated export must be byte-for-byte identical to stock Blender export.'
report={'identity_sequence_equivalent':True,'value_equality_fallback_equivalent':True,'context_restored_after_exception':True,
    'lookup_count':len(sequence),'lookup_baseline_seconds':baseline_seconds,'lookup_accelerated_seconds':accelerated_seconds,
    'lookup_speedup':baseline_seconds/accelerated_seconds,'byte_identical_export':True,'bytes':len(a),
    'sha256':hashlib.sha256(a).hexdigest(),'export_baseline_seconds':baseline_export_seconds,
    'export_accelerated_seconds':accelerated_export_seconds,'export_stats':export_stats,'fixture_objects':288,
    'geometry_or_material_changes':False,'blender_install_modified':False}
(OUT/'validation.json').write_text(json.dumps(report,indent=2))
print('EXPORT_ACCELERATION_VALIDATED',json.dumps(report),flush=True)
