#!/usr/bin/env python3
"""
3CX backup -> normalised SONIQ migration payload.

Usage:
  python3 scripts/3cx_extract.py /path/to/Backup.zip -o out/3cx-payload.json

Reads the <id>Db.xml config out of a 3CX v18/v20 backup zip and emits a
source-neutral payload the threecx-mapper consumes to write SONIQ rows.
No 3CX server contact required - works entirely offline from the backup.
"""
import argparse, json, os, re, sys, zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

# ---------------------------------------------------------------- helpers

def e164(raw, cc='44'):
    if not raw:
        return None
    s = str(raw).strip()
    if s.startswith('+'):
        return '+' + re.sub(r'\D', '', s)
    d = re.sub(r'\D', '', s)
    if not d:
        return None
    if d.startswith('00'):
        return '+' + d[2:]
    if d.startswith(cc) and len(d) >= 11:
        return '+' + d
    if d.startswith('0'):
        return '+' + cc + d[1:]
    if len(d) <= 5:            # internal extension, not a DID
        return None
    return '+' + d


def txt(node, path, default=None):
    if node is None:
        return default
    el = node.find(path)
    if el is None or el.text is None:
        return default
    v = el.text.strip()
    return v if v else default


def props(node):
    """DN <Properties><DNProperty Name/Value> -> dict"""
    out = {}
    p = node.find('Properties')
    if p is None:
        return out
    for dp in p:
        n = txt(dp, 'Name')
        if n:
            out[n] = txt(dp, 'Value')
    return out


def mac_colon(mac):
    if not mac:
        return None
    m = re.sub(r'[^0-9A-Fa-f]', '', mac).upper()
    if len(m) != 12:
        return None
    return ':'.join(m[i:i + 2] for i in range(0, 12, 2))


def dest(node):
    """<OfficeHoursDestination><To>Queue</To><Internal DN="916"/></> -> dict"""
    if node is None:
        return None
    to = txt(node, 'To') or 'None'
    if to in ('None', ''):
        return {'type': 'none'}
    internal = node.find('Internal')
    dn = internal.get('DN') if internal is not None else None
    external = node.find('External')
    num = external.get('Number') if external is not None else None
    return {'type': to.lower(), 'dn': dn, 'external': num}


# ---------------------------------------------------------------- parse

