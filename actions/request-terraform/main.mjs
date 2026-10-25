// Terraform orchestration runs only in the pinned workflow_depot reusable workflow.
// GitHub hosts routing; infrastructure credentials remain in the isolated infra
// or infra-root executor. An admission is not a successful plan or apply.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ActionError, ask, describeRefusal, oidcToken, repoIdentity, setOutputs, summary, SHA } from '../_lib/authorizer.mjs';

export const OWNERS = Object.freeze({
  'susanbeasles/infra': Object.freeze({ id: 1417590199, stack: 'infra', prefix: 'infra' }),
  'susanbeasles/infra-root': Object.freeze({ id: 1419989558, stack: 'infra-root', prefix: 'root' }),
});
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const TRANSIENT = new Set([429, 502, 503, 504]);
const TERMINAL_FAILURE = new Set(['failed', 'uncertain']);
const requireThat = (ok, message) => { if (!ok) throw new ActionError(message); };

export function requestFromEnvironment(env, payload = null) {
  const { repo, repo_id } = repoIdentity(env);
  const owner = OWNERS[repo];
  requireThat(owner && owner.id === repo_id, 'Terraform workflow is not authorized for this repository');
  requireThat(SHA.test(env.GITHUB_SHA ?? ''), 'source commit is not a full SHA');
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    const match = /^refs\/pull\/([1-9][0-9]{0,15})\/merge$/.exec(env.GITHUB_REF ?? '');
    requireThat(match, 'Terraform plans require a pull request merge ref');
    const number = Number(match[1]);
    requireThat(Number.isSafeInteger(number) && number > 0, 'invalid pull request number');
    if (payload !== null) {
      requireThat(payload?.number === number && payload?.pull_request?.number === number, 'event pull request mismatch');
      requireThat(payload.pull_request.base?.ref === 'main', 'Terraform plan target is not main');
      requireThat(payload.pull_request.base?.repo?.id === repo_id, 'Terraform plan base repository mismatch');
      requireThat(payload.pull_request.head?.repo?.id === repo_id, 'cross-repository plans are forbidden');
    }
    return { action: owner.prefix + '.plan', subject: { pullRequest: number }, commit: env.GITHUB_SHA, stack: owner.stack, phase: 'plan' };
  }
  requireThat(env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main',
    'Terraform apply requires a main push');
  return { action: owner.prefix + '.apply', subject: {}, commit: env.GITHUB_SHA, stack: owner.stack, phase: 'apply' };
}

function runnerType(req) { return req.phase === 'plan' ? (req.stack === 'infra-root' ? 'root.plan' : 'terraform.plan') : (req.stack === 'infra-root' ? 'root.apply' : 'terraform.apply'); }

function checkedJob(value, req, jobId) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'runner status must be an object');
  requireThat(value.jobId === jobId && value.type === runnerType(req), 'runner job identity mismatch');
  requireThat(['queued', 'running', 'succeeded', 'failed', 'uncertain'].includes(value.state), 'unknown runner state');
  if (TERMINAL_FAILURE.has(value.state)) throw new ActionError('Terraform execution ended ' + value.state + '; reconcile the existing job');
  if (value.state !== 'succeeded') return false;
  const result = value.result;
  const schema = req.phase === 'plan' ? 'terraform-plan-summary/v1' : 'terraform-apply-result/v1';
  requireThat(result && typeof result === 'object' && !Array.isArray(result), 'runner returned no result document');
  requireThat(result.schema === schema && result.stack === req.stack && result.commit === req.commit && SHA.test(result.treeSha ?? ''), 'Terraform result is not bound to this stack and commit');
  if (req.phase === 'plan') {
    requireThat(result.policyPassed === true && HEX.test(result.planSha256 ?? ''), 'Terraform plan or root policy was not verified');
  } else {
    requireThat(Number.isSafeInteger(result.stateSerialAfter) && result.stateSerialAfter >= 0, 'Terraform state readback is missing');
  }
  return true;
}

function eventPayload(env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return null;
  requireThat(typeof env.GITHUB_EVENT_PATH === 'string' && env.GITHUB_EVENT_PATH.length < 500, 'missing GitHub event payload');
  const source = readFileSync(env.GITHUB_EVENT_PATH, 'utf8');
  requireThat(source.length <= 1_048_576, 'GitHub event payload too large');
  return JSON.parse(source);
}

export async function main(env = process.env, fetcher = fetch, options = {}) {
  const req = requestFromEnvironment(env, options.payload === undefined ? eventPayload(env) : options.payload);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const waitMs = options.waitMs ?? (req.phase === 'plan' ? 1_800_000 : 3_300_000);
  const pollMs = options.pollMs ?? 10_000;
  requireThat(Number.isSafeInteger(waitMs) && waitMs > 0 && waitMs <= 3_300_000
    && Number.isSafeInteger(pollMs) && pollMs > 0 && pollMs <= 60_000, 'invalid Terraform polling bounds');
  const deadline = now() + waitMs;
  // One admission attempt only; a timeout may have consumed the one-use grant.
  const admission = await ask(await oidcToken(env, fetcher), req.action, req.subject, fetcher);
  if (req.action === 'root.apply' && admission.status === 202 && admission.body?.state === 'awaiting_approval') {
    requireThat(admission.body.commit === req.commit
      && admission.body.approveUrl === 'https://approve.susanb.dev/', 'unbound root approval response');
    summary(env, 'Root Terraform apply of ' + req.commit + ' is **awaiting independent Cloudflare Access owner approval**. This GitHub job has not verified an apply.');
    throw new ActionError('Root apply pending owner approval; no completed apply has been verified');
  }
  requireThat(admission.status === 202
    && JOB_ID.test(admission.body?.jobId ?? '')
    && ['queued', 'running', 'succeeded', 'QUEUED', 'RUNNING', 'SUCCEEDED'].includes(admission.body?.state),
    'Terraform admission refused (HTTP ' + admission.status + '): ' + describeRefusal(admission.body));
  const jobId = admission.body.jobId;
  setOutputs(env, { job_id: jobId, stack: req.stack, commit: req.commit });
  while (now() < deadline) {
    const response = await ask(await oidcToken(env, fetcher), 'job.status', { jobId }, fetcher);
    requireThat(now() < deadline, 'Terraform job deadline exceeded; reconcile existing job ' + jobId);
    if (response.status === 200) {
      if (checkedJob(response.body, req, jobId)) {
        setOutputs(env, { state: 'succeeded', job_id: jobId, stack: req.stack, commit: req.commit });
        summary(env, 'Terraform ' + req.phase + ' **verified succeeded** for ' + req.stack + ' at ' + req.commit + ' (job ' + jobId + ').');
        return { jobId, stack: req.stack, commit: req.commit };
      }
    } else if (!TRANSIENT.has(response.status)) {
      throw new ActionError('Terraform status refused (HTTP ' + response.status + ')');
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new ActionError('Terraform terminal status unavailable; reconcile the existing job ' + jobId + ' before re-admission');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never echo bearer tokens, conversion codes, provider responses, or exception bodies.
    console.error('::error title=terraform::Plan/apply was not verified complete; inspect the authorized runner and approval state. Admission was not retried.');
    process.exitCode = 1;
  });
}
