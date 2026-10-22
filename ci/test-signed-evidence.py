#!/usr/bin/env python3
import importlib.util
import io
import json
import hashlib
import pathlib
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import yaml
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('verify', pathlib.Path(__file__).resolve().parents[1] / 'security-assurance/.github/scripts/verify_evidence.py')
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)

class SignedEvidence(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = pathlib.Path(self.tmp.name)
        candidate = {'repository': 'owner/repo', 'sha': 'a' * 40}
        self.files = {'gate-all/gate-decision.json': json.dumps({'decision': 'PASS', 'stage': 'all', 'candidate': candidate}).encode(), 'gate-all/evidence-manifest.json': json.dumps({'candidate': candidate, 'entries': [{'result_file':'CONTROL.json', 'sha256': hashlib.sha256(b'{}').hexdigest(), 'evidence': []}]}).encode(), 'CONTROL.json': b'{}'}
    def run_verify(self, extra=None, signature_status=0):
        for name, data in self.files.items():
            p = self.d / name
            p.parent.mkdir(parents=True, exist_ok=True)
            if not p.exists(): p.write_bytes(data)
        with tarfile.open(self.d / 'evidence-bundle.tar.gz', 'w:gz') as tar:
            for name, data in self.files.items():
                info = tarfile.TarInfo('./' + name); info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            if extra: tar.addfile(extra)
        (self.d / 'evidence-bundle.sigstore.json').write_text('{}')
        argv = ['verify', '--dir', str(self.d), '--sha', 'a'*40, '--repo', 'owner/repo', '--require-signature', '--cosign-identity-regexp', '^trusted$']
        with patch('sys.argv', argv), patch.object(verify.subprocess, 'run') as cosign:
            cosign.return_value.returncode = signature_status
            with self.assertRaises(SystemExit) as result: verify.main()
        return result.exception.code
    def test_valid_authenticated_bundle(self): self.assertEqual(self.run_verify(), 0)
    def test_forged_loose_gate(self):
        p = self.d / 'gate-all'; p.mkdir()
        (p / 'gate-decision.json').write_bytes(self.files['gate-all/gate-decision.json'])
        gate = json.loads(self.files['gate-all/gate-decision.json']); gate['decision'] = 'FAIL'
        self.files['gate-all/gate-decision.json'] = json.dumps(gate).encode()
        self.assertEqual(self.run_verify(), 1)
    def test_missing_signed_gate(self):
        p = self.d / 'gate-all'; p.mkdir()
        (p / 'gate-decision.json').write_bytes(self.files.pop('gate-all/gate-decision.json'))
        self.assertEqual(self.run_verify(), 1)
    def test_archive_traversal(self): self.assertEqual(self.run_verify(tarfile.TarInfo('../escape')), 1)
    def test_archive_symlink(self):
        info = tarfile.TarInfo('link'); info.type = tarfile.SYMTYPE; info.linkname = '/etc/passwd'
        self.assertEqual(self.run_verify(info), 1)
    def test_unsigned_result_replacement(self):
        (self.d / 'CONTROL.json').write_bytes(b'{}')
        self.files['CONTROL.json'] = b'{"tampered":true}'
        self.assertEqual(self.run_verify(), 1)

    def test_duplicate_member(self):
        self.assertEqual(self.run_verify(tarfile.TarInfo('./CONTROL.json')), 1)
    def test_decompression_limit(self):
        with patch.object(verify, 'MAX_ARCHIVE_BYTES', 100):
            self.assertEqual(self.run_verify(), 1)
    def test_member_limit(self):
        with patch.object(verify, 'MAX_MEMBER_BYTES', 10):
            self.assertEqual(self.run_verify(), 1)
    def test_member_count_limit(self):
        with patch.object(verify, 'MAX_MEMBERS', 1):
            self.assertEqual(self.run_verify(), 1)
    def test_manifest_candidate_mismatch(self):
        manifest = json.loads(self.files['gate-all/evidence-manifest.json'])
        manifest['candidate']['sha'] = 'b' * 40
        self.files['gate-all/evidence-manifest.json'] = json.dumps(manifest).encode()
        self.assertEqual(self.run_verify(), 1)
    def test_absolute_dependency_rejected(self):
        manifest = json.loads(self.files['gate-all/evidence-manifest.json'])
        manifest['entries'][0]['result_file'] = str(self.d / 'CONTROL.json')
        self.files['gate-all/evidence-manifest.json'] = json.dumps(manifest).encode()
        self.assertEqual(self.run_verify(), 1)
    def test_result_directory_prefix_supported(self):
        manifest = json.loads(self.files['gate-all/evidence-manifest.json'])
        manifest['entries'][0]['result_file'] = 'security-results/CONTROL.json'
        self.files['gate-all/evidence-manifest.json'] = json.dumps(manifest).encode()
        self.assertEqual(self.run_verify(), 0)

    def test_invalid_signature(self): self.assertEqual(self.run_verify(signature_status=1), 1)
    def test_expanded_size_limit(self):
        self.files['padding'] = b'0' * 65536
        with patch.object(verify, 'MAX_ARCHIVE_BYTES', 4096):
            self.assertEqual(self.run_verify(), 1)
    def test_missing_signed_evidence(self):
        manifest = json.loads(self.files['gate-all/evidence-manifest.json'])
        manifest['entries'][0]['evidence'] = [{'path': 'evidence/missing', 'sha256':'0'*64}]
        self.files['gate-all/evidence-manifest.json'] = json.dumps(manifest).encode()
        self.assertEqual(self.run_verify(), 1)

    def test_emitter_records_portable_evidence(self):
        evidence = self.d / 'evidence' / 'scan.json'
        evidence.parent.mkdir(); evidence.write_bytes(b'{}')
        script = pathlib.Path(verify.__file__).with_name('result.py')
        result = subprocess.run([sys.executable, str(script), '--control', 'CONTROL', '--status', 'PASS', '--evidence', str(evidence)], env={**os.environ, 'RESULTS_DIR':str(self.d)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads((self.d / 'CONTROL.json').read_text())
        self.assertEqual(record['evidence'][0]['path'], 'evidence/scan.json')
        self.assertEqual(record['evidence'][0]['sha256'], hashlib.sha256(b'{}').hexdigest())

    def test_alternate_loose_gate_rejected(self):
        (self.d / 'gate-decision.json').write_text('{"decision":"FAIL"}')
        self.assertEqual(self.run_verify(), 1)

    def test_promotion_output_is_owned_by_final_signature_step(self):
        workflow = pathlib.Path(verify.__file__).parents[1] / 'workflows/security-assurance.yml'
        job = yaml.safe_load(workflow.read_text())['jobs']['evidence-sign']
        self.assertEqual(job['outputs']['decision'], '${{ steps.signed.outputs.decision }}')
        signed = next(step for step in job['steps'] if step.get('id') == 'signed')
        final = next(step for step in job['steps'] if step.get('id') == 'final')
        self.assertLess(job['steps'].index(final), job['steps'].index(signed))

    def test_final_signature_failure_cannot_emit_promotion_pass(self):
        workflow = pathlib.Path(verify.__file__).parents[1] / 'workflows/security-assurance.yml'
        job = yaml.safe_load(workflow.read_text())['jobs']['evidence-sign']
        step = next(step for step in job['steps'] if step.get('name') == 'Sign and verify the final promotion decision')
        # Exercise the actual workflow shell offline. Only the external signer
        # and verifier process are stand-ins, with controlled failure statuses.
        bindir = self.d / 'bin'; bindir.mkdir()
        cosign = bindir / 'cosign'; cosign.write_text('#!/bin/sh\nexit 0\n'); cosign.chmod(0o755)
        scripts = self.d / '.github/scripts'; scripts.mkdir(parents=True)
        stub = scripts / 'verify_evidence.py'
        for exit_status in (1, 0):
            with self.subTest(exit_status=exit_status):
                run = self.d / str(exit_status); run.mkdir()
                (run / 'security-results').mkdir()
                (run / 'security-results/fixture').write_text('synthetic evidence')
                output = run / 'output'; output.touch()
                stub.write_text('raise SystemExit(' + str(exit_status) + ')\n')
                env = {**os.environ, 'PATH':str(bindir) + os.pathsep + os.environ['PATH'], 'DEPOT':str(self.d), 'GITHUB_SHA':'a'*40, 'GITHUB_REPOSITORY':'owner/repo', 'GITHUB_OUTPUT':str(output)}
                result = subprocess.run(['bash', '-c', step['run']], cwd=run, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, exit_status, result.stderr)
                self.assertEqual(output.read_text(), '' if exit_status else 'decision=PASS\n')

if __name__ == '__main__': unittest.main()
