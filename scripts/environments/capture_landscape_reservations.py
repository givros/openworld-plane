"""Capture actual source reservations before adding full landscape ground cover."""
import json
from pathlib import Path
from audit_rebuild_layout import AuditCapture
from draw_layout import load_ground
from build_meadow_harbor import build_meadow, build_harbor
from build_alpine_canyon import build_alpine, build_canyon
from landmark_reservations import augment_landmark_reservations

ROOT = Path(__file__).resolve().parents[2] / 'artifacts/four-horizons'
for biome, region, builder in [
    ('verdant-airfield', 'REG_MEADOW', build_meadow),
    ('azure-port', 'REG_PORT', build_harbor),
    ('alpine-lake', 'REG_ALPINE', build_alpine),
    ('sunstone-oasis', 'REG_CANYON', build_canyon),
]:
    capture = AuditCapture(region, load_ground())
    builder(capture)
    record = dict(buildings=capture.buildings, paths=capture.paths, fields=capture.fields,
                  structures=capture.structures + capture.extra_obstacles,
                  water=capture.water, trees=capture.planting)
    augment_landmark_reservations(record, biome)
    (ROOT / biome / 'landscape_reservations.json').write_text(json.dumps(record, indent=2))
    print(biome, {key: len(value) for key, value in record.items()}, flush=True)