def parse(xml_bytes):
    root = ET.fromstring(xml_bytes)
    hdr = root.find('header')
    tenant = root.find('Tenants/Tenant')
    dn_root = tenant.find('DN')

    by_tag = defaultdict(list)
    for node in dn_root:
        by_tag[node.tag].append(node)

    # ---- gateways / providers (trunks) --------------------------------
    trunks = []
    gws = root.find('Gateways')
    if gws is not None:
        for g in gws:
            if g.tag not in ('Gateway', 'VoipProvider'):
                continue
            name = txt(g, 'Name')
            trunks.append({
                'kind': 'voip_provider' if g.tag == 'VoipProvider' else 'gateway',
                'name': name,
                'host': txt(g, 'Host'),
                'port': txt(g, 'Port'),
                'proxy_port': txt(g, 'ProxyPort'),
                'lines': txt(g, 'Lines'),
                'type': txt(g, 'Type'),
                'requires_registration': txt(g, 'RequireRegistrationFor'),
                'srtp': txt(g, 'SRTPMode'),
                'template': txt(g, 'TemplateFilename'),
                'codecs': [c.get('RFCName') for c in (g.find('Codecs') or []) if c.get('RFCName')],
            })

    # ---- extensions ----------------------------------------------------
    extensions = []
    for e in by_tag['Extension']:
        p = props(e)
        devices = []
        pd = e.find('PhoneDevices')
        if pd is not None:
            for d in pd:
                settings = txt(d, 'Settings') or ''
                devices.append({
                    'mac': mac_colon(txt(d, 'MAC')),
                    'mac_raw': txt(d, 'MAC'),
                    'model': txt(d, 'ProvisioningFilename2'),
                    'template': txt(d, 'TemplateFilename'),
                    'interface': txt(d, 'Interface'),
                    'prov_type': (re.search(r'ProvType="(\d+)"', settings) or [None, None])[1],
                })
        number = txt(e, 'Number')
        first, last = txt(e, 'FirstName', ''), txt(e, 'LastName', '')
        display = (f'{first} {last}').strip() or f'Ext {number}'
        extensions.append({
            'extension': number,
            'first_name': first or None,
            'last_name': last or None,
            'display_name': display,
            'email': (txt(e, 'EmailAddress') or '').strip().lower() or None,
            'enabled': txt(e, 'Enabled') == 'True',
            'sip_auth_id': txt(e, 'AuthID'),
            'sip_auth_password': txt(e, 'AuthPassword'),
            'outbound_caller_id': txt(e, 'OutboundCallerID'),
            'outbound_caller_id_e164': e164(txt(e, 'OutboundCallerID')),
            'record_calls': txt(e, 'RecordCalls') == 'True',
            'voicemail_enabled': txt(e, 'VMEnabled') == 'True',
            'voicemail_pin': txt(e, 'VMPIN'),
            'voicemail_email_mode': txt(e, 'VMEmailOptions'),
            'no_answer_timeout': int(txt(e, 'NoAnswerTimeout', '20') or 20),
            'srtp': txt(e, 'SRTPMode'),
            'mobile': p.get('MOBILENUMBER') or p.get('MOBILE'),
            'lan_only': p.get('ALLOW_LAN_ONLY') == '1',
            'devices': devices,
            'props': p,
        })

    # ---- queues --------------------------------------------------------
    queues = []
    for q in by_tag['Queue']:
        members = []
        m = q.find('Members')
        if m is not None:
            members = [{'extension': x.get('DN'),
                        'status': x.get('QueueStatus'),
                        'skill': x.get('SkillGroup') or None} for x in m]
        mgrs = []
        qm = q.find('QueueManagers')
        if qm is not None:
            mgrs = [x.get('DN') for x in qm]
        queues.append({
            'extension': txt(q, 'Number'),
            'name': txt(q, 'Name'),
            'strategy': txt(q, 'PollingStrategy'),
            'ring_timeout': int(txt(q, 'RingTimeout', '30') or 30),
            'master_timeout': int(txt(q, 'MasterTimeout', '1800') or 1800),
            'announce_position': txt(q, 'AnnounceQueuePosition') == 'True',
            'announce_interval': int(txt(q, 'AnnouncementInterval', '60') or 60),
            'intro_enabled': txt(q, 'EnableIntro') == 'True',
            'music_on_hold': txt(q, 'OnHoldFile'),
            'members': members,
            'managers': mgrs,
            'timeout_destination': dest(q.find('Destination')),
        })

    # ---- departments ---------------------------------------------------
    # NB: in 3CX v20 <Groups> are permission/department groups (Members +
    # Roles + BreakTime), NOT ring groups. Ring/hunt behaviour lives in
    # <Queue>. These map to SONIQ teams/departments, not call flows.
    departments = []
    for g in (tenant.find('Groups') or []):
        name = txt(g, 'Name')
        # __DEFAULT__ is the system all-extensions group; ___FAVORITES___<ext>
        # are per-user favourite lists, not departments.
        if not name or name == '__DEFAULT__' or name.startswith('___FAVORITES___'):
            continue
        members = []
        m = g.find('Members')
        if m is not None:
            members = [x.get('DN') for x in m if x.get('DN')]
        roles = {}
        rl = g.find('Roles')
        if rl is not None:
            for role in rl:
                rn = role.get('name')
                if rn:
                    roles[rn] = {c.tag: (c.text or '').strip() == 'true' for c in role}
        departments.append({
            'name': name,
            'members': members,
            'member_count': len(members),
            'roles': roles,
        })

    # ---- IVRs ----------------------------------------------------------
    ivrs = []
    for i in by_tag['IVR']:
        options = {}
        fw = i.find('ForwardRules') or i.find('Forwards')
        if fw is not None:
            for rule in fw:
                key = rule.get('Input') or txt(rule, 'Input')
                if key is None:
                    continue
                options[key] = dest(rule.find('Forward') or rule)
        number = txt(i, 'Number')
        ivrs.append({
            'extension': number,
            'name': txt(i, 'Name'),
            'prompt': (txt(i, 'PromptFilename') or '').strip() or None,
            'timeout': int(txt(i, 'Timeout', '10') or 10),
            'timeout_action': txt(i, 'TimeoutForwardType'),
            'options': options,
            # 3CX ships internal IVRs (PIN prompt, queue callback) that are
            # engine plumbing, not customer auto-attendants. Don't migrate.
            'system': number in ('777', 'QCB') or not options,
        })

    # ---- inbound rules (DIDs) + external lines --------------------------
    dids, external_lines = [], []
    for el in by_tag['ExternalLine']:
        line_no = txt(el, 'Number')
        gw = txt(el, 'Gateway')
        external_lines.append({
            'line': line_no,
            'gateway': gw,
            'direction': txt(el, 'Direction'),
            'simultaneous_calls': int(txt(el, 'SimultaneousCalls', '0') or 0),
            'sip_auth_id': txt(el, 'AuthID'),
            'sip_auth_password': txt(el, 'AuthPassword'),
        })
        rr = el.find('RoutingRules')
        if rr is None:
            continue
        for rule in rr:
            data = txt(rule, 'Data')
            cond = rule.find('Conditions')
            ctype = cond.find('Condition').get('Type') if cond is not None and cond.find('Condition') is not None else None
            if not data or ctype != 'BasedOnDID':
                continue
            fd = rule.find('ForwardDestinations')
            dids.append({
                'did_raw': data,
                'did': e164(data),
                'line': line_no,
                'gateway': gw,
                'office_hours': dest(fd.find('OfficeHoursDestination')) if fd is not None else None,
                'out_of_hours': dest(fd.find('OutOfOfficeHoursDestination')) if fd is not None else None,
                'holidays': dest(fd.find('HolidaysDestination')) if fd is not None else None,
                'alter_ooh': txt(fd, 'AlterDestinationDuringOutOfOfficeHours') == 'True' if fd is not None else False,
            })

    # ---- outbound rules ------------------------------------------------
    outbound = []
    for o in (tenant.find('OutboundRules') or []):
        routes = []
        rl = o.find('OutboundRoutes')
        if rl is not None:
            for rt in rl:
                gw = txt(rt, 'Gateway')
                if not gw:
                    continue                # empty fallback slot
                routes.append({
                    'gateway': gw,
                    'strip_digits': int(txt(rt, 'StripDigits', '0') or 0),
                    'prepend': txt(rt, 'Prepend'),
                })
        dngroups = [(x.text or '').strip() for x in (o.find('DNGroups') or [])]
        dnranges = [(x.text or '').strip() for x in (o.find('DNRanges') or [])]
        ext_lines = [(x.text or '').strip() for x in (o.find('ExternalLines') or [])]
        outbound.append({
            'name': txt(o, 'Name'),
            'prefix': txt(o, 'Prefix'),
            'min_len': txt(o, 'MinimumLength'),
            'priority': int(txt(o, 'Priority', '0') or 0),
            'applies_to_groups': dngroups,
            'applies_to_ranges': dnranges,
            'applies_to_lines': ext_lines,
            'routes': routes,
        })
    outbound.sort(key=lambda r: r['priority'])

    # ---- phonebook -----------------------------------------------------
    phonebook = []
    pb = tenant.find('PhoneBookEntries')
    if pb is not None:
        for c in pb:
            num = txt(c, 'Number') or txt(c, 'PhoneNumber')
            phonebook.append({
                'first_name': txt(c, 'FirstName'),
                'last_name': txt(c, 'LastName'),
                'company': txt(c, 'Company'),
                'number': num,
                'number_e164': e164(num),
                'email': txt(c, 'Email'),
            })

    # ---- misc ----------------------------------------------------------
    park = [txt(p, 'Number') for p in by_tag['ParkExtension']]
    fax = [{'extension': txt(f, 'Number'), 'name': txt(f, 'Name'),
            'email': txt(f, 'EmailAddress')} for f in by_tag['FaxExtension']]

    return {
        'source': '3cx',
        'version': txt(hdr, 'version'),
        'backup_date': txt(hdr, 'Date'),
        'fqdn': txt(root, 'fqdn/externalFqdn') or txt(root, 'fqdn/internalFqdn'),
        'tenant_name': txt(tenant, 'Name'),
        'company': txt(root, 'license/company'),
        'trunks': trunks,
        'external_lines': external_lines,
        'extensions': extensions,
        'queues': queues,
        'departments': departments,
        'ivrs': ivrs,
        'dids': dids,
        'outbound_rules': outbound,
        'park_extensions': park,
        'fax_extensions': fax,
        'phonebook': phonebook,
    }


