"""Narrow, count-preserving whole-assembly ground-contact refinements."""


def embed_oasis_palms(scene, registry, ground):
    """Bury exposed shore-palm base rings, moving wood and canopy together.

    The unchanged authored palm prototype starts with a twelve-vertex base ring.
    The correction is derived from its exact transformed perimeter and the same
    triangulated terrain used by the rendered source. Repeat calls are inert.
    """
    import math

    entries = {record['id']: record for record in registry['objects']}
    objects = {obj.name: obj for obj in scene.objects}
    report = []
    for trunk in scene.objects:
        if (trunk.type != 'MESH' or trunk.get('asset_role') != 'branching_wood'
                or not str(trunk.get('prototype_id', '')).startswith('palm/')):
            continue
        center = trunk.matrix_world.translation.copy()
        radius = math.hypot((center.x - 1510) / 150, (-center.y - 1450) / 105)
        if radius > 1.8:
            continue
        ring = [trunk.matrix_world @ trunk.data.vertices[i].co for i in range(12)]
        exposure = max(point.z - ground(point.x, -point.y) for point in ring)
        if exposure <= .04:
            continue
        identity = trunk.name.rsplit('/', 1)[0]
        names = [trunk.name, identity + '/articulated-foliage']
        if not all(name in objects and name in entries for name in names):
            raise RuntimeError('Incomplete palm assembly or registry: ' + identity)
        delta = exposure + .025
        before = []
        for name in names:
            obj = objects[name]
            before.append({'id': name, 'mesh': obj.data.name,
                           'vertices': len(obj.data.vertices), 'polygons': len(obj.data.polygons),
                           'position': [obj.matrix_world.translation.x, obj.matrix_world.translation.z,
                                        -obj.matrix_world.translation.y]})
            transform = obj.matrix_world.copy()
            transform.translation.z -= delta
            obj.matrix_world = transform
            entries[name]['position'] = [transform.translation.x, transform.translation.z,
                                         -transform.translation.y]
            obj['root_contact_refinement'] = 'Whole assembly buried to exact terrain at its base perimeter'
            obj['root_contact_lowered_meters'] = delta
        remaining = max((trunk.matrix_world @ trunk.data.vertices[i].co).z
                        - ground((trunk.matrix_world @ trunk.data.vertices[i].co).x,
                                 -(trunk.matrix_world @ trunk.data.vertices[i].co).y)
                        for i in range(12))
        assert remaining < -.02, (identity, remaining)
        report.append({'id': identity, 'maximumBaseExposureBefore': exposure,
                       'translationY': -delta, 'maximumBaseExposureAfter': remaining,
                       'componentsPreserved': before})
    return {'scope': 'Oasis shore palms within normalized radius1.8 with exposed base perimeter above4cm',
            'assemblies': report, 'objectsMoved': len(report) * 2,
            'geometryCountsChanged': False, 'sourceMeshDataChanged': False}
