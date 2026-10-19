'use strict';
// Embedded verbatim in checkout-free resolver jobs. Trust comes from fetching a fresh token
// directly from GitHub over TLS in an isolated job, never from decoding caller-supplied JWTs.
const {appendFileSync} = require('node:fs');
const AUDIENCE = 'workflow-depot-source-resolution';
const REPOSITORY = 'susanbeasles/workflow_depot';
async function resolveSource(env = process.env, fetcher = fetch, now = Date.now()) {
  try {
    const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.actions.githubusercontent.com') || endpoint.username || endpoint.password || endpoint.port || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw Error();
    endpoint.searchParams.set('audience', AUDIENCE);
    const response = await fetcher(endpoint, {headers: {authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`}, redirect: 'error', signal: AbortSignal.timeout(15000)});
    if (response.status !== 200) throw Error();
    const text = await response.text();
    if (text.length > 32768) throw Error();
    const parts = JSON.parse(text).value.split('.');
    if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw Error();
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== AUDIENCE ||
        !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 || claims.iat < seconds - 600 ||
        !Number.isFinite(claims.nbf) || claims.nbf > seconds + 60) throw Error();
    for (const [claim, key] of [['repository','GITHUB_REPOSITORY'],['run_id','GITHUB_RUN_ID'],['run_attempt','GITHUB_RUN_ATTEMPT']]) {
      if (!env[key] || claims[claim] !== env[key]) throw Error();
    }
    // EXPECTED_WORKFLOW is a literal in the reusable workflow, never an input.
    if (!/^[a-z0-9-]+\.yml$/.test(env.EXPECTED_WORKFLOW || '')) throw Error();
    const prefix = `${REPOSITORY}/.github/workflows/${env.EXPECTED_WORKFLOW}@`;
    if (typeof claims.job_workflow_ref !== 'string' || !claims.job_workflow_ref.startsWith(prefix) || !/^\S+$/.test(claims.job_workflow_ref.slice(prefix.length))) throw Error();
    const sha = claims.job_workflow_sha;
    if (!/^[a-f0-9]{40}$/.test(sha || '') || env.DEPOT_REF !== sha || env.DEPOT_REPOSITORY !== REPOSITORY) throw Error();
    return sha;
  } catch {
    // Do not expose response bodies, token contents, URLs or network exception messages.
    throw Error('Unable to bind depot source to this reusable workflow revision');
  }
}
module.exports = {resolveSource, AUDIENCE};
if (require.main === module) resolveSource().then(sha => {
  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
}).catch(() => { console.error('Unable to bind depot source to this reusable workflow revision'); process.exitCode = 1; });
