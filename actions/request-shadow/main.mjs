// Pull request run: ask the authorizer to build the shadow candidate for this PR at its head.
import { ActionError, ask, describeRefusal, event, oidcToken, repoIdentity, setOutputs, SHA, summary } from '../_lib/authorizer.mjs';

export async function run(env = process.env, fetchImpl = fetch, log = console.log) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') throw new ActionError('request-shadow runs only on pull_request events');
  const pull = event(env).pull_request;
  const pr = pull?.number;
  const head = pull?.head?.sha;
  if (!Number.isSafeInteger(pr) || pr <= 0 || !SHA.test(head ?? '')) throw new ActionError('the pull_request payload has no number or head sha');
  if (pull.base?.ref !== 'main') throw new ActionError(`pull request targets ${pull.base?.ref}, not main: nothing to promote`);
  const subject = { ...repoIdentity(env), pr, head_sha: head };
  const { status, body } = await ask(await oidcToken(env, fetchImpl), 'shadow.prepare', subject, fetchImpl);
  if (status !== 200 || body?.ok !== true || !SHA.test(body?.candidate_sha ?? '')) throw new ActionError(`shadow.prepare refused (${status}): ${describeRefusal(body)}`);
  setOutputs(env, { candidate_sha: body.candidate_sha, shadow_ref: body.shadow_ref, reused: body.reused === true });
  summary(env, `### Shadow candidate\n\n| | |\n|---|---|\n| PR head | \`${head}\` |\n| Candidate | \`${body.candidate_sha}\` |\n| Base (main) | \`${body.base_sha}\` |\n| Ref | \`${body.shadow_ref}\` |\n\nThe pipeline now runs on the candidate; it promotes only if every stage passes there.`);
  log(`shadow candidate ${body.candidate_sha} on ${body.shadow_ref}${body.reused ? ' (unchanged)' : ''}`);
  return body;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.log(`::error title=request-shadow::${error instanceof ActionError ? error.message : 'unexpected failure'}`);
    process.exitCode = 1;
  });
}
