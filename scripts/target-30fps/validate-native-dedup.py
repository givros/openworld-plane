"""Independent byte-preserving membership check for the GPU raster candidates."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--hits', required=True)
parser.add_argument('--pairs', required=True)
parser.add_argument('--offsets', required=True)
parser.add_argument('--instances', required=True)
parser.add_argument('--metadata')
parser.add_argument('--block-size', type=int, default=1)
parser.add_argument('--output', required=True)
args = parser.parse_args()
hit_bytes = Path(args.hits)
pair_bytes = Path(args.pairs)
if hit_bytes.stat().st_size % 32 or pair_bytes.stat().st_size % 8:
    raise ValueError('Truncated original hit or candidate record')
hits = np.memmap(hit_bytes, dtype='<u4', mode='r').reshape(-1, 8)
pairs = np.fromfile(pair_bytes, dtype='<u4').reshape(-1, 2)
offsets = np.fromfile(args.offsets, dtype='<u4')
instances = np.memmap(args.instances, dtype='<u4', mode='r').reshape(-1, 16)
valid = hits[:, 0] != 0xffffffff
original_pairs = np.ascontiguousarray(hits[valid, :2])
if args.block_size < 1:
    raise ValueError('A source triangle block must contain at least one triangle')
if args.block_size > 1:
    if not args.metadata:
        raise ValueError('Original geometry ranges are required for blocks')
    metadata = np.memmap(args.metadata, dtype='<u4', mode='r').reshape(-1, 4)
    first = metadata[original_pairs[:, 0], 1]
    original_pairs[:, 1] = first + ((original_pairs[:, 1]-first)//args.block_size)*args.block_size
expected = np.unique(original_pairs.view('<u8').reshape(-1))
actual = np.unique(pairs.view('<u8').reshape(-1))
missing = np.setdiff1d(expected, actual, assume_unique=True)
extra = np.setdiff1d(actual, expected, assume_unique=True)
offsets_valid = len(offsets) >= 2 and offsets[0] == 0 and offsets[-1] == len(pairs)
offsets_valid = offsets_valid and bool(np.all(offsets[1:] >= offsets[:-1]))
material_errors = 0
if offsets_valid:
    for material, (start, end) in enumerate(zip(offsets[:-1], offsets[1:])):
        material_errors += int(np.count_nonzero(instances[pairs[start:end, 0], 13] != material))
overflow = int(np.count_nonzero(hits[:, 6]))
duplicates = len(pairs) - len(actual)
passed = not (len(missing) or len(extra) or material_errors or overflow or duplicates) and offsets_valid
report = {
    'passed': passed, 'hitRecords': len(hits), 'coveredSamples': int(valid.sum()),
    'expectedUniqueTriangles': len(expected), 'candidateTriangles': len(pairs),
    'missing': len(missing), 'extra': len(extra), 'duplicates': duplicates,
    'materialErrors': material_errors, 'offsetsValid': offsets_valid, 'hitOverflow': overflow,
    'candidateBytes': pair_bytes.stat().st_size,
    'originalTrianglesPerBlock': args.block_size,
    'sortedIdentitySha256': hashlib.sha256(actual.tobytes()).hexdigest(),
    'scope': 'Exact complete hit-set membership and material grouping; excludes raster coverage and timing.',
}
Path(args.output).write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
if not passed:
    raise SystemExit(1)
