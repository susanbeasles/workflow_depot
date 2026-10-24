// Stage 7: the authorizer privately hands the grant to the deployer. Admission is never completion.
import { ActionError, ask, oidcToken, repoIdentity, setOutputs, SHA } from '../_lib/authorizer.mjs';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PHASES = new Set(['REQUESTED', 'AUTHORIZED', 'QUEUED', 'VERIFYING', 'PLANNED', 'DEPLOYING_TARGETS', 'HEALTH_CHECKING', 'COMMITTING', 'SUCCEEDED', 'RECOVERING', 'ROLLED_BACK', 'RECOVERY_FAILED', 'REJECTED']);
const FAILED = new Set(['ROLLED_BACK', 'RECOVERY_FAILED', 'REJECTED']);
const requireValue = (condition, message) => { if (!condition) throw new ActionError(message); };

export function requestFromEnvironment(env) {
  requireValue(env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main', 'deploy requires a main push');
  repoIdentity(env);
  requireValue(SHA.test(env.GITHUB_SHA ?? ''), 'source commit must be an immutable SHA');
  requireValue(/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(env.INPUT_APPLICATION ?? ''), 'invalid deployment application');
  requireValue(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(env.INPUT_ENVIRONMENT ?? ''), 'invalid deployment environment');
  requireValue(/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(env.INPUT_RELEASE_TAG ?? '') && env.INPUT_RELEASE_TAG.length <= 32, 'invalid immutable release tag');
  requireValue(DIGEST.test(env.INPUT_MANIFEST_SHA256 ?? ''), 'invalid release manifest digest');
  let targets;
  try { targets = JSON.parse(env.INPUT_TARGETS); } catch { throw new ActionError('invalid deployment targets'); }
  requireValue(Array.isArray(targets) && targets.length > 0 && targets.length <= 32 && targets.every(t => typeof t === 'string' && /^[a-z0-9-]{1,64}$/.test(t)) && new Set(targets).size === targets.length, 'invalid deployment targets');
  return { application: env.INPUT_APPLICATION, environment: env.INPUT_ENVIRONMENT, releaseTag: env.INPUT_RELEASE_TAG, intent: 'deploy', targets, sourceCommit: env.GITHUB_SHA, manifestSha256: env.INPUT_MANIFEST_SHA256 };
}

function checkedStatus(body, request, deploymentId) {
  requireValue(body?.schema === 'deployment-state/v1' && body.deploymentId === deploymentId && body.application === request.application && body.environment === request.environment && body.intent === 'deploy', 'deployment status identity mismatch');
  requireValue(body.requestedReleaseTag === request.releaseTag && body.sourceCommit === request.sourceCommit && body.requestedManifestSha256 === request.manifestSha256, 'deployment release identity mismatch');
  requireValue(PHASES.has(body.phase), 'unknown deployment phase');
  if (body.phase === 'SUCCEEDED') {
    requireValue(Array.isArray(body.completedTargets) && body.completedTargets.length === request.targets.length, 'deployment target readback mismatch');
    const ids = body.completedTargets.map(t => t?.id);
    requireValue(new Set(ids).size === ids.length && request.targets.every(t => ids.includes(t)) && body.completedTargets.every(t => typeof t.versionId === 'string' && t.versionId.length > 0 && t.versionId.length <= 256 && !/[\r\n]/.test(t.versionId)), 'deployment target version readback missing or mismatched');
  }
  return body.phase;
}

export async function main(env = process.env, fetchImpl = fetch, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, waitMs = 1_800_000, pollMs = 10_000 } = {}) {
  const request = requestFromEnvironment(env);
  requireValue(Number.isSafeInteger(waitMs) && waitMs > 0 && waitMs <= 1_800_000 && Number.isSafeInteger(pollMs) && pollMs > 0 && pollMs <= 60_000, 'invalid deployment polling bounds');
  const deadline = now() + waitMs;
  const { application, environment, releaseTag, intent } = request;
  // Deliberately one admission attempt. A network failure can mean the grant was consumed.
  const admitted = await ask(await oidcToken(env, fetchImpl), 'deploy', { application, environment, releaseTag, intent }, fetchImpl);
  requireValue(admitted.status === 202 && ['QUEUED', 'ALREADY_CURRENT'].includes(admitted.body?.status) && UUID.test(admitted.body?.deploymentId ?? ''), `deployment admission refused (HTTP ${admitted.status})`);
  const { deploymentId, githubDeploymentId } = admitted.body;
  requireValue(githubDeploymentId === null || (Number.isSafeInteger(githubDeploymentId) && githubDeploymentId > 0), 'invalid GitHub deployment identity');
  setOutputs(env, { deployment_id: deploymentId });
  // ALREADY_CURRENT still needs an authenticated readback of this exact release and its terminal state.
  while (now() < deadline) {
    const reply = await ask(await oidcToken(env, fetchImpl), 'deploy.status', { application, environment, deploymentId }, fetchImpl);
    requireValue(now() < deadline, 'deployment completion deadline exceeded');
    if (reply.status === 200) {
      const phase = checkedStatus(reply.body, request, deploymentId);
      if (FAILED.has(phase)) throw new ActionError(`deployment ended ${phase}`);
      if (phase === 'SUCCEEDED') {
        setOutputs(env, { deployment_id: deploymentId, phase, source_sha: request.sourceCommit, manifest_sha256: request.manifestSha256 });
        return { deploymentId, phase, completedTargets: reply.body.completedTargets };
      }
    } else {
      // Only retry read-only, transient status failures; malformed or unauthorized replies fail immediately.
      requireValue([429, 502, 503, 504].includes(reply.status), `deployment status refused (HTTP ${reply.status})`);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new ActionError('deployment completion deadline exceeded; reconcile the existing operation before resubmitting');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Do not relay exception bodies: a remote endpoint or network library could include a credential.
    console.error('::error title=deploy::Deployment did not reach verified success; inspect the authenticated deployment status. Admission was not retried.');
    process.exitCode = 1;
  });
}
