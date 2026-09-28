"""Speed up Blender's root-reference lookup without changing exported glTF data.

The installed Blender files are never modified. The context patches the live
exporter only for one export and restores the original descriptor afterwards.
"""
from contextlib import contextmanager
import time


class IdentityReferenceIndex:
    """Preserve list.index identity semantics for generated glTF schema objects."""

    def __init__(self, original):
        self.original = original
        self.tables = {}
        self.stats = dict(identity_calls=0, identity_hits=0, appended=0, rebuilds=0, fallback_calls=0)

    def __call__(self, target, obj):
        kind = type(obj)
        # Strings and extension dictionaries use value equality. Their lists
        # are short and retain the exporter's original behavior exactly.
        if kind.__module__ != 'io_scene_gltf2.io.com.gltf2_io' or kind.__eq__ is not object.__eq__:
            self.stats['fallback_calls'] += 1
            return self.original(target, obj)
        self.stats['identity_calls'] += 1
        entry = self.tables.get(id(target))
        if entry is None or entry['length'] != len(target):
            entry = self._index(target)
        found = entry['indices'].get(id(obj))
        if found is not None and (found >= len(target) or target[found] is not obj):
            # Defensively account for external reordering before a lookup hit.
            entry = self._index(target)
            found = entry['indices'].get(id(obj))
        if found is not None:
            self.stats['identity_hits'] += 1
            return found
        index = len(target)
        target.append(obj)
        entry['indices'][id(obj)] = index
        entry['length'] += 1
        self.stats['appended'] += 1
        return index

    def _index(self, target):
        indices = {}
        for index, obj in enumerate(target):
            indices.setdefault(id(obj), index)
        # Holding the exact list also prevents id reuse during this export.
        entry = dict(target=target, indices=indices, length=len(target))
        self.tables[id(target)] = entry
        self.stats['rebuilds'] += 1
        return entry


@contextmanager
def fast_gltf_references():
    from io_scene_gltf2.blender.exp.exporter import GlTF2Exporter
    name = '_GlTF2Exporter__append_unique_and_get_index'
    descriptor = GlTF2Exporter.__dict__[name]
    original = getattr(GlTF2Exporter, name)
    accelerator = IdentityReferenceIndex(original)
    started = time.perf_counter()
    setattr(GlTF2Exporter, name, staticmethod(accelerator))
    try:
        yield accelerator.stats
    finally:
        setattr(GlTF2Exporter, name, descriptor)
        accelerator.stats['elapsed_seconds'] = round(time.perf_counter() - started, 4)
        print('GLTF_REFERENCE_LOOKUP', accelerator.stats, flush=True)
        accelerator.tables.clear()
