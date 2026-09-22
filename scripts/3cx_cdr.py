#!/usr/bin/env python3
"""
3CX cdroutput.csv -> SONIQ `cdr` rows (NDJSON).

3CX writes one row per call *leg*; a single call fans out across route_to /
divert / transfer legs sharing a main_call_history_id. This merges the legs
back into one call record shaped for the SONIQ cdr table.

Every row is emitted with source='3cx_import' so the side-effect triggers
(enrichment http_post, billing rating, webhooks, Ably outbox -> post-call
intelligence -> Hindsight/contact_memory) stay inert. Do not change that value.

  python3 scripts/3cx_cdr.py <backup.zip> --since 2026-09-15 -o out/cdr.ndjson
"""
import argparse, csv, io, json, re, sys, zipfile
from collections import defaultdict
from datetime import datetime

csv.field_size_limit(10**7)

ORG_ID = None  # set from --org

TERMINATION_DISPOSITION = {
    'cancelled': 'no_answer',
    'rejected': 'busy',
    'src_participant_terminated': 'answered',
    'dst_participant_terminated': 'answered',
    'redirected': 'no_answer',
}


def ts(v):
    v = (v or '').strip()
    return v.replace(' ', 'T') if v else None


def secs(a, b):
    if not a or not b:
        return 0
    try:
        fmt = '%Y-%m-%d %H:%M:%S.%f%z'
        pa = datetime.strptime(a.replace('+00', '+0000'), fmt)
        pb = datetime.strptime(b.replace('+00', '+0000'), fmt)
        return max(int((pb - pa).total_seconds()), 0)
    except Exception:
        return 0


def e164(raw):
    if not raw:
        return None
    s = str(raw).strip()
    d = re.sub(r'\D', '', s)
    if not d:
        return None
    if len(d) <= 5:
        return s                      # internal extension, leave as-is
    if s.startswith('+'):
        return '+' + d
    if d.startswith('00'):
        return '+' + d[2:]
    if d.startswith('44'):
        return '+' + d
    if d.startswith('0'):
        return '+44' + d[1:]
    return '+' + d


def is_ext(v):
    return bool(v) and re.fullmatch(r'\d{3}', v or '') is not None


