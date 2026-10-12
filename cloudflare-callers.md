# Cloudflare authorization caller

This source increment is disabled and has not dispatched a workflow or uploaded
an artifact. `scripts/request-cloudflare-authorization.mjs` submits an exact
canonical operation and its current authorizer identity to the existing depot
authority. The service independently verifies its retained policy, exact target,
artifact and metadata digests, candidate signing/CI evidence, nonce, expiry and
the waiting execution run. A submitted digest is not independent authority.

The dispatch entry is `.github/workflows/authorize-cloudflare.yml`. Its local
reusable job, `cloudflare-authorizer.yml`, runs the same actual commit and supplies
the reusable-workflow OIDC claims required by the existing verifier. Both jobs
use only contents read and OIDC issuance; no provider secret or application code
is requested. The caller script checks repository, numeric repository/owner IDs,
event, main ref, workflow ref, run/attempt and current SHA before obtaining OIDC.
The entire service request uses fixed source-owned destinations, bounded reads,
timeouts and rejected redirects. An ambiguous authorization response is not
automatically retried.

Commissioning must set the source-owned `CONFIG.enabled` switch only after review
and install the actual final signed workflow commit IDs in the service's retained
policy. No file contains a fake pin or its own future commit SHA. The caller does
not load a policy snapshot containing its own workflow SHA from its checkout.
Current repository metadata was read through the authorized GitHub connector:

| Identity | Required value |
| --- | --- |
| repository / numeric ID | `susanbeasles/workflow_depot` / `1405415683` |
| owner ID / ref / event | `215839550` / `refs/heads/main` / `workflow_dispatch` |
| workflowRef | `susanbeasles/workflow_depot/.github/workflows/authorize-cloudflare.yml@refs/heads/main` |
| jobWorkflowRef | `susanbeasles/workflow_depot/.github/workflows/cloudflare-authorizer.yml@refs/heads/main` |
| audience | `workflow-depot-deployment-authorizer:<operationID>` |
| authority endpoint | `https://pipeline.vespoli.me/v1/deployments/authorize` |

The hostname is an approved source proposal, not evidence of live commissioning.
The retained policy also needs actual `workflowSHA`, `jobWorkflowSHA` and approved
actor IDs; the live GitHub claim shape must be qualified before activation.

The operation must already identify the exact approved artifact/source and a
known operation ID. Start the delivery executor for that ID, obtain its public
run/attempt coordinates, then authorize an operation containing those exact
coordinates within its 120-second wait. The operation input is canonical sorted
JSON without extra whitespace, plus its SHA-256 digest. The executor does not
construct a target or supply its own authority. This is a bounded caller sequence,
not automatic cross-repository dispatch or a new scheduler.

The existing authority schema is the source of truth for target variants,
including explicitly approved ingress. No application bundle is uploaded by this
caller. Artifact retention/provenance remains a separate precondition.

Local verification: `node --test test/cloudflare-authorization-caller.test.mjs`.
The tests use synthetic fetch and the real retained authority implementation.
Action pins reuse the reviewed checkout v7.0.1 and setup-node v6.3.0 commits already
used by the central pipeline. No commit, push, credential read or live call is
performed by these tests.
