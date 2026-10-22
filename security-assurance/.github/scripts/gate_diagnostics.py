#!/usr/bin/env python3
"""Publish bounded diagnostic projections, never raw gate evidence or verdict authority."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import yaml

MAX_INPUT=4*1024*1024
MAX_OUTPUT=32768
MAX_ROWS=64
VERDICTS={'PASS','FAIL','NOT_RUN','NOT_APPLICABLE','TOOL_FAILURE','POLICY_UNAVAILABLE','INCONCLUSIVE'}
SEVERITIES=('critical','high','medium','low','info')

def bounded_json(path):
    try:
        with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as stream:
            info=os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size>MAX_INPUT:
                return None,None
            data=stream.read(MAX_INPUT+1)
        if len(data)>MAX_INPUT:
            return None,None
        doc=json.loads(data)
        return (doc,hashlib.sha256(data).hexdigest()) if isinstance(doc,dict) else (None,None)
    except (OSError,ValueError,UnicodeError):
        return None,None

def write(path,value):
    data=(json.dumps(value,indent=2,sort_keys=True)+'\n').encode() if not isinstance(value,str) else value.encode()
    if len(data)>MAX_OUTPUT:
        raise ValueError('diagnostic output budget exceeded')
    with path.open('xb') as stream:
        stream.write(data)

def collect(gate,out,policy):
    # Control IDs come from the trusted policy; never publish caller-selected IDs,
    # free-text reasons/tools, filenames, evidence paths or unknown result keys.
    controls=yaml.safe_load(Path(policy).read_text())['controls']
    allowed={c['id'] for c in controls if re.fullmatch(r'[A-Z0-9-]{1,64}',c['id'])}
    decision,decision_hash=bounded_json(Path(gate)/'gate-decision.json')
    manifest,manifest_hash=bounded_json(Path(gate)/'evidence-manifest.json')
    valid=bool(decision and decision.get('decision') in {'PASS','FAIL'})
    rows=[]
    for row in (decision or {}).get('controls',[])[:MAX_ROWS]:
        if not isinstance(row,dict) or row.get('control') not in allowed:
            continue
        findings=row.get('findings',{})
        rows.append({'control':row['control'],'verdict':row.get('verdict') if row.get('verdict') in VERDICTS else 'UNAVAILABLE',
                     'blocking':row.get('blocking') is True,
                     'findings':{level:findings[level] for level in SEVERITIES if isinstance(findings,dict) and type(findings.get(level)) is int and 0<=findings[level]<=1000000000}})
    entries=[]
    for entry in (manifest or {}).get('entries',[])[:MAX_ROWS]:
        if isinstance(entry,dict) and entry.get('control') in allowed and re.fullmatch('[a-f0-9]{64}',str(entry.get('sha256',''))):
            entries.append({'control':entry['control'],'sha256':entry['sha256']})
    common={'schema_version':1,'diagnostic_only':True,'sanitized':True}
    safe_decision={**common,'available':valid,'decision':decision['decision'] if valid else None,'original_sha256':decision_hash,
                   'controls':rows,'controls_truncated':len((decision or {}).get('controls',[]))>MAX_ROWS}
    safe_manifest={**common,'available':manifest is not None,'original_sha256':manifest_hash,'entries':entries,
                   'entries_truncated':len((manifest or {}).get('entries',[]))>MAX_ROWS}
    summary=['# S0 gate diagnostics','', 'Gate decision: '+(safe_decision['decision'] or 'unavailable')+'.',
             'Diagnostic projection only; admission verdict and blocking logic are unchanged.','',
             '| Control | Verdict | Blocking |','|---|---|---|']
    summary += ['| '+row['control']+' | '+row['verdict']+' | '+str(row['blocking']).lower()+' |' for row in rows]
    summary += ['', 'Free-text findings, raw evidence, filenames and unknown result identifiers are omitted.','']
    out=Path(out);out.mkdir(parents=True,exist_ok=False)
    write(out/'gate-decision.json',safe_decision)
    write(out/'evidence-manifest.json',safe_manifest)
    write(out/'summary.md','\n'.join(summary))

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    for key in ('gate','out','policy'):
        parser.add_argument('--'+key,required=True)
    args=parser.parse_args()
    collect(args.gate,args.out,args.policy)
