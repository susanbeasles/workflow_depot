// Shadow candidate run: after every stage passed on this exact commit, ask the authorizer to promote it.
import { ActionError, ask, describeRefusal, oidcToken, repoIdentity, setOutputs, SHA, summary } from '../_lib/authorizer.mjs';

const SHADOW_REF = /^refs\/heads\/shadow\/pr-([1-9][0-9]{0,9})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export async function run(env = process.env, fetchImpl = fetch, log = console.log) {
  if (env.GITHUB_EVENT_NAME !== 'push') throw new ActionError('request-promotion runs only on push events to shadow/pr-<n>');
  const match = SHADOW_REF.exec(env.GITHUB_REF ?? '');
  if (match === null) throw new ActionError(`ref ${env.GITHUB_REF} is not a shadow branch`);
  const candidate = env.GITHUB_SHA;
  if (!SHA.test(candidate ?? '')) throw new ActionError('GITHUB_SHA is malformed');
  const subject = { ...repoIdentity(env), pr: Number(match[1]), candidate_sha: candidate };
  const digest = (env.INPUT_ARTIFACT_DIGEST ?? '').trim();
  if (digest !== '') {
    if (!DIGEST.test(digest)) throw new ActionError('artifact-digest must be sha256:<64 hex>');
    subject.artifact_digest = digest;
  }
  const { status, body } = await ask(await oidcToken(env, fetchImpl), 'promote', subject, fetchImpl);
  if (status === 200 && body?.ok === true && body.main_sha === candidate) {
    setOutputs(env, { outcome: 'promoted', main_sha: body.main_sha, tag: body.tag, candidate_sha: candidate });
    const pending = Array.isArray(body.pending) && body.pending.length > 0 ? `\n\nFollow-ups still pending (retried automatically): ${body.pending.join(', ')}` : '';
    summary(env, `### Promoted\n\n\`main\` fast-forwarded to \`${candidate}\`.\n\nProvenance tag: \`${body.tag}\`${pending}`);
    log(`main is now ${candidate}; tag ${body.tag}${body.already_promoted ? ' (already promoted)' : ''}`);
    return body;
  }
  if (body?.code === 'stale_base' && SHA.test(body?.candidate_sha ?? '')) {
    // main moved; the promoter already rebuilt the candidate and pushed it, which starts a fresh pipeline run.
    setOutputs(env, { outcome: 'stale_base', candidate_sha: body.candidate_sha });
    summary(env, `### Superseded\n\n\`main\` moved while this candidate ran. A new candidate \`${body.candidate_sha}\` was built and its pipeline run decides the promotion.`);
    log(`::warning title=request-promotion::main moved; superseded by candidate ${body.candidate_sha}`);
    return body;
  }
  throw new ActionError(`promote refused (${status}): ${describeRefusal(body)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.log(`::error title=request-promotion::${error instanceof ActionError ? error.message : 'unexpected failure'}`);
    process.exitCode = 1;
  });
}
