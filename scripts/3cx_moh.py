#!/usr/bin/env python3
"""
Upload the 3CX queue music-on-hold files to R2 and emit the SQL that creates
the audio_assets rows and points each migrated queue flow at the right one.

Follows the shape the Bicom migration used for MoH:
  asset_type='music_on_hold', source_type='uploaded', use_s3=true,
  s3_bucket='soniq-phone-prompts', category='moh'

  python3 scripts/3cx_moh.py --org <uuid> --payload data/3cx/vivalda-payload.json \
      --src data/3cx/moh -o data/3cx/moh.sql
"""
import argparse, hashlib, json, os, re, subprocess, wave

BUCKET = 'soniq-phone-prompts'
WRANGLER_CWD = '/Users/davidsmith/Documents/GitHub/soniq-workers'


def slug(fn):
    s = re.sub(r'\.wav$', '', fn, flags=re.I)
    s = re.sub(r'^converted_', '', s, flags=re.I)
    s = re.sub(r'\s*\((\d+)\)$', r'-\1', s)
    s = re.sub(r'(?<=[a-z])(?=[A-Z])', '-', s)
    s = re.sub(r'[^A-Za-z0-9]+', '-', s).strip('-').lower()
    return s or 'moh'


def wav_meta(path):
    with wave.open(path, 'rb') as w:
        return w.getnframes() / float(w.getframerate())


def sql_str(v):
    return 'null' if v is None else "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--org', required=True)
    ap.add_argument('--payload', required=True)
    ap.add_argument('--src', required=True)
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--no-upload', action='store_true')
    args = ap.parse_args()

    payload = json.load(open(args.payload))
    queues = [q for q in payload['queues'] if q.get('music_on_hold')]
    files = sorted({q['music_on_hold'] for q in queues})

    assets = {}
    for fn in files:
        path = os.path.join(args.src, fn)
        if not os.path.exists(path):
            print(f'  MISSING {fn} - skipped')
            continue
        s = slug(fn)
        key = f'org-{args.org}/moh/{s}.wav'
        data = open(path, 'rb').read()
        assets[fn] = {
            'slug': s,
            'key': key,
            'bytes': len(data),
            'duration': round(wav_meta(path), 2),
            'sha': hashlib.sha256(data).hexdigest(),
        }
        if not args.no_upload:
            r = subprocess.run(
                ['npx', 'wrangler', 'r2', 'object', 'put', f'{BUCKET}/{key}',
                 '--file', os.path.abspath(path), '--content-type', 'audio/wav', '--remote'],
                cwd=WRANGLER_CWD, capture_output=True, text=True)
            ok = 'Upload complete' in (r.stdout + r.stderr)
            print(f'  {"uploaded" if ok else "FAILED  "}  {key}')
            if not ok:
                print((r.stdout + r.stderr)[-400:])

    lines = ['-- 3CX music-on-hold -> audio_assets, linked to the migrated queue flows',
             'begin;', '']
    for fn, a in assets.items():
        lines.append(
            "insert into audio_assets (org_id, name, asset_type, source_type, use_s3, "
            "s3_bucket, s3_key, file_size, duration, content_hash, category, tags)\n"
            f"values ({sql_str(args.org)}, {sql_str(a['slug'])}, 'music_on_hold', 'uploaded', true, "
            f"{sql_str(BUCKET)}, {sql_str(a['key'])}, {a['bytes']}, {a['duration']}, "
            f"{sql_str(a['sha'])}, 'moh', array['3cx_import']);")
    lines.append('')

    for q in queues:
        a = assets.get(q['music_on_hold'])
        if not a:
            continue
        lines.append(
            "update call_flows set moh_asset_id = (select id from audio_assets "
            f"where org_id = {sql_str(args.org)} and name = {sql_str(a['slug'])} "
            "and asset_type = 'music_on_hold' limit 1), moh_mode = 'static'\n"
            f" where org_id = {sql_str(args.org)} and name = {sql_str(q['name'])};"
            f"  -- queue {q['extension']}")
    lines += ['', 'commit;']

    open(args.out, 'w').write('\n'.join(lines) + '\n')
    print(f'\n{len(assets)} asset(s), {len(queues)} queue link(s)\nwrote {args.out}')


if __name__ == '__main__':
    main()
