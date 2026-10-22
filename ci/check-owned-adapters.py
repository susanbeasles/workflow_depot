import pathlib,json,hashlib,tempfile,shutil,subprocess,yaml
root=pathlib.Path(__file__).resolve().parents[1]
components=json.loads((root/'ci/source-components.json').read_text())
assert components['commit']=='447e4cafe983a4dd68b60632d2c6e3d4c56367e8'
for f in components['files']:assert hashlib.sha256((root/f['path']).read_bytes()).hexdigest()==f['sha256']
action=yaml.safe_load((root/'security-assurance/.github/actions/sast-codeql/action.yml').read_text())
steps=action['runs']['steps']
assert any('github/codeql-action/setup-codeql@24c54180a607b1449ed407dd24f251e4e9147c8d'==s.get('uses') for s in steps)
assert any('codeql_isolated.py' in s.get('run','') for s in steps)
assert not any('bash -c' in s.get('run','') for s in steps)
helper=(root/'security-assurance/.github/scripts/codeql_isolated.py').read_text()
assert '-security-extended.qls' in helper and "'--build-mode=none'" in helper
workflow=yaml.safe_load((root/'.github/workflows/security-assurance.yml').read_text())
assert 'security-events' not in workflow['jobs']['codeql-extract']['permissions']
assert 'codeql-extract' in workflow['jobs']['codeql']['needs']
config=yaml.load((root/'ci/codeql/config.yml').read_text(),Loader=yaml.BaseLoader)
assert config['disable-default-queries']=='false' and config['queries']==[{'uses':'security-extended'}]
assert 'paths-ignore' not in config and 'query-filters' not in config
for name in ['accepted-main-artifacts','request-deployment','main-deployment']:
 w=yaml.load((root/f'.github/workflows/{name}.yml').read_text(),Loader=yaml.BaseLoader);assert set(w['on'])=={'workflow_call'}
main=yaml.load((root/'.github/workflows/accepted-main-artifacts.yml').read_text(),Loader=yaml.BaseLoader)
steps=main['jobs']['consume']['steps'];runs='\n'.join(s.get('run','') for s in steps)
assert 'cosign verify-blob' in runs and 'package-bundle.mjs' in runs and 'npm' not in runs
assert sum('main-source-run.mjs' in s.get('run','') for s in steps)==2
print('Verified canonical source hashes, owned CodeQL config without exclusions, and main packaging without rebuild or authority substitutes.')

combined=yaml.load((root/'.github/workflows/main-deployment.yml').read_text(),Loader=yaml.BaseLoader)
assert combined['jobs']['dispatch']['needs']=='artifact'
assert combined['jobs']['artifact']['uses']=='./.github/workflows/accepted-main-artifacts.yml'
assert combined['jobs']['dispatch']['uses']=='./.github/workflows/request-deployment.yml'