# ---------------------------------------------------------------- media index

def index_media(zf):
    idx = {'recordings': [], 'voicemails': [], 'prompts': [], 'profile_pictures': 0}
    for info in zf.infolist():
        n = info.filename
        if n.startswith('recordings/') and n.endswith('.wav'):
            parts = n.split('/')
            idx['recordings'].append({'path': n, 'extension': parts[1] if len(parts) > 2 else None,
                                      'bytes': info.file_size})
        elif n.startswith('voicemails/') and n.endswith('.wav'):
            parts = n.split('/')
            idx['voicemails'].append({'path': n, 'extension': parts[1] if len(parts) > 2 else None,
                                      'bytes': info.file_size})
        elif n.startswith('httpprompts/') or n.startswith('vmailprompts/'):
            idx['prompts'].append({'path': n, 'bytes': info.file_size})
        elif n.startswith('ProfilePictures/'):
            idx['profile_pictures'] += 1
    return idx


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('backup')
    ap.add_argument('-o', '--out', default='3cx-payload.json')
    args = ap.parse_args()

    with zipfile.ZipFile(args.backup) as zf:
        db = [n for n in zf.namelist() if n.endswith('Db.xml')]
        if not db:
            sys.exit('No Db.xml found in backup - not a 3CX backup?')
        payload = parse(zf.read(db[0]))
        payload['media'] = index_media(zf)
        payload['source_file'] = os.path.basename(args.backup)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(payload, f, indent=2)

    m = payload['media']
    rec_by_ext = Counter(r['extension'] for r in m['recordings'])
    vm_by_ext = Counter(v['extension'] for v in m['voicemails'])
    print(f"3CX {payload['version']}  |  {payload['company']}  |  {payload['fqdn']}")
    print(f"  extensions      {len(payload['extensions'])}"
          f"  ({sum(1 for e in payload['extensions'] if e['enabled'])} enabled,"
          f" {sum(1 for e in payload['extensions'] if e['devices'])} with a phone,"
          f" {sum(1 for e in payload['extensions'] if e['email'])} with email)")
    print(f"  queues          {len(payload['queues'])}"
          f"  ({sum(len(q['members']) for q in payload['queues'])} agent seats)")
    print(f"  departments     {len(payload['departments'])}")
    real_ivrs = [i for i in payload['ivrs'] if not i['system']]
    print(f"  IVRs            {len(real_ivrs)} migratable"
          f"  ({len(payload['ivrs']) - len(real_ivrs)} 3CX system IVRs skipped)")
    print(f"  DIDs            {len(payload['dids'])}"
          f"  ({sum(1 for d in payload['dids'] if d['did'])} normalised to E.164)")
    print(f"  trunks          {len(payload['trunks'])} / external lines {len(payload['external_lines'])}")
    print(f"  outbound rules  {len(payload['outbound_rules'])}")
    print(f"  park slots      {len(payload['park_extensions'])}   fax {len(payload['fax_extensions'])}")
    print(f"  phonebook       {len(payload['phonebook'])}")
    print(f"  recordings      {len(m['recordings'])} across {len(rec_by_ext)} exts"
          f"  ({sum(r['bytes'] for r in m['recordings'])/1e9:.2f} GB)")
    print(f"  voicemails      {len(m['voicemails'])} across {len(vm_by_ext)} exts")
    print(f"  prompts         {len(m['prompts'])}   profile pics {m['profile_pictures']}")
    print(f"\nwrote {args.out}")


if __name__ == '__main__':
    main()
