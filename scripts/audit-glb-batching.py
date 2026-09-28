"""Read only GLB JSON chunks; inspect exact rendering-state batching barriers."""
import collections
import hashlib
import json
import math
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def transformed_center(center, transform):
    tx, ty, tz, qx, qy, qz, qw, sx, sy, sz = transform
    x, y, z = center[0]*sx, center[1]*sy, center[2]*sz
    ix, iy, iz = qw*x+qy*z-qz*y, qw*y+qz*x-qx*z, qw*z+qx*y-qy*x
    iw = -qx*x-qy*y-qz*z
    return (ix*qw-iw*qx-iy*qz+iz*qy+tx, iy*qw-iw*qy-iz*qx+ix*qz+ty,
            iz*qw-iw*qz-ix*qy+iy*qx+tz)


def audit(path):
    with path.open("rb") as file:
        magic, version, total, length, kind = struct.unpack("<4sIIII", file.read(20))
        assert magic == b"glTF" and version == 2 and kind == 0x4e4f534a
        document = json.loads(file.read(length))
    nodes, meshes, materials, accessors = (document[key] for key in ("nodes", "meshes", "materials", "accessors"))
    assert all("children" not in node and "matrix" not in node for node in nodes), "Flat TRS exports required"
    definitions, material_groups = [], collections.defaultdict(list)
    color_only_groups = collections.defaultdict(list)
    for index, material in enumerate(materials):
        state = {key: value for key, value in material.items() if key not in ("name", "extras")}
        material_groups[canonical(state)].append(index)
        state = json.loads(canonical(state))
        state.get("pbrMetallicRoughness", {}).pop("baseColorFactor", None)
        color_only_groups[canonical(state)].append(index)
    for mesh in meshes:
        primitives = []
        for primitive in mesh["primitives"]:
            attrs = primitive["attributes"]
            position = accessors[attrs["POSITION"]]
            center = tuple((a+b)/2 for a,b in zip(position["min"],position["max"]))
            geometry = (primitive.get("indices"), tuple(sorted(attrs.items())), primitive.get("mode"))
            layout = tuple((name, accessors[index]["componentType"],accessors[index]["type"],accessors[index].get("normalized",False)) for name,index in sorted(attrs.items()))
            primitives.append({"geometry": geometry, "material": primitive.get("material",-1), "layout": layout,
                               "center": center, "triangles": accessors[primitive["indices"]]["count"]//3,
                               "name": mesh.get("name", ""), "extras": mesh.get("extras",{})})
        definitions.append(primitives)
    batches = {}
    weighted_triangles = weighted_primitives = 0
    for node_index, node in enumerate(nodes):
        transform = tuple(node.get("translation",[0,0,0])+node.get("rotation",[0,0,0,1])+node.get("scale",[1,1,1]))
        mirrored = transform[-1]*transform[-2]*transform[-3] < 0
        primitives = definitions[node["mesh"]]
        for primitive in primitives:
            center = transformed_center(primitive["center"], transform)
            cell = (math.floor(center[0]/160),math.floor(center[2]/160))
            extras = {**primitive["extras"],**(node.get("extras",{}) if len(primitives)==1 else {})}
            route_layer = extras.get("route_layer",0) if extras.get("ground_route") is True else None
            material = (primitive["material"], route_layer)
            key = (primitive["geometry"],material,cell,node_index if mirrored else None)
            if key not in batches:
                batches[key] = {"material": material,"cell":cell,"layout":primitive["layout"],"transforms":[],
                                "names":set(),"terrain":False,"mirrored":mirrored,"triangles":primitive["triangles"]}
            batch = batches[key]
            batch["transforms"].append(transform)
            batch["names"].add(primitive["name"])
            batch["terrain"] |= "continuous-terrain" in node.get("name", "")
            weighted_triangles += primitive["triangles"]
            weighted_primitives += 1
    singletons = collections.defaultdict(list)
    repeated = []
    solo = 0
    for batch in batches.values():
        if len(batch["transforms"])==1 and not batch["terrain"] and not batch["mirrored"]:
            singletons[(batch["material"],batch["cell"],batch["layout"])].append(batch)
        else:
            solo += 1
            if len(batch["transforms"])>1 and not batch["mirrored"]:
                repeated.append(batch)
    compatible = collections.defaultdict(list)
    for batch in repeated:
        # Same instance transform multiset: no geometry expansion per instance.
        signature = hashlib.sha256(canonical(sorted(batch["transforms"])).encode()).hexdigest()
        key = (batch["material"],batch["cell"],batch["layout"],signature)
        compatible[key].append(batch)
    candidates = []
    for (material,cell,layout,signature), group in compatible.items():
        if len(group)<2:
            continue
        material_def = materials[material[0]]
        transmission = material_def.get("extensions",{}).get("KHR_materials_transmission",{}).get("transmissionFactor",0)
        opaque = material_def.get("alphaMode","OPAQUE") == "OPAQUE" and not transmission
        candidates.append({"batches":len(group),"instances":len(group[0]["transforms"]),"cell":cell,
                           "material":material_def.get("name"),"materialIndex":material[0],"routeLayer":material[1],
                           "alphaMode":material_def.get("alphaMode","OPAQUE"),"transmissionFactor":transmission,"opaqueCandidate":opaque,
                           "names":sorted(set().union(*(batch["names"] for batch in group))),
                           "weightedTriangles":sum(batch["triangles"]*len(batch["transforms"]) for batch in group)})
    candidates.sort(key=lambda group:(group["batches"]-1,group["weightedTriangles"]),reverse=True)
    return {"file":path.name,"jsonBytesRead":length,"glbBytes":total,"sourceNodes":len(nodes),"meshDefinitions":len(meshes),
            "primitiveDefinitions":sum(len(p) for p in definitions),"weightedPrimitives":weighted_primitives,
            "weightedTriangles":weighted_triangles,"materials":len(materials),
            "strictDuplicateMaterialGroups":[g for g in material_groups.values() if len(g)>1],
            "sameMaterialExtraPrimitives":sum(len(m["primitives"])-len(set(p.get("material") for p in m["primitives"])) for m in meshes),
            "materialsDifferingOnlyInBaseColor":[[{"index":i,"name":materials[i].get("name")} for i in group] for group in color_only_groups.values() if len(group)>1],
            "primitiveBatchesBeforeSingletonMerging":len(batches),"replicatedRuntimeBatchCount":solo+len(singletons),
            "repeatedBatches":len(repeated),"singletonGroups":len(singletons),
            "coinstancedSameMaterialGroups":len(candidates),"coinstancedSameMaterialPotentialBatchReduction":sum(c["batches"]-1 for c in candidates),
            "opaqueCoinstancedGroups":sum(c["opaqueCandidate"] for c in candidates),
            "opaqueCoinstancedPotentialBatchReduction":sum(c["batches"]-1 for c in candidates if c["opaqueCandidate"]),
            "opaqueCoinstancedWeightedTriangles":sum(c["weightedTriangles"] for c in candidates if c["opaqueCandidate"]),
            "coinstancedGroups":candidates}


if __name__ == "__main__":
    results = []
    for file in sorted((ROOT/"public/environments").glob("*.glb")):
        result = audit(file);results.append(result)
        print(json.dumps({key:value for key,value in result.items() if key not in ("coinstancedGroups","materialsDifferingOnlyInBaseColor")}))
        print("TOP_COINSTANCED",json.dumps([{**{k:v for k,v in group.items() if k!="names"},"names":group["names"][:2]} for group in result["coinstancedGroups"][:2]]))
    destination = ROOT/"artifacts/four-horizons/loading-profile/glb-batching-audit.json"
    destination.write_text(json.dumps({"method":"JSON-only primitive identity, accessor min/max, TRS transforms and 160m cells","biomes":results},indent=2))
