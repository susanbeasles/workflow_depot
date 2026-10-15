// Ask the authorizer for a decision with this job's GitHub Actions OIDC token. No dependencies.
// The token goes only to services.susanb.dev; redirects are failures; bodies are bounded; nothing secret is printed.

import { appendFileSync, readFileSync } from 'node:fs';

export const AUDIENCE = 'services.susanb.dev';
export const ENDPOINT = 'https://services.susanb.dev/v1/token';
const MAX_BODY = 65_536;

export class ActionError extends Error {}

function bounded(text, max = MAX_BODY) {
  if (text.length > max) throw new ActionError('response too large');
  return text;
}

/** Fetch the job's OIDC token for the authorizer audience. Requires `permissions: id-token: write`. */
export async function oidcToken(env, fetchImpl = fetch) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new ActionError('no OIDC token available: the calling job needs `permissions: id-token: write`');
  const target = new URL(url);
  target.searchParams.set('audience', AUDIENCE);
  const res = await fetchImpl(target, { headers: { authorization: `bearer ${bearer}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (res.status !== 200) throw new ActionError(`OIDC token request failed with ${res.status}`);
  const value = JSON.parse(bounded(await res.text(), 16_384)).value;
  if (typeof value !== 'string' || value.split('.').length !== 3) throw new ActionError('OIDC token response has no token');
  return value;
}

/** POST {action, subject} to the authorizer. Returns {status, body}. A 3xx is never followed: it is a misconfigured Access app. */
export async function ask(jwt, action, subject, fetchImpl = fetch, endpoint = ENDPOINT) {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, subject }),
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status >= 300 && res.status < 400) throw new ActionError(`authorizer answered ${res.status}: a redirect means an Access application is misconfigured; fix it in infra, never follow it`);
  const text = bounded(await res.text());
  let body;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new ActionError(`authorizer answered ${res.status} with a non-JSON body`);
  }
  return { status: res.status, body };
}

export function event(env) {
  if (!env.GITHUB_EVENT_PATH) throw new ActionError('GITHUB_EVENT_PATH is not set');
  return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
}

export function repoIdentity(env) {
  const repo = env.GITHUB_REPOSITORY;
  const repoId = Number(env.GITHUB_REPOSITORY_ID);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !Number.isSafeInteger(repoId) || repoId <= 0) throw new ActionError('GITHUB_REPOSITORY or GITHUB_REPOSITORY_ID is missing or malformed');
  return { repo, repo_id: repoId };
}

/** Write step outputs. Values are validated by the callers (hex shas, tag names); newlines are refused. */
export function setOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(outputs)) {
    const text = String(value ?? '');
    if (/[\r\n]/.test(text)) throw new ActionError(`output ${key} contains a newline`);
    appendFileSync(env.GITHUB_OUTPUT, `${key}=${text}\n`);
  }
}

export function summary(env, markdown) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** A refusal's stable code and short detail, safe to print. */
export function describeRefusal(body) {
  const code = typeof body?.code === 'string' ? body.code.slice(0, 64) : 'unknown';
  const detail = typeof body?.detail === 'string' ? body.detail.replace(/[\r\n]+/g, ' ').slice(0, 200) : '';
  return detail ? `${code}: ${detail}` : code;
}

export const SHA = /^[0-9a-f]{40}$/;
