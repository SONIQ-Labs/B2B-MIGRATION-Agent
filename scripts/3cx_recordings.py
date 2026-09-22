#!/usr/bin/env python3
"""
Extract 3CX call recordings for a date window and emit an upload/link plan.

3CX keeps the recording index in DbTables/cdrrecordings.csv (recording_url is a
path under recordings/ in the backup, plus the leg cdr_id). Joining that to
cdroutput gives main_call_history_id, which is what the cdr importer used to
build call_id, so recordings land on the right call.

  python3 scripts/3cx_recordings.py <backup.zip> --org <uuid> --since 2026-09-15 \
      --outdir data/3cx/recordings -o data/3cx/recordings.ndjson
"""
import argparse, csv, io, json, os, wave, zipfile

csv.field_size_limit(10**7)


def wav_seconds(path):
    try:
        with wave.open(path, 'rb') as w:
            return int(w.getnframes() / float(w.getframerate()))
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('backup')
    ap.add_argument('--org', required=True)
    ap.add_argument('--since', required=True)
    ap.add_argument('--until', default='9999')
    ap.add_argument('--outdir', required=True)
    ap.add_argument('-o', '--out', required=True)
    args = ap.parse_args()

    zf = zipfile.ZipFile(args.backup)
    names = set(zf.namelist())

    # DbTables/recordings.csv is the master index (one row per wav, both the
    # pre- and post-Aug-2025 eras). cdrrecordings.csv only covers the newer
    # era - using it drops the 24 older recordings, which carry no cdr_id at
    # all and must be matched through cl_participants instead.
    idx_name = next(n for n in zf.namelist() if n.endswith('DbTables/recordings.csv'))
    with zf.open(idx_name) as fh:
        all_recs = list(csv.DictReader(io.TextIOWrapper(fh, encoding='utf-8', errors='replace')))

    recs = [r for r in all_recs if args.since <= (r['start_time'] or '') < args.until]
    no_cdr = [r for r in recs if not (r['cdr_id'] or '').strip()]
    if no_cdr:
        print(f'note: {len(no_cdr)} recording(s) in window have no cdr_id '
              f'(pre-Aug-2025 era) and need the cl_participants path - skipped here')

    want = {r['cdr_id']: r for r in recs if (r['cdr_id'] or '').strip()}
    if not want:
        print('no recordings in window')
        return

    # leg cdr_id -> main_call_history_id
    cdr_name = next(n for n in zf.namelist() if n.endswith('DbTables/cdroutput.csv'))
    main_by_leg = {}
    with zf.open(cdr_name) as fh:
        for row in csv.DictReader(io.TextIOWrapper(fh, encoding='utf-8', errors='replace')):
            if row['cdr_id'] in want:
                main_by_leg[row['cdr_id']] = row['main_call_history_id'] or row['call_history_id']

    os.makedirs(args.outdir, exist_ok=True)
    out = []
    missing_wav = missing_call = 0

    for leg_id, r in want.items():
        member = 'recordings/' + r['recording_url']
        if member not in names:
            missing_wav += 1
            continue
        main = main_by_leg.get(leg_id)
        if not main:
            missing_call += 1
            continue

        call_id = '3cx-' + main
        local = os.path.join(args.outdir, call_id + '.wav')
        with zf.open(member) as src, open(local, 'wb') as dst:
            dst.write(src.read())

        out.append({
            'call_id': call_id,
            'org_id': args.org,
            'local_path': local,
            # NB: cdr.recording_url is NOT a URL - /api/recordings/[id]/url
            # passes it straight to GetObjectCommand as the R2 object Key in
            # BUCKETS.RECORDINGS ('soniq-call-recordings'). Both r2_recording_key
            # and recording_url must be set to this key or the portal shows no
            # recording: the `calls` view does not expose r2_recording_key at all.
            'r2_key': f'recordings/{args.org}/{call_id}.wav',
            'bytes': os.path.getsize(local),
            'duration_seconds': wav_seconds(local),
            'started_at': r['start_time'],
            'threecx_path': r['recording_url'],
        })

    with open(args.out, 'w') as f:
        for o in out:
            f.write(json.dumps(o) + '\n')

    print(f'recordings in window  {len(want)}')
    print(f'extracted             {len(out)}')
    if missing_wav:  print(f'missing wav in zip    {missing_wav}')
    if missing_call: print(f'no matching call      {missing_call}')
    print(f'total bytes           {sum(o["bytes"] for o in out)/1e6:.1f} MB')
    print(f'\nwrote {args.out} and {args.outdir}/')


if __name__ == '__main__':
    main()
