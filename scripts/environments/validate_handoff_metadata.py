"""Read-only final artifact coherence audit; no Blender, browser, or geometry load.

Writes only its own diagnostic report. Pending render/runtime evidence is kept
separate from metadata errors, and neither category is converted into a pass.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
from datetime import datetime, timezone
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'artifacts/four-horizons'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='artifacts/four-horizons/final_metadata_review.json')
    args = parser.parse_args()
    errors, pending, checks, snapshots = [], [], [], {}
    hashes = {}

    def tracked(p):
        p = p.resolve()
        stat = p.stat()
        snapshots.setdefault(p, (stat.st_size, stat.st_mtime_ns))
        return p

    def read(p):
        return json.loads(tracked(p).read_text(encoding='utf-8'))

    def digest(p):
        p = tracked(p)
        if p not in hashes:
            with p.open('rb') as stream:
                hashes[p] = hashlib.file_digest(stream, 'sha256').hexdigest()
        return hashes[p]

    def check(name, passed, details=None):
        item = {'check': name, 'passes': bool(passed)}
        if details is not None:
            item['details'] = details
        checks.append(item)
        if not passed:
            errors.append(item)

    def verify_evidence(label, evidence):
        for row in evidence:
            p = ROOT / row['path']
            exists = p.is_file()
            check(f'{label}: {row["path"]}', exists and digest(p) == row['sha256'])

    def source_input_status(evidence, expected_ids):
        rows = evidence.get('inputs', [])
        stale, missing = [], []
        for row in rows:
            p = Path(row['asset'])
            if not p.is_file():
                stale.append(row['id'])
                continue
            current = tracked(p).stat()
            observed_ms = datetime.fromisoformat(row['assetModifiedAt'].replace('Z', '+00:00')).timestamp() * 1000
            if current.st_size != row['assetBytes'] or abs(current.st_mtime * 1000 - observed_ms) > 1:
                stale.append(row['id'])
        missing = sorted(expected_ids - {row['id'] for row in rows})
        return {'current': not stale and not missing, 'staleBiomes': sorted(stale), 'missingBiomes': missing}

    # Entry scripts must match the active production HTML, not merely an old
    # hashed file that happens to remain in dist after a later build.
    dist = ROOT / 'dist'
    dist_index = dist / 'index.html'
    active_scripts = []
    if dist_index.is_file():
        html = tracked(dist_index).read_text(encoding='utf-8')
        active_scripts = sorted({Path(unquote(urlsplit(src).path)).name for src in
                                 re.findall(r'<script\b[^>]*\bsrc=[\"\']([^\"\']+)[\"\']', html, flags=re.I)})

    def bundle_status(rows):
        if not rows:
            return {'status': 'unfingerprinted-browser-evidence', 'current': False,
                    'details': 'No production bundle fingerprint was recorded; matching source counts alone cannot establish current runtime evidence.'}
        details = []
        for row in rows:
            name = Path(unquote(urlsplit(row['url']).path)).name
            p = dist / 'assets' / name
            actual_hash = digest(p) if p.is_file() else None
            actual_bytes = p.stat().st_size if p.is_file() else None
            details.append({'file': name, 'recordedSha256': row.get('sha256'), 'currentSha256': actual_hash,
                            'activeEntryScript': name in active_scripts,
                            'matches': name in active_scripts and actual_hash == row.get('sha256')
                            and (row.get('bytes') is None or actual_bytes == row['bytes'])})
        same_entries = sorted({row['file'] for row in details}) == active_scripts
        current = bool(active_scripts) and same_entries and all(row['matches'] for row in details)
        return {'status': 'current-production-bundle' if current else 'historical-browser-evidence',
                'current': current, 'activeEntryScripts': active_scripts,
                'sameEntryScripts': same_entries, 'scripts': details}

    required = ['Four_Horizons.blend', 'scene_spec.json', 'semantic_layout.png',
                'region_graph.json', 'asset_registry.json', 'animation_manifest.json',
                'validation_report.md', 'scene_connections.json', 'scripts/source_index.json',
                'viewer/render_profile.json', 'viewer/runtime_validation.json',
                'master_validation.json', 'handoff_metadata_validation.json']
    for name in required:
        check(f'required file: {name}', (ART / name).is_file())
    for name in ['references', 'scripts', 'renders', 'comparisons', 'checkpoints', 'viewer']:
        check(f'populated directory: {name}', (ART / name).is_dir() and any((ART / name).iterdir()))

    handoff = read(ART / 'handoff_metadata_validation.json')
    index_path = ART / 'scripts/source_index.json'
    index = read(index_path)
    source_root = (index_path.parent / index['sourceRootRelativeToThisFile']).resolve()
    indexed = []
    for key, value in index.items():
        if key.endswith('RelativeToThisFile'):
            paths = [index_path.parent / value]
        else:
            paths = [source_root / name for name in (value if isinstance(value, list) else [value])]
        for p in paths:
            indexed.append(str(p.resolve()))
            check(f'indexed path: {key}/{p.name}', p.exists())
    check('source index evidence hash', digest(index_path) == handoff['sourceIndexEvidence']['sha256'])
    checkpoints = read(ART / 'checkpoints/index.json')['checkpoints']
    for row in checkpoints:
        p = ART / 'checkpoints' / row['path']
        check(f'checkpoint: {row["biome"]}/{p.name}', p.is_file() and p.stat().st_size == row['bytes'])

    manifest = read(ROOT / 'public/environments/world-manifest.json')
    network = read(ART / 'built_network_validation.json')
    maps = read(ART / 'semantic_layout_report.json')
    master = read(ART / 'master_validation.json')
    root_registry = read(ART / 'asset_registry.json')
    verify_evidence('semantic map provenance', maps['provenance'])
    check('built network passes', network.get('passes') is True and not network.get('issues'))
    check('map checks pass', all(maps['checks'].values()))
    ids = {b['id'] for b in manifest['biomes']}
    connections = read(ART / 'scene_connections.json')['connections']
    plan_connections = read(ART / 'region_graph.json')['connections']
    check('connections match plan', connections == plan_connections)
    check('connection region IDs resolve', all(set(c['regions']) <= ids for c in connections))
    total_objects = total_triangles = total_meshes = total_buildings = 0
    for biome in manifest['biomes']:
        bid, directory = biome['id'], ART / biome['id']
        registry = read(directory / 'asset_registry.json')
        spec = read(directory / 'scene_spec.json')
        human = read(directory / 'human_landuse_validation.json')
        source = read(directory / 'source_validation.json')
        audit = network['regions'][bid]
        counts = registry['source']
        check(f'{bid}: source inventory agreement', counts == biome['source'] == human['source'] == audit['actualExport'] == audit['sourceRegistry'])
        check(f'{bid}: complete building records', spec['buildings'] == registry['buildings'])
        check(f'{bid}: building registry fingerprint', spec['buildingInventory']['sourceSha256'] == digest(directory / 'asset_registry.json'))
        check(f'{bid}: source/export committed', human.get('sourceApplied') is True and human.get('exportIntegrated') is True)
        check(f'{bid}: source reopen counts', source['objects'] == counts['objects'] and source['triangles'] == counts['triangles'] and source['sourceCountsMatch'] is True)
        check(f'{bid}: source images resolve', len(source['renders']) == 13 and all((directory / p).is_file() for p in source['renders']))
        check(f'{bid}: finite complete source', not source['nonfiniteMeshes'] and not source['degenerateMeshes'] and not source['externalImages'])
        verify_evidence(f'{bid} final network', audit['evidence'])
        total_objects += counts['objects']; total_triangles += counts['triangles']; total_meshes += counts['uniqueMeshes']
        total_buildings += len(registry['buildings'])
        if bid == 'sunstone-oasis' and human.get('marketPlazaContactCorrected'):
            patch = directory / 'market_plaza_contact_validation.json'
            if patch.stat().st_mtime_ns > (directory / 'source_validation.json').stat().st_mtime_ns:
                pending.append({'check': 'oasis final source images', 'details': 'The 13-view source report predates the localized plaza correction; unchanged counts do not establish refreshed visual evidence. Use the targeted corrected-plaza inspection as a dated supplement.'})
    check('root/master inventory agreement', total_objects == root_registry['objects'] == master['objects'] and total_triangles == root_registry['triangles'] == master['triangles'] and total_meshes == master['uniqueMeshes'])
    check('map building inventory', total_buildings == maps['registeredBuildingFootprints'])
    for row in master['regionSources']:
        p = ART / row['path']
        check(f'master linked source byte size: {row["biome"]}', p.is_file() and p.stat().st_size == row['bytes'])
    if master.get('renderStatus') != 'complete' or master.get('reopenedForRender') is not True:
        pending.append({'check': 'fresh master render', 'details': {'renderStatus': master.get('renderStatus'), 'reopenedForRender': master.get('reopenedForRender')}})

    runtime = read(ART / 'viewer/runtime_validation.json')
    runtime_counts = sorted({v.get('diagnostics', {}).get('world', {}).get('sourceTriangles') for v in runtime.get('views', [])} - {None})
    runtime_sources = source_input_status(runtime.get('inputEvidence', {}), ids)
    runtime_bundle = bundle_status(runtime.get('productionBundle'))
    if runtime_counts != [total_triangles] or runtime.get('errors'):
        pending.append({'check': 'final runtime and performance evidence', 'details': {'timestamp': runtime.get('timestamp'), 'sourceTriangleTotals': runtime_counts, 'expectedTriangles': total_triangles, 'errors': runtime.get('errors')}})
    if not runtime_sources['current']:
        pending.append({'check': 'final runtime performance inputs', 'details': runtime_sources})
    if not runtime_bundle['current']:
        pending.append({'check': 'final runtime performance bundle', 'details': runtime_bundle})
    review = read(ART / 'viewer/reference-rebuild/review.json')
    review_sources = source_input_status(review.get('inputEvidence', {}), ids)
    review_bundle = bundle_status(review.get('productionBundle'))
    bundle_snapshot = bundle_status(read(ART / 'viewer/reference-rebuild/production-bundle.json')['scripts'])
    if not review_sources['current']:
        pending.append({'check': 'final runtime visual inputs', 'details': {**review_sources, 'declaredValidity': review.get('validity')}})
    if not review_bundle['current'] or review.get('errors'):
        pending.append({'check': 'final runtime visuals on current production bundle',
                        'details': {'bundle': review_bundle, 'errors': review.get('errors'),
                                    'declaredValidity': review.get('validity'),
                                    'sourceEvidenceScope': 'Current editable-source renders remain source evidence; they do not verify post-optimization browser rendering.'}})
    if not bundle_snapshot['current']:
        pending.append({'check': 'production visual bundle snapshot refresh', 'details': bundle_snapshot})
    report_text = tracked(ART / 'validation_report.md').read_text(encoding='utf-8')
    for target in re.findall(r'\]\(([^)]+)\)', report_text):
        if not re.match(r'^[a-z]+:', target):
            check(f'validation report link: {target}', (ART / target.split('#', 1)[0]).exists())

    changed = [str(p.relative_to(ROOT)) for p, before in snapshots.items() if (p.stat().st_size, p.stat().st_mtime_ns) != before]
    check('inputs unchanged during metadata audit', not changed, changed)
    report = {'timestamp': datetime.now(timezone.utc).isoformat(),
              'scope': 'Read-only CPU metadata audit; no scene, geometry, runtime or root report edits.',
              'metadataPasses': not errors, 'finalHandoffComplete': not errors and not pending,
              'indexedPathsChecked': len(indexed), 'checkpointCount': len(checkpoints),
              'checkedItems': len(checks), 'sourceObjects': total_objects, 'sourceTriangles': total_triangles,
              'evidenceStatus': {
                  'editableSources': {'scope': 'Blender source and export evidence, independent of runtime bundle changes.',
                                      'provesCurrentRuntime': False},
                  'runtimePerformance': {'sources': runtime_sources, 'bundle': runtime_bundle},
                  'runtimeVisuals': {'sources': review_sources, 'bundle': review_bundle,
                                     'bundleSnapshot': bundle_snapshot}},
              'metadataIssues': errors, 'pendingEvidence': pending, 'checks': checks}
    (ROOT / args.output).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'checks'}, indent=2))
    return 0 if report['finalHandoffComplete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
