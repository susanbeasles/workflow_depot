"""Deterministic adapter; original imported module remains byte-for-byte intact."""
def adapt(original):
 addition='      - name: Materialize intact security-assurance module\n        run: cp -a -- .security-depot/security-assurance/. .security-depot/\n'
 text=original.replace('    inputs:\n','    inputs:\n      integration_artifact_name:\n        description: "Same-run immutable build artifact; empty keeps source-only behavior"\n        type: string\n        default: ""\n      admission_only:\n        description: "Only source admission; PASS is not release approval"\n        type: boolean\n        default: false\n',1)
 text=text.replace('value: ${{ jobs.evidence-sign.outputs.decision }}','value: ${{ inputs.admission_only && jobs.gate-stage0.outputs.decision || jobs.evidence-sign.outputs.decision }}')
 text=text.replace('name: results-detect', 'name: "results-detect"').replace('name: results-ai-review', 'name: "results-ai-review"')
 text=text.replace('results-', "results-${{ inputs.admission_only && 'admission' || 'full' }}-")
 text=text.replace('group: security-assurance-${{ github.repository }}','group: security-assurance-${{ inputs.admission_only }}-${{ github.repository }}')
 # Skip later stages only for the explicit admission phase. Default full policy is unchanged.
 for name in ['analyze','codeql','gate-stage2','ai-review','evidence-sign']:
  start=text.index('\n  '+name+':'); end=text.find('\n  ',start+4)
  # Find the job-level conditional, not matrix step conditionals.
  pos=text.index('\n    if: ',start); line_end=text.index('\n',pos+1)
  text=text[:pos]+text[pos:line_end].replace('if: ','if: ${{ !inputs.admission_only && (',1)+') }}'+text[line_end:]
 lines=text.splitlines(True);result=[]
 for i,line in enumerate(lines):
  result.append(line)
  if 'with: { repository:' in line and 'path: .security-depot' in line:result.append(addition)
 text=''.join(result)
 for name in ['admit','analyze']:
  start=text.index('\n  '+name+':');pos=text.index(addition,start)+len(addition)
  injection="      - if: inputs.integration_artifact_name != '' && !inputs.admission_only\n        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333\n        with:\n          name: ${{ inputs.integration_artifact_name }}\n          path: .integration-build\n      - if: inputs.integration_artifact_name != '' && !inputs.admission_only\n        name: Verify build identity and byte inventory before scanning\n        run: python3 .security-depot/ci/verify-build.py  .integration-build\n"
  text=text[:pos]+injection+text[pos:]
 start=text.index('\n  admit:');end=text.index('\n  gate-stage0:',start)
 segment=text[start:end]
 for scan in ['secrets-scan','malware-scan','asset-scan','ai-injection-scan','binary-forensics']:
  at=segment.index("      - if: matrix.scan == '"+scan+"'")
  until=segment.find('\n      - ',at+1)
  if until<0:until=len(segment)
  block=segment[at:until].replace('source_path: src',"source_path: \"${{ inputs.integration_artifact_name != '' && !inputs.admission_only && '.integration-build/payload' || 'src' }}\"")
  segment=segment[:at]+block+segment[until:]
 text=text[:start]+segment+text[end:]
 start=text.index('\n  analyze:');pos=text.index(addition,start)+len(addition)
 guard="      - if: matrix.scan == 'dast-zap' || matrix.scan == 'api-schemathesis'\n        name: Reject unapproved or public dynamic preview targets\n        env:\n          DAST_TARGET: ${{ inputs.dast_target_url }}\n          DAST_APPROVAL: ${{ inputs.dast_authorization_ref }}\n          API_TARGET: ${{ inputs.api_target_url }}\n          API_APPROVAL: ${{ inputs.api_authorization_ref }}\n        run: |\n          node --input-type=module <<'JS'\n          import {previewTarget} from './.security-depot/ci/preview-guard.mjs';\n          previewTarget(process.env.DAST_TARGET,process.env.DAST_APPROVAL);\n          previewTarget(process.env.API_TARGET,process.env.API_APPROVAL);\n          JS\n"
 text=text[:pos]+guard+text[pos:]
 start=text.index('\n  codeql:');pos=text.index(addition,start)+len(addition)
 text=text[:pos]+'      - name: Apply owned CodeQL Advanced configuration\n        run: python3 .security-depot/ci/materialize-codeql.py\n'+text[pos:]
 # Accepted findings are read from the scanned repository's default branch, never from the
 # commit under test (scripts/count_blocking.py).
 env_anchor='  DEPOT: ${{ github.workspace }}/.security-depot\n'
 assert text.count(env_anchor)==1
 text=text.replace(env_anchor,env_anchor+'  ACCEPTED_REPO: ${{ github.workspace }}/src\n  ACCEPTED_REF: refs/remotes/origin/${{ github.event.repository.default_branch }}\n')
 # Callers' Actions policy allows only owner and GitHub actions: install cosign from the
 # SHA-256 pinned tool registry instead of the third-party sigstore/cosign-installer.
 installer='      - uses: sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4.1.2\n'
 assert text.count(installer)==1
 text=text.replace(installer,'      # cosign comes from the tool registry (SHA-256 pinned, fail closed), not a third-party\n      # action: callers\' Actions policy allows only owner and GitHub actions.\n      - uses: ./.security-depot/.github/actions/install-tool\n        with: { tool: cosign }\n')
 # actions/setup-python's interpreter has no PyYAML, and every registry read and tool install
 # imports yaml. A venv over the runner's system Python keeps its PyYAML and still allows the
 # registry-pinned pip installs (the system interpreter itself is externally managed).
 setup_py='        uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0\n        with: { python-version: "3.12" }\n'
 assert text.count(setup_py)==1
 text=text.replace(setup_py,'        name: Python venv over the system interpreter (keeps its PyYAML)\n        run: |\n          /usr/bin/python3 -c "import yaml"\n          /usr/bin/python3 -m venv --system-site-packages "$RUNNER_TEMP/pyenv"\n          echo "$RUNNER_TEMP/pyenv/bin" >> "$GITHUB_PATH"\n          # Depot scanner installs must not seed the pip cache that CACHE-CONTENT audits.\n          echo "PIP_NO_CACHE_DIR=1" >> "$GITHUB_ENV"\n')
 # Caller-waived CodeQL languages (space-separated). A waived language reports NOT_APPLICABLE with the
 # waiver in its reason, so it is named in the evidence instead of silently absent; the other
 # languages still gate, and SAST-SEMGREP (which includes p/swift) still gates the waived code.
 waive_in='      codeql_waive_languages:\n        description: "Space-separated CodeQL languages the caller waives; only swift (covered by Semgrep p/swift) is honored, others still run"\n        type: string\n        default: ""\n'
 text=text.replace('    inputs:\n','    inputs:\n'+waive_in,1)
 codeql_step='      - uses: ./.security-depot/.github/actions/sast-codeql\n'
 assert text.count(codeql_step)==1
 # Only languages with a Semgrep pack in the default registry list may be waived (today: swift);
 # any other listed language is ignored and CodeQL still runs on it.
 waived="matrix.language == 'swift' && contains(format(' {0} ', inputs.codeql_waive_languages), format(' {0} ', matrix.language))"
 text=text.replace(codeql_step,
  "      - name: CodeQL waived by caller\n        if: ${{ "+waived+" }}\n"
  "        run: python3 .security-depot/.github/scripts/result.py --control \"SAST-CODEQL-${{ matrix.language }}\" --domain A --status NOT_APPLICABLE --reason \"waived by caller (codeql_waive_languages); SAST-SEMGREP still gates this code\" --tool codeql\n"
  "      - if: ${{ !("+waived+") }}\n        uses: ./.security-depot/.github/actions/sast-codeql\n")
 return text
if __name__=='__main__':
 import pathlib
 root=pathlib.Path(__file__).resolve().parents[1]
 (root/'.github/workflows/security-assurance.yml').write_text(adapt((root/'security-assurance/.github/workflows/security-assurance.yml').read_text()))
