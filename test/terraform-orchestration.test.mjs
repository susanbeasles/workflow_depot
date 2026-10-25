import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionError } from '../actions/_lib/authorizer.mjs';
import { main, requestFromEnvironment } from '../actions/request-terraform/main.mjs';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const JOB_ID = '0199e7a0-0000-7000-8000-000000000001';
const oidc = () => Response.json({ value: 'abc.def.ghi' });
const env = (repo = 'susanbeasles/infra', event = 'pull_request') => ({
  GITHUB_REPOSITORY: repo,
  GITHUB_REPOSITORY_ID: repo.endsWith('/infra') ? '1417590199' : '1419989558',
  GITHUB_EVENT_NAME: event,
  GITHUB_REF_PROTECTED: event === 'push' ? 'true' : 'false',
  GITHUB_REF: event === 'pull_request' ? 'refs/pull/7/merge' : 'refs/heads/main',
  GITHUB_SHA: SHA,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.actions.githubusercontent.com/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-runner-ticket',
});
const pr = () => ({
  number: 7,
  pull_request: { number: 7, base: { ref: 'main', repo: { id: 1417590199 } }, head: { repo: { id: 1417590199 } } },
});

test('routes only the exact infra and infra-root repositories and GitHub event types', () => {
  assert.deepEqual(requestFromEnvironment(env(), pr()), { action: 'infra.plan', subject: { pullRequest: 7 }, commit: SHA, stack: 'infra', phase: 'plan' });
  assert.equal(requestFromEnvironment(env('susanbeasles/infra-root','push')).action, 'root.apply');
  assert.equal(requestFromEnvironment(env('susanbeasles/infra-root','pull_request'), {...pr(), pull_request:{...pr().pull_request,base:{...pr().pull_request.base,repo:{id:1419989558}},head:{repo:{id:1419989558}}}}).action, 'root.plan');
  for(const malformed of [
    {...env(), GITHUB_REPOSITORY: 'susanbeasles/app'},
    {...env(), GITHUB_REPOSITORY_ID: '42'},
    {...env(), GITHUB_REF: 'refs/heads/main'},
    {...env(), GITHUB_SHA: 'not-a-sha'},
  ]) assert.throws(() => requestFromEnvironment(malformed, pr()), ActionError);
  assert.throws(() => requestFromEnvironment(env(), { ...pr(), pull_request:{...pr().pull_request,head:{repo:{id:4}}}}), ActionError);
  assert.throws(() => requestFromEnvironment(env(), null), ActionError);
  assert.throws(() => requestFromEnvironment({ ...env(), GITHUB_EVENT_NAME:'pull_request_target'}, pr()), ActionError);
  for (const protection of [undefined, '', 'false', 'TRUE']) {
    assert.throws(() => requestFromEnvironment({ ...env('susanbeasles/infra', 'push'), GITHUB_REF_PROTECTED: protection }), ActionError);
    assert.throws(() => requestFromEnvironment({ ...env('susanbeasles/infra-root', 'push'), GITHUB_REF_PROTECTED: protection }), ActionError);
  }
});

test('OIDC request plus runner status polling verifies exact Terraform plan result', async () => {
  const asked = [];
  const fetcher = async (url, init) => {
    if (String(url).startsWith('https://example.actions.githubusercontent.com/')) return oidc();
    const request = JSON.parse(init.body);
    asked.push(request);
    if (request.action === 'infra.plan') return Response.json({ jobId: JOB_ID, state: 'queued' }, { status: 202 });
    if (request.action === 'job.status') return Response.json({
      jobId: JOB_ID, type:'terraform.plan', state:'succeeded',
      result:{ schema:'terraform-plan-summary/v1', stack:'infra', commit:SHA, treeSha:TREE, policyPassed:true, planSha256:DIGEST },
    });
    throw Error('unexpected action');
  };
  const result = await main(env(), fetcher, { payload:pr(), now:()=>0, sleep:async()=>{} });
  assert.deepEqual(result,{jobId:JOB_ID,stack:'infra',commit:SHA});
  assert.deepEqual(asked.map(x=>x.action), ['infra.plan','job.status']);
  assert.deepEqual(asked[0].subject,{pullRequest:7});
  assert.deepEqual(asked[1].subject,{jobId:JOB_ID});
});

test('root apply requires independent approval; no CI success and no re-admission', async () => {
  const asked = [];
  const fetcher = async(url,init)=>{
    if(String(url).startsWith('https://example.actions.githubusercontent.com/'))return oidc();
    const request=JSON.parse(init.body);asked.push(request);
    return Response.json({state:'awaiting_approval',commit:SHA,approveUrl:'https://approve.susanb.dev/'},{status:202});
  };
  await assert.rejects(main(env('susanbeasles/infra-root','push'),fetcher,{now:()=>0}),/pending owner approval/);
  assert.deepEqual(asked.map(x=>x.action),['root.apply']);
});

test('runner rejects a successful status with wrong repository, result, or job type',async()=>{
  for(const result of [
    {schema:'terraform-plan-summary/v1',stack:'infra-root',commit:SHA,treeSha:TREE,policyPassed:true,planSha256:DIGEST},
    {schema:'terraform-plan-summary/v1',stack:'infra',commit:'d'.repeat(40),treeSha:TREE,policyPassed:true,planSha256:DIGEST},
    {schema:'terraform-plan-summary/v1',stack:'infra',commit:SHA,treeSha:TREE,policyPassed:false,planSha256:DIGEST},
  ]){
    const fetcher=async(url,init)=>{
      if(String(url).startsWith('https://example.actions.githubusercontent.com/'))return oidc();
      const {action}=JSON.parse(init.body);
      if(action==='infra.plan')return Response.json({jobId:JOB_ID,state:'queued'},{status:202});
      return Response.json({jobId:JOB_ID,type:'terraform.plan',state:'succeeded',result});
    };
    await assert.rejects(main(env(),fetcher,{payload:pr(),now:()=>0}),ActionError);
  }
});

test('ambiguous admission never retries even when the transport fails',async()=>{
  let admitted=0;
  const fetcher=async(url,init)=>{
    if(String(url).startsWith('https://example.actions.githubusercontent.com/'))return oidc();
    admitted++; throw Error('network disconnected after submission');
  };
  await assert.rejects(main(env(),fetcher,{payload:pr(),now:()=>0}));
  assert.equal(admitted,1);
});
