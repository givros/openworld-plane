"""Measured source contact corrections; caller owns save, export and inventory."""
import math


def _alpine_junction(ctx):
    import bpy
    import bmesh
    from repair_routes import _intersection, _area, _bounds, _bbox_overlap

    center = (155.0, 1230.0)
    prefix = ctx.region + '/'
    old_names = [prefix + 'ALP_Village_MainLane', prefix + 'ALP_Western_Connector']
    new_prefix = prefix + 'Network/HL_Alpine/EastTerrace/ValleyApproach/'
    # Ten millimetres between overlapping surfaces; the shoulder smoothly joins
    # the common crossing datum and regains its original lower profile outside.
    layers = {new_prefix + 'graded-verge': 0, new_prefix + 'surface': 1,
              old_names[0]: 2, old_names[1]: 3}
    objects = {name: bpy.data.objects[name] for name in layers}
    if all(obj.get('measured_junction_contact_v1') for obj in objects.values()):
        return {'alreadyApplied': True, 'junction': list(center)}
    surfaces = {}
    for name, obj in objects.items():
        vertices = [obj.matrix_world @ v.co for v in obj.data.vertices]
        obj.data.calc_loop_triangles()
        surfaces[name] = []
        for tri in obj.data.loop_triangles:
            if tri.normal.z <= .1:
                continue
            poly = [(vertices[i].x, -vertices[i].y) for i in tri.vertices]
            bounds = _bounds(poly)
            if _bbox_overlap(bounds, (143, 1218, 167, 1242)):
                surfaces[name].append((poly, bounds))
    overlap_points = []
    for old in old_names:
        for new in (new_prefix + 'surface', new_prefix + 'graded-verge'):
            for first, a in surfaces[old]:
                for second, b in surfaces[new]:
                    if not _bbox_overlap(a, b):
                        continue
                    poly = _intersection(first, second)
                    if len(poly) >= 3 and abs(_area(poly)) > 1e-7:
                        overlap_points.extend(poly)
    if not overlap_points:
        raise RuntimeError('Expected measured alpine road overlap was not found')
    overlap_radius = max(math.dist(point, center) for point in overlap_points)
    # Local top facets are refined to <=1 m. The extra1.6m encloses every facet
    # touching the overlap, so all its vertices share an exactly flat datum.
    core_radius = overlap_radius + 1.6
    transition = 12.0
    outer_radius = core_radius + transition
    support_names = {prefix + 'Network/ExistingContactSupport/' + name.split('/')[-1]: layers[name]
                     for name in old_names}
    prepared = []
    plateau_candidates = []
    for name, layer in {**layers, **support_names}.items():
        obj = bpy.data.objects.get(name)
        if obj is None:
            raise RuntimeError('Missing source junction surface/support: ' + name)
        mesh = obj.data
        mesh.calc_loop_triangles()
        before = len(mesh.loop_triangles)
        support = name in support_names
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.verts.ensure_lookup_table()
        tag = bm.verts.layers.float.new('junction_top')
        if support:
            for vertex in bm.verts:
                p = obj.matrix_world @ vertex.co
                vertex[tag] = float(p.z > ctx.ground(p.x, -p.y) + .015)
        else:
            for face in bm.faces:
                if face.normal.z > .1:
                    for vertex in face.verts:
                        vertex[tag] = 1.0
        for _ in range(8):
            edges = []
            for edge in bm.edges:
                if any(vertex[tag] < .999 for vertex in edge.verts):
                    continue
                positions = [obj.matrix_world @ vertex.co for vertex in edge.verts]
                if min(math.dist((p.x, -p.y), center) for p in positions) >= outer_radius + 1:
                    continue
                if math.hypot(positions[1].x - positions[0].x, positions[1].y - positions[0].y) > 1.0:
                    edges.append(edge)
            if not edges:
                break
            bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
        for vertex in bm.verts:
            if vertex[tag] < .999:
                continue
            p = obj.matrix_world @ vertex.co
            if math.dist((p.x, -p.y), center) <= core_radius:
                plateau_candidates.extend([p.z, ctx.ground(p.x, -p.y) + .10])
        prepared.append((obj, bm, tag, layer, before))
    datum = max(plateau_candidates) + .025
    records = []
    for obj, bm, tag, layer, before in prepared:
        inverse = obj.matrix_world.inverted()
        moved = 0
        maximum_raise = 0
        for vertex in bm.verts:
            if vertex[tag] < .999:
                continue
            p = obj.matrix_world @ vertex.co
            distance = math.dist((p.x, -p.y), center)
            if distance >= outer_radius:
                continue
            t = max(0.0, min(1.0, (outer_radius - distance) / transition))
            t = t * t * (3 - 2 * t)
            target = max(p.z, p.z * (1 - t) + (datum + layer * .010) * t)
            maximum_raise = max(maximum_raise, target - p.z)
            moved += abs(target - p.z) > 1e-7
            p.z = target
            vertex.co = inverse @ p
        bmesh.ops.triangulate(bm, faces=[face for face in bm.faces if len(face.verts) > 3])
        # Triangulating a subdivided edge can emit a collinear midpoint triangle.
        # It has exactly zero area; retain every vertex and all positive-area
        # faces while omitting only this newly introduced non-surface record.
        zero_area = [face for face in bm.faces if face.calc_area() == 0]
        if zero_area:
            bmesh.ops.delete(bm, geom=zero_area, context='FACES_ONLY')
        bm.verts.layers.float.remove(tag)
        bm.normal_update()
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.update()
        obj.data.calc_loop_triangles()
        # Blender's stored float32 loop-triangle calculation is the authority
        # used by source/export validation; a collinear sliver can round to zero
        # there even if BMesh's intermediate area calculation was nonzero.
        stored_zero = {tri.polygon_index for tri in obj.data.loop_triangles if tri.area == 0.0}
        if stored_zero:
            cleanup = bmesh.new()
            cleanup.from_mesh(obj.data)
            cleanup.faces.ensure_lookup_table()
            bmesh.ops.delete(cleanup, geom=[cleanup.faces[i] for i in stored_zero], context='FACES_ONLY')
            cleanup.to_mesh(obj.data)
            cleanup.free()
            obj.data.update()
            obj.data.calc_loop_triangles()
        after = len(obj.data.loop_triangles)
        assert after >= before, (obj.name, before, after)
        obj['measured_junction_contact_v1'] = True
        obj['junction_common_datum'] = datum
        obj['junction_plateau_radius'] = core_radius
        obj['junction_surface_layer'] = layer
        records.append({'id': obj.name, 'trianglesBefore': before, 'trianglesAfter': after,
                        'verticesRaised': moved, 'maximumRaiseMeters': maximum_raise,
                        'surfaceLayer': layer, 'omittedZeroAreaSubdivisionTriangles': len(zero_area) + len(stored_zero)})
    return {'junction': list(center), 'overlapRadiusMeters': overlap_radius,
            'plateauRadiusMeters': core_radius, 'transitionMeters': transition,
            'commonDatum': datum, 'surfaceLayerMeters': .010,
            'method': 'Measured overlap plus shared flat crossing and smooth raise-only transitions',
            'objects': records, 'removedObjects': 0, 'originalFacesRefinedWithoutAreaRemoval': True}


