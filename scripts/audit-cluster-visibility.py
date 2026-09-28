"""CPU-only geometry inventory for an isolated exact-visibility renderer study."""
from pathlib import Path
from collections import Counter, defaultdict
import hashlib
import json
import mmap
import struct
import time

ROOT = Path(__file__).resolve().parents[1]
WIDTHS = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def family(name):
    if name.startswith("BOT_"):
        return "/".join(name.split("_")[1:2]) + ("/foliage" if "ArticulatedFoliage" in name else "/wood" if "BranchingWood" in name else "/plant")
    if name.startswith("OPEN_FullBotanicalDrift_"):
        return "drift/" + name.split("_")[2]
    if name.startswith("Landuse/"):
        return "/".join(name.split("/")[:2])
    return "other"


def audit(path, shared_geometries):
    start = time.perf_counter()
    with path.open("rb") as f:
        magic, version, total, json_bytes, kind = struct.unpack("<4sIIII", f.read(20))
        assert magic == b"glTF" and version == 2 and kind == 0x4E4F534A
        data = json.loads(f.read(json_bytes))
        binary_bytes, binary_kind = struct.unpack("<II", f.read(8))
        assert binary_kind == 0x004E4942
        binary_offset = 28 + json_bytes
        buffer = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        accessors = data["accessors"]
        accessor_hashes = {}

        def fingerprint(index):
            if index in accessor_hashes:
                return accessor_hashes[index]
            a = accessors[index]
            assert not a.get("sparse"), "Sparse accessors need a decoded-value fingerprint"
            b = data["bufferViews"][a["bufferView"]]
            assert b.get("buffer", 0) == 0
            element_bytes = WIDTHS[a["componentType"]] * COMPONENTS[a["type"]]
            stride = b.get("byteStride", element_bytes)
            offset = binary_offset + b.get("byteOffset", 0) + a.get("byteOffset", 0)
            digest = hashlib.sha256()
            if stride == element_bytes:
                digest.update(memoryview(buffer)[offset:offset + a["count"] * element_bytes])
            else:
                for i in range(a["count"]):
                    digest.update(memoryview(buffer)[offset + i * stride:offset + i * stride + element_bytes])
            value = (a["componentType"], a["type"], a["count"], a.get("normalized", False), digest.hexdigest())
            accessor_hashes[index] = value
            return value

        references = Counter(node["mesh"] for node in data["nodes"] if "mesh" in node)
        local_geometry_ids, content_geometries = {}, {}
        groups = defaultdict(lambda: {"weightedTriangles": 0, "nodes": 0, "definitions": 0, "definitionTriangles": 0})
        top = []
        primitive_instances = weighted_triangles = primitive_definitions = definition_triangles = 0
        for mesh_index, count in references.items():
            mesh = data["meshes"][mesh_index]
            name = mesh.get("name", "")
            triangle_count = 0
            materials = []
            primitive_bounds = []
            for p in mesh["primitives"]:
                assert p.get("mode", 4) == 4 and "indices" in p
                triangle_count += accessors[p["indices"]]["count"] // 3
                t = accessors[p["indices"]]["count"] // 3
                identity = (p["indices"], tuple(sorted(p["attributes"].items())))
                content = (fingerprint(p["indices"]), tuple((key, fingerprint(value)) for key, value in sorted(p["attributes"].items())))
                local_geometry_ids[identity] = t
                content_geometries[content] = t
                shared_geometries[content] = t
                primitive_definitions += 1
                primitive_instances += count
                mat = data["materials"][p["material"]]
                materials.append({"name": mat.get("name"), "doubleSided": mat.get("doubleSided", False), "alphaMode": mat.get("alphaMode", "OPAQUE"), "triangles": t})
                pos = accessors[p["attributes"]["POSITION"]]
                primitive_bounds.append({"min": pos.get("min"), "max": pos.get("max")})
            weighted_triangles += triangle_count * count
            definition_triangles += triangle_count
            group = groups[family(name)]
            group["weightedTriangles"] += triangle_count * count
            group["nodes"] += count
            group["definitions"] += 1
            group["definitionTriangles"] += triangle_count
            top.append({"name": name, "instances": count, "triangles": triangle_count, "weightedTriangles": triangle_count * count, "primitives": len(mesh["primitives"]), "materials": materials, "bounds": primitive_bounds})
        buffer.close()
    top.sort(key=lambda entry: entry["weightedTriangles"], reverse=True)
    return {"file": path.name, "fileBytes": total, "jsonBytes": json_bytes, "binaryBytes": binary_bytes, "sourceNodes": sum(references.values()), "meshDefinitions": len(references), "primitiveDefinitions": primitive_definitions, "primitiveInstances": primitive_instances, "weightedTriangles": weighted_triangles, "definitionTriangles": definition_triangles, "uniqueAccessorGeometryDefinitions": len(local_geometry_ids), "uniqueAccessorGeometryTriangles": sum(local_geometry_ids.values()), "uniqueExactContentGeometries": len(content_geometries), "uniqueExactContentTriangles": sum(content_geometries.values()), "materialDefinitions": len(data["materials"]), "families": dict(sorted(groups.items(), key=lambda row: -row[1]["weightedTriangles"])), "topPrototypes": top[:30], "elapsedSeconds": time.perf_counter() - start}


if __name__ == "__main__":
    shared = {}
    reports = [audit(path, shared) for path in sorted((ROOT / "public/environments").glob("*.glb"))]
    result = {"method": "Read actual current GLB JSON and binary accessors. Geometry identity uses SHA256 of exact ordered accessor element bytes including all semantics, indices, component type, count and normalization; names/materials are not geometry identity. No topology welding, geometric simplification, renderer, browser or GPU is used.", "biomes": reports, "totals": {"sourceNodes": sum(r["sourceNodes"] for r in reports), "primitiveInstances": sum(r["primitiveInstances"] for r in reports), "weightedTriangles": sum(r["weightedTriangles"] for r in reports), "meshDefinitions": sum(r["meshDefinitions"] for r in reports), "primitiveDefinitions": sum(r["primitiveDefinitions"] for r in reports), "uniqueExactContentGeometriesAcrossAllFiles": len(shared), "uniqueExactContentTrianglesAcrossAllFiles": sum(shared.values())}}
    destination = ROOT / "artifacts/four-horizons/loading-profile/exact-visibility-geometry-audit.json"
    destination.write_text(json.dumps(result, indent=2))
    print(json.dumps(result["totals"]))
    for region in reports:
        print(json.dumps({key: region[key] for key in ("file", "uniqueExactContentGeometries", "uniqueExactContentTriangles", "weightedTriangles", "elapsedSeconds", "families")}))
