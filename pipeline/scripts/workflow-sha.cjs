'use strict';
// pipeline/scripts/workflow-sha.cjs: find the workflow_depot commit this reusable workflow runs at.
// Embedded byte for byte in pipeline.yml (shell: node {0}); pipeline/test checks that the two match.
// It reads this job's OIDC token, decodes the job_workflow_sha claim and writes `sha=<40 hex>` to
// GITHUB_OUTPUT. The signature is not checked: this only picks which commit to check out, and the
// authorizer verifies its own token. The token's audience is accepted by no service, so a leaked
// token is worthless. The token is never printed.
const { appendFileSync } = require('node:fs');

const AUDIENCE = 'workflow-depot-route';
const WORKFLOW = 'susanbeasles/workflow_depot/.github/workflows/pipeline.yml@';
const SHA = /^[0-9a-f]{40}$/;

class RouteError extends Error {}

function decodeClaims(jwt) {
  const parts = typeof jwt === 'string' ? jwt.split('.') : [];
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new RouteError('OIDC token is not a JWT');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new RouteError('OIDC token payload is not JSON');
  }
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) throw new RouteError('OIDC token payload is not an object');
  return claims;
}

function workflowSha(claims) {
  const ref = claims.job_workflow_ref;
  if (typeof ref !== 'string' || !ref.startsWith(WORKFLOW) || ref.length === WORKFLOW.length) {
    throw new RouteError('job_workflow_ref is not susanbeasles/workflow_depot pipeline.yml: run this job only inside the reusable pipeline');
  }
  const sha = claims.job_workflow_sha;
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new RouteError('job_workflow_sha is missing or not 40 lowercase hex');
  return sha;
}

async function oidcToken(env, fetchImpl) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new RouteError('no OIDC token available: the job needs `permissions: id-token: write`');
  const target = new URL(url);
  target.searchParams.set('audience', AUDIENCE);
  const res = await fetchImpl(target, { headers: { authorization: `bearer ${bearer}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (res.status !== 200) throw new RouteError(`OIDC token request failed with ${res.status}`);
  const text = await res.text();
  if (text.length > 16384) throw new RouteError('OIDC token response too large');
  let value;
  try {
    value = JSON.parse(text).value;
  } catch {
    throw new RouteError('OIDC token response is not JSON');
  }
  if (typeof value !== 'string') throw new RouteError('OIDC token response has no token');
  return value;
}

async function main(env = process.env, fetchImpl = fetch, log = console.log) {
  const sha = workflowSha(decodeClaims(await oidcToken(env, fetchImpl)));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `sha=${sha}\n`);
  log(`workflow_depot pipeline.yml runs at ${sha}`);
  return sha;
}

module.exports = { AUDIENCE, WORKFLOW, RouteError, decodeClaims, workflowSha, oidcToken, main };

if (require.main === module) {
  main().catch((error) => {
    console.log(`::error title=workflow-sha::${error instanceof RouteError ? error.message : 'unexpected failure'}`);
    process.exitCode = 1;
  });
}