def merge(legs):
    """Collapse one call's legs into a single cdr row."""
    legs.sort(key=lambda r: r['cdr_started_at'] or '')
    init = next((l for l in legs if l['creation_method'] == 'call_init'), legs[0])

    inbound = init['source_entity_type'] == 'external_line'
    direction = 'inbound' if inbound else 'outbound'

    # both ends internal -> internal call
    dst_types = {l['destination_entity_type'] for l in legs}
    if not inbound and dst_types <= {'extension', 'voicemail', 'queue', 'unknown'}:
        direction = 'internal'

    started = min((l['cdr_started_at'] for l in legs if l['cdr_started_at']), default=None)
    ended = max((l['cdr_ended_at'] for l in legs if l['cdr_ended_at']), default=None)

    # 3CX sets cdr_answered_at on the QUEUE/IVR leg the moment the system picks
    # up and starts playing MoH - that is not a human answering. The leg that
    # represents a real answer depends on direction: inbound/internal calls are
    # answered by an extension, outbound calls by the far end down the trunk.
    def answered(l):
        return bool((l.get('cdr_answered_at') or '').strip())

    answer_dst = ({'external_line', 'outbound_rule'} if direction == 'outbound'
                  else {'extension'})

    human_legs = sorted((l for l in legs
                         if answered(l) and l['destination_entity_type'] in answer_dst),
                        key=lambda l: l['cdr_answered_at'])
    vm_legs = [l for l in legs if answered(l) and l['destination_entity_type'] == 'voicemail']
    system_answered = any(answered(l) for l in legs)

    answered_at = human_legs[0]['cdr_answered_at'] if human_legs else None
    answered_by = None
    answered_ext = None
    if human_legs and direction != 'outbound':
        first = human_legs[0]
        answered_by = first['destination_dn_name'] or first['destination_participant_name']
        answered_ext = first['destination_dn_number']

    from_number = init['source_participant_phone_number'] or init['source_dn_number']
    from_name = init['source_dn_name'] or init['source_participant_name']
    from_ext = init['source_dn_number'] if init['source_entity_type'] == 'extension' else None

    # On inbound legs 3CX puts the trunk/DID label in the source name fields
    # (e.g. "GW - 32655144", ":BBS Cheltenham"). That is not caller ID.
    did_label = None
    if inbound:
        did_label = (from_name or '').lstrip(':').strip() or None
        from_name = None

    if inbound:
        # called party is the DID the trunk delivered
        to_number = e164(init.get('source_participant_trunk_did') or '')
        to_ext = answered_ext
        to_name = did_label
        for l in legs:
            if l['destination_entity_type'] == 'queue':
                to_name = l['destination_dn_name'] or did_label
                break
    else:
        ext_leg = next((l for l in legs
                        if l['destination_entity_type'] in ('outbound_rule', 'external_line')), None)
        tgt = ext_leg or legs[-1]
        to_number = tgt['destination_participant_phone_number'] or tgt['destination_dn_number']
        to_name = tgt['destination_participant_name'] or None
        to_ext = tgt['destination_dn_number'] if tgt['destination_entity_type'] == 'extension' else None

    if answered_at:
        disposition = 'answered'
    elif vm_legs:
        disposition = 'voicemail'
    elif system_answered and direction == 'inbound':
        # queue/IVR picked up and played to the caller, but no agent ever took
        # it - the caller gave up. That is abandoned, not answered.
        disposition = 'abandoned'
    else:
        last = legs[-1]['termination_reason']
        disposition = TERMINATION_DISPOSITION.get(last, 'no_answer')
        if disposition == 'answered':
            disposition = 'no_answer'

    talk = secs(answered_at, ended) if answered_at else 0
    ring = secs(started, answered_at) if answered_at else secs(started, ended)
    total = secs(started, ended)
    # time the caller spent in queue before an agent took it (or gave up)
    queue_answer = min((l['cdr_answered_at'] for l in legs
                        if (l.get('cdr_answered_at') or '').strip()
                        and l['destination_entity_type'] in ('queue', 'ivr')), default=None)
    queue_wait = secs(queue_answer, answered_at or ended) if queue_answer else 0

    return {
        'call_id': '3cx-' + (init['main_call_history_id'] or init['call_history_id'] or init['cdr_id']),
        'org_id': ORG_ID,
        'direction': direction,
        'disposition': disposition,
        'from_number': e164(from_number) if not is_ext(from_number) else from_number,
        'from_name': from_name or None,
        'from_extension': from_ext or None,
        'to_number': e164(to_number) if not is_ext(to_number) else to_number,
        'to_name': to_name or None,
        'to_extension': to_ext or None,
        'answered_by_name': answered_by or None,
        'initiated_at': ts(started),
        'answered_at': ts(answered_at),
        'ended_at': ts(ended or started),
        'ring_duration_seconds': ring,
        'talk_duration_seconds': talk,
        'total_duration_seconds': total,
        'billable_duration_seconds': 0,      # historic: never bill an import
        'hold_duration_seconds': 0,
        'call_type': 'voice',
        'status': 'completed',
        # IMPORTANT: suppresses enrichment / rating / webhooks / Ably -> AI
        'source': '3cx_import',
        'metadata': {
            'import': '3cx',
            'no_ai': True,
            'threecx_main_call_history_id': init['main_call_history_id'],
            'queue_wait_seconds': queue_wait,
            'legs': len(legs),
            'creation_methods': sorted({l['creation_method'] for l in legs}),
            'termination_reason': legs[-1]['termination_reason'],
            'group': init.get('source_participant_group_name') or None,
        },
    }


def main():
    global ORG_ID
    ap = argparse.ArgumentParser()
    ap.add_argument('backup')
    ap.add_argument('--org', required=True)
    ap.add_argument('--since', required=True, help='YYYY-MM-DD')
    ap.add_argument('--until', default='9999')
    ap.add_argument('-o', '--out', required=True)
    args = ap.parse_args()
    ORG_ID = args.org

    groups = defaultdict(list)
    with zipfile.ZipFile(args.backup) as zf:
        name = next(n for n in zf.namelist() if n.endswith('DbTables/cdroutput.csv'))
        with zf.open(name) as fh:
            for row in csv.DictReader(io.TextIOWrapper(fh, encoding='utf-8', errors='replace')):
                s = row.get('cdr_started_at') or ''
                if args.since <= s < args.until:
                    groups[row['main_call_history_id'] or row['call_history_id']].append(row)

    records = [merge(v) for v in groups.values() if v]
    records.sort(key=lambda r: r['initiated_at'] or '')

    with open(args.out, 'w') as f:
        for r in records:
            f.write(json.dumps(r) + '\n')

    from collections import Counter
    print(f'window        {args.since} .. {args.until}')
    print(f'legs grouped  {sum(len(v) for v in groups.values())} -> {len(records)} calls')
    print(f'direction     {dict(Counter(r["direction"] for r in records))}')
    print(f'disposition   {dict(Counter(r["disposition"] for r in records))}')
    print(f'answered      {sum(1 for r in records if r["answered_at"])}')
    print(f'talk total    {sum(r["talk_duration_seconds"] for r in records)/3600:.1f} h')
    print(f'sources set   {set(r["source"] for r in records)}')
    print(f'\nwrote {args.out}')


if __name__ == '__main__':
    main()
