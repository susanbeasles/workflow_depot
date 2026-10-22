#!/usr/bin/env python3
"""Require a successful pnpm advisory response before emitting zero findings."""
import argparse
import json
from pathlib import Path


def normalize(text, rc):
    items, errors = [], []
    try:
        report = json.loads(text)
        if not isinstance(report, dict) or 'error' in report:
            raise ValueError('audit returned an error or non-object response')
        advisories = report.get('advisories')
        if not isinstance(advisories, dict):
            raise ValueError('missing or invalid advisories object')
        for advisory in advisories.values():
            if not isinstance(advisory, dict):
                raise ValueError('advisory is not an object')
            severity = advisory.get('severity')
            if severity not in {'info', 'low', 'moderate', 'medium', 'high', 'critical'}:
                raise ValueError('missing or unknown advisory severity')
            if not isinstance(advisory.get('module_name'), str) or not isinstance(advisory.get('title'), str):
                raise ValueError('missing advisory package or title')
            items.append({'severity': 'medium' if severity == 'moderate' else severity,
                          'rule': advisory.get('github_advisory_id') or 'pnpm-audit',
                          'package': f"{advisory['module_name']}@{advisory.get('vulnerable_versions', '')}",
                          'path': 'pnpm-lock.yaml', 'message': advisory['title'][:200]})
    except (ValueError, TypeError) as exc:
        errors.append(f'invalid audit response: {exc}')
    if rc not in (0, 1):
        errors.append('audit process failed')
    if rc != 0 and not items:
        errors.append('nonzero audit exit without legitimate advisories')
    return {'items': items, 'parse_error': '; '.join(errors) if errors else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--exit-code', type=int, required=True)
    args = ap.parse_args()
    try:
        text = Path(args.input).read_text()
    except (OSError, UnicodeError):
        text = ''
    result = normalize(text, args.exit_code)
    Path(args.output).write_text(json.dumps(result))
    raise SystemExit(3 if result['parse_error'] else 0)


if __name__ == '__main__':
    main()
