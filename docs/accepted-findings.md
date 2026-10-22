# Finding rationale annotations

`.security/accepted-findings.yml` retains the existing entry format for reviewed rationale. It does not waive a finding, change its severity or reduce a blocking count. A confirmed High or Critical finding still blocks after its rationale is recorded.

```yaml
version: 1
accepted:
  - rule: SUSP_Shell_Curl_Pipe_Sh
    path: README.md
    sha256: <SHA-256 of the exact file bytes>
    reason: Documents the attack the product detects; remediation remains required.
    expires: 2027-04-15
```

Entries come from the repository default branch, never the commit under test. Exact rule, path and current file digest must match. A reason and unexpired date at most 366 days ahead are required. Malformed entries fail closed; missing metadata or expired entries provide no annotation.

Matching rationale appears in `acceptance_annotations` with an item index, exact identity, reason and expiry. The original `items` array remains intact. Recounting annotated evidence is idempotent. Legacy evidence that moved findings into a nonempty `accepted` array fails closed and must be re-normalized from original evidence; it cannot certify an empty blocking set.

`ACCEPTED_REPO` and `ACCEPTED_REF` identify optional read-only default-branch metadata in the proposed adapter. Missing refs never authorize suppression. Tests in `ci/test-accepted-findings.py` verify the original High/Critical count remains blocking after annotation, exact-match validation, expiry, malformed entries, repeated counting and legacy-evidence refusal.

Swift CodeQL coverage remains required and explicitly unqualified in the permitted runner boundary. Its control reports `POLICY_UNAVAILABLE` rather than caller-waived `NOT_APPLICABLE` or replacement `PASS`. Semgrep's Swift rules remain additional coverage. A reviewed qualified CodeQL execution boundary and final evidence are still required before Swift can pass.
