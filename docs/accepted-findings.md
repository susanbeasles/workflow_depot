# Accepted findings

Some security-assurance findings are correct matches on harmless content. Examples:

- documentation that describes an attack the product detects (`curl | sh`);
- agent instructions that forbid it;
- Apple's standard plist header.

A repository records these in `.security/accepted-findings.yml`:

```yaml
version: 1
accepted:
  - rule: SUSP_Shell_Curl_Pipe_Sh          # the scanner's rule id
    path: README.md                        # relative to the repository root
    sha256: <sha256 of the file's bytes>   # sha256sum README.md
    reason: Documents the attack Porchlight detects.
    expires: 2027-04-15                    # at most 366 days ahead
```

| Rule | How it works |
|---|---|
| Source of truth | The list is read from the repository's **default branch**, never from the commit under test. A change can't accept its own findings: the list must be reviewed and merged first. Add `.security/` to CODEOWNERS. |
| Exact match only | A finding is accepted only when its rule, path and the file's current SHA-256 all match. Any edit to the file blocks again until the entry is renewed. |
| Recorded, not hidden | Accepted findings move from `items` to `accepted` in the evidence, with their reason and expiry, so the signed evidence bundle still shows them. |
| Fails closed | A malformed list, a missing reason, an expiry more than 366 days out, or an unknown key fails the control (`TOOL_FAILURE`). Expired entries are ignored. |
| Scope | Applied where a scanner counts findings with `count_blocking.py` in a job that checked out full history: the stage-0 admission scans. |

Implementation: `security-assurance/.github/scripts/count_blocking.py`, wired through
`ACCEPTED_REPO` and `ACCEPTED_REF` in `ci/adapt_security.py`. Tests: `ci/test-accepted-findings.py`.
