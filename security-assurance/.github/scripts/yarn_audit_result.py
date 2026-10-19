#!/usr/bin/env python3
"""Normalize Yarn audit only when its payload proves the advisory request completed."""
import argparse
import json
from pathlib import Path


def normalize(text, mode, rc):
    items, errors, completed = [], [], False
    try:
        for line in text.splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError('audit record is not an object')
            if row.get('type') == 'error':
                errors.append('package manager reported an error')
            elif mode == 'classic' and row.get('type') == 'auditSummary':
                counts = row['data']['vulnerabilities']
                if not isinstance(counts, dict) or not counts or any(type(x) is not int or x < 0 for x in counts.values()):
                    raise ValueError('invalid audit summary')
                completed = True
                if sum(counts.values()) and not items:
                    errors.append('summary reports vulnerabilities without advisories')
            elif mode == 'classic' and row.get('type') == 'auditAdvisory':
                advisory = row['data']['advisory']
                severity = advisory['severity']
                if severity not in {'info', 'low', 'moderate', 'medium', 'high', 'critical'}:
                    raise ValueError('unknown advisory severity')
                items.append({'severity': 'medium' if severity == 'moderate' else severity, 'rule': advisory.get('github_advisory_id') or 'yarn-audit', 'package': advisory.get('module_name', ''), 'path': 'yarn.lock', 'message': str(advisory.get('title', ''))[:200]})
            elif mode == 'berry' and 'value' in row and 'children' in row:
                child = row['children']
                severity = str(child['Severity']).lower()
                if severity not in {'info', 'low', 'moderate', 'medium', 'high', 'critical'}:
                    raise ValueError('unknown advisory severity')
                items.append({'severity': 'medium' if severity == 'moderate' else severity, 'rule': str(row['value']), 'package': str(child.get('Vulnerable Versions', '')), 'path': 'yarn.lock', 'message': str(child.get('Issue', ''))[:200]})
                completed = True
            elif mode == 'berry' and row.get('type') == 'info' and row.get('name') == 0 and row.get('data') == 'No audit suggestions':
                completed = True
    except (ValueError, KeyError, TypeError) as exc:
        errors.append(f'invalid audit output: {exc}')
    if not completed:
        errors.append('no successful advisory response')
    if rc < 0 or (mode == 'berry' and rc > 1) or (mode == 'classic' and rc > 31):
        errors.append('audit process failed')
    if rc != 0 and not items:
        errors.append('nonzero audit exit without legitimate advisories')
    return {'items': items, 'parse_error': '; '.join(errors) if errors else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--mode', choices=['classic', 'berry'], required=True)
    ap.add_argument('--exit-code', type=int, required=True)
    args = ap.parse_args()
    result = normalize(Path(args.input).read_text(), args.mode, args.exit_code)
    Path(args.output).write_text(json.dumps(result))
    raise SystemExit(3 if result['parse_error'] else 0)


if __name__ == '__main__':
    main()
