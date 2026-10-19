import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
for (const name of ['request-deployment','request-app-deployment']) {
 test(`${name} dispatch cannot select executable depot code`,()=>{
  const source=readFileSync(new URL(`../.github/workflows/${name}.yml`,import.meta.url),'utf8');
  assert.match(source,/ref: \$\{\{ needs\.resolve-source\.outputs\.sha \}\}/);
  assert.match(source,/needs: \[resolve-source\]/);
  const resolver=source.split('  resolve-source:\n')[1]?.split('  dispatch:\n')[0];
  assert.ok(resolver);assert.doesNotMatch(resolver,/checkout@|secrets\./);
  assert.match(resolver,/id-token: write/);
 });
}
const {resolveSource,AUDIENCE}=await import('./resolve-depot-source.cjs');
const NOW=1700000000000,SHA='a'.repeat(40);
function fixture(overrides={},envOverrides={}) {
 const env={ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/token?x=1',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic',GITHUB_REPOSITORY:'susanbeasles/example',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',EXPECTED_WORKFLOW:'request-deployment.yml',DEPOT_REF:SHA,DEPOT_REPOSITORY:'susanbeasles/workflow_depot',...envOverrides};
 const claims={iss:'https://token.actions.githubusercontent.com',aud:AUDIENCE,iat:NOW/1000,nbf:NOW/1000,exp:NOW/1000+300,repository:env.GITHUB_REPOSITORY,run_id:'123',run_attempt:'1',job_workflow_ref:'susanbeasles/workflow_depot/.github/workflows/request-deployment.yml@refs/heads/main',job_workflow_sha:SHA,...overrides};
 const token=`header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
 return {env,fetcher:async(url,options)=>{assert.equal(url.searchParams.get('audience'),AUDIENCE);assert.equal(options.redirect,'error');return {status:200,text:async()=>JSON.stringify({value:token})};}};
}
test('fresh issuer result resolves exact callee SHA without caller context SHA fallback',async()=>{
 const f=fixture({}, {GITHUB_SHA:'b'.repeat(40),GITHUB_WORKFLOW_SHA:'c'.repeat(40)});
 assert.equal(await resolveSource(f.env,f.fetcher,NOW),SHA);
});
for(const [name,claims,env] of [
 ['caller-selected older revision',{}, {DEPOT_REF:'b'.repeat(40)}],
 ['caller-selected repository',{}, {DEPOT_REPOSITORY:'attacker/depot'}],
 ['foreign callee repository',{job_workflow_ref:'attacker/depot/.github/workflows/request-deployment.yml@main'},{}],
 ['wrong reusable workflow',{job_workflow_ref:'susanbeasles/workflow_depot/.github/workflows/other.yml@main'},{}],
 ['missing callee sha',{job_workflow_sha:null},{}],
 ['missing callee ref',{job_workflow_ref:null},{}],
 ['expired token',{exp:NOW/1000},{}],
 ['future token',{nbf:NOW/1000+600},{}],
 ['old token',{iat:NOW/1000-601},{}],
 ['wrong issuer',{iss:'https://example.invalid'},{}],
 ['wrong audience',{aud:'other'},{}],
 ['wrong run',{run_id:'124'},{}],
 ['wrong attempt',{run_attempt:'2'},{}],
 ['wrong caller repository',{repository:'attacker/repo'},{}],
]) test(`rejects ${name}`,async()=>{const f=fixture(claims,env);await assert.rejects(resolveSource(f.env,f.fetcher,NOW),/Unable to bind/);});
test('untrusted endpoint rejected before any bearer transmission',async()=>{
 for(const url of ['http://pipelines.actions.githubusercontent.com/token','https://actions.githubusercontent.com.attacker.invalid/token','https://user@pipelines.actions.githubusercontent.com/token','https://pipelines.actions.githubusercontent.com:8443/token']) {
  const f=fixture({}, {ACTIONS_ID_TOKEN_REQUEST_URL:url});let called=false;
  await assert.rejects(resolveSource(f.env,async()=>{called=true;throw Error('unexpected');},NOW));assert.equal(called,false);
 }
});
test('errors never expose token or upstream error body',async()=>{
 for(const fetcher of [async()=>{throw Error('SENSITIVE');},async()=>({status:403,text:async()=>'SENSITIVE'}),async()=>({status:200,text:async()=>'SENSITIVE'})]) {
  await assert.rejects(resolveSource(fixture().env,fetcher,NOW),e=>e.message==='Unable to bind depot source to this reusable workflow revision');
 }
});
for(const name of ['request-deployment','request-app-deployment']) test(`${name} embeds tested resolver exactly`,()=>{
 const source=readFileSync(new URL(`../.github/workflows/${name}.yml`,import.meta.url),'utf8');
 const embedded=source.split('        run: |\n')[1].split('  dispatch:\n')[0].split('\n').filter(l=>l.startsWith('          ')).map(l=>l.slice(10)).join('\n')+'\n';
 assert.equal(embedded,readFileSync(new URL('./resolve-depot-source.cjs',import.meta.url),'utf8'));
});
test('security suite depot execution requires successful callee resolution for every job',()=>{
 const source=readFileSync(new URL('../security-assurance/.github/workflows/security-assurance.yml',import.meta.url),'utf8');
 assert.match(source,/  resolve-source:\n/);
 for(const block of source.split(/\n  (?=[a-z][a-z0-9-]*:\n)/).slice(1)) {
  if(!block.includes('path: .security-depot'))continue;
  assert.match(block,/needs: \[[^\n]*resolve-source[^\n]*\]/);
  assert.match(block,/if: .*needs\.resolve-source\.result == 'success'/);
  assert.match(block,/repository: "susanbeasles\/workflow_depot", ref: "\$\{\{ needs\.resolve-source\.outputs\.sha \}\}"/);
  assert.doesNotMatch(block,/inputs\.depot_ref|inputs\.depot_repository/);
 }
 const resolver=source.split('  resolve-source:\n')[1].split(/\n  [a-z]/)[0];
 assert.doesNotMatch(resolver,/checkout@|secrets\./);
});
test('security resolver embeds the tested code without candidate checkout',()=>{
 const source=readFileSync(new URL('../security-assurance/.github/workflows/security-assurance.yml',import.meta.url),'utf8');
 const job=source.split('  resolve-source:\n')[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
 const embedded=job.split('        run: |\n')[1].split('\n').filter(l=>l.startsWith('          ')).map(l=>l.slice(10)).join('\n')+'\n';
 assert.equal(embedded,readFileSync(new URL('./resolve-depot-source.cjs',import.meta.url),'utf8'));
});
test('nested main dispatch delegates OIDC only for callee source resolution',()=>{
 const source=readFileSync(new URL('../.github/workflows/main-deployment.yml',import.meta.url),'utf8');
 const dispatch=source.split('  dispatch:\n')[1];
 assert.match(dispatch,/permissions: \{contents: read, id-token: write\}/);
 const leaf=readFileSync(new URL('../.github/workflows/request-deployment.yml',import.meta.url),'utf8').split('  dispatch:\n')[1];
 assert.match(leaf,/permissions: \{contents: read\}/);assert.doesNotMatch(leaf,/id-token: write/);
});

test('OIDC runtime trust matches documented GitHub domain boundary, not lookalike hosts',async()=>{
 for(const host of ['attacker.actions.githubusercontent.com.evil.invalid','evilactions.githubusercontent.com','actions.githubusercontent.com']) {
  const f=fixture({}, {ACTIONS_ID_TOKEN_REQUEST_URL:`https://${host}/token`});let calls=0;
  await assert.rejects(resolveSource(f.env,async()=>{calls++;throw Error('network forbidden');},NOW));assert.equal(calls,0);
 }
 for(const host of ['pipelines.actions.githubusercontent.com','regional-runtime.actions.githubusercontent.com']) {
  const f=fixture({}, {ACTIONS_ID_TOKEN_REQUEST_URL:`https://${host}/token`});assert.equal(await resolveSource(f.env,f.fetcher,NOW),SHA);
 }
});
