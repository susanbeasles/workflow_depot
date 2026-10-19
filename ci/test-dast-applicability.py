"""Offline regression: no-target DAST must not load the nested third-party action."""
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import types
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "security-assurance/.github/scripts"
spec = importlib.util.spec_from_file_location("gate", SCRIPTS / "gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class DastApplicability(unittest.TestCase):
    def setUp(self):
        workflow = yaml.load((ROOT / ".github/workflows/security-assurance.yml").read_text(), Loader=yaml.BaseLoader)
        self.steps = workflow["jobs"]["analyze"]["steps"]

    def test_action_loading_requires_a_target(self):
        step = next(s for s in self.steps if s.get("uses", "").endswith("/dast-zap"))
        self.assertEqual(step["if"], "matrix.scan == 'dast-zap' && inputs.dast_target_url != ''")
        self.assertIn("inputs.dast_authorization_ref", step["with"]["authorization_ref"])
        guard = next(s for s in self.steps if s.get("name") == "Reject unapproved or public dynamic preview targets")
        self.assertLess(self.steps.index(guard), self.steps.index(step))
        self.assertIn("previewTarget(process.env.DAST_TARGET,process.env.DAST_APPROVAL)", guard["run"])

    def test_no_target_emits_gate_evidence_without_loading_an_action(self):
        step = next(s for s in self.steps if s.get("name") == "Report DAST applicability without loading ZAP")
        self.assertEqual(step["if"], "matrix.scan == 'dast-zap' && inputs.dast_target_url == ''")
        self.assertNotIn("uses", step)
        for detected, expected in [("false", "NOT_APPLICABLE"), ("true", "POLICY_UNAVAILABLE"), ("", "POLICY_UNAVAILABLE")]:
            with self.subTest(detected=detected), tempfile.TemporaryDirectory() as td:
                env = {**os.environ, "DEPOT": str(ROOT / "security-assurance"), "RESULTS_DIR": td, "WEB_APP_DETECTED": detected}
                subprocess.run(["bash", "-e", "-c", step["run"]], env=env, check=True, capture_output=True)
                result = json.loads(pathlib.Path(td, "DAST-ZAP.json").read_text())
                self.assertEqual(result["status"], expected)
                self.assertFalse(gate.schema_errors(result))
                verdict, reason = gate.evaluate_control({"fail_on": ["high"]}, result, types.SimpleNamespace(sha="", repo=""), {})
                self.assertEqual(verdict in gate.OK_STATUSES, detected == "false")
                self.assertTrue(reason)


if __name__ == "__main__":
    unittest.main()