def apply_targeted_ground_contact_fixes(ctx, biome):
    if biome == 'alpine-lake':
        return {'alpineJunction': _alpine_junction(ctx)}
    if biome == 'sunstone-oasis':
        import bpy
        from source_contact_repairs import embed_oasis_palms
        return {'oasisPalms': embed_oasis_palms(bpy.context.scene, {'objects': ctx.entries}, ctx.ground)}
    return {}


def finish_alpine_contact_supports(ctx, biome):
    """Supplement the existing plateau with complete local grounded sidewalls.

    Safe after the first final export: no surface vertex is moved, and repeating
    this helper is inert. Existing support geometry outside this junction stays
    intact. The sidewalls follow the exact newly refined source-road boundary.
    """
    if biome != 'alpine-lake':
        return {}
    import bpy
    center = (155.0, 1230.0)
    records = []
    for short_name in ('ALP_Village_MainLane', 'ALP_Western_Connector'):
        road = bpy.data.objects[ctx.region + '/' + short_name]
        support = bpy.data.objects[ctx.region + '/Network/ExistingContactSupport/' + short_name]
        if support.get('complete_junction_support_v1'):
            continue
        if not road.get('measured_junction_contact_v1'):
            raise RuntimeError('Apply the shared alpine junction plateau before its support supplement')
        radius = float(road['junction_plateau_radius']) + 12.0 + 2.0
        source_vertices = [road.matrix_world @ vertex.co for vertex in road.data.vertices]
        edges = {}
        for face in road.data.polygons:
            indices = list(face.vertices)
            for first, second in zip(indices, indices[1:] + indices[:1]):
                a, b = source_vertices[first], source_vertices[second]
                key = tuple(sorted(tuple(round(value, 4) for value in point) for point in (a, b)))
                if key not in edges:
                    edges[key] = [0, a.copy(), b.copy()]
                edges[key][0] += 1
        mesh = support.data
        mesh.calc_loop_triangles()
        before = len(mesh.loop_triangles)
        # Retain all original vertices and all support faces outside the local
        # correction. Local faces are replaced by a finer partition of the same
        # boundary, extended exactly down to the receiving terrain.
        vertices = [tuple(vertex.co) for vertex in mesh.vertices]
        faces = []
        replaced_faces = 0
        for face in mesh.polygons:
            if any(math.dist((vertices[i][0], -vertices[i][1]), center) < radius for i in face.vertices):
                replaced_faces += 1
            else:
                faces.append(tuple(face.vertices))
        boundary_segments = 0
        max_height = 0.0
        for count, a, b in edges.values():
            if count != 1:
                continue
            middle = (a + b) * .5
            if math.dist((middle.x, -middle.y), center) >= radius:
                continue
            bottom_a = ctx.ground(a.x, -a.y) - .05
            bottom_b = ctx.ground(b.x, -b.y) - .05
            if max(a.z - bottom_a, b.z - bottom_b) <= .001:
                continue
            inverse = support.matrix_world.inverted()
            from mathutils import Vector
            points = [a, b, Vector((b.x, b.y, bottom_b)), Vector((a.x, a.y, bottom_a))]
            offset = len(vertices)
            vertices.extend(tuple(inverse @ point) for point in points)
            faces.extend([(offset, offset + 1, offset + 2), (offset, offset + 2, offset + 3)])
            boundary_segments += 1
            max_height = max(max_height, a.z - bottom_a, b.z - bottom_b)
        mesh.clear_geometry()
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        mesh.calc_loop_triangles()
        after = len(mesh.loop_triangles)
        if any(triangle.area < 1e-12 for triangle in mesh.loop_triangles):
            raise RuntimeError('Degenerate supplemental support: ' + support.name)
        assert after >= before, (support.name, before, after)
        support['complete_junction_support_v1'] = True
        records.append({'id': support.name, 'trianglesBefore': before, 'trianglesAfter': after,
                        'localFacesRepartitioned': replaced_faces, 'newBoundarySegments': boundary_segments,
                        'radiusMeters': radius, 'maximumRetainedHeightMeters': max_height,
                        'roadSurfaceMoved': False, 'outsideLocalSupportPreserved': True})
    return {'alpineContactSupportSupplement': records, 'idempotent': True}
