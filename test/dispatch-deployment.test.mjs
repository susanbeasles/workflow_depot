import test from 'node:test';import assert from 'node:assert/strict';
import {dispatch} from '../ci/dispatch-deployment.mjs';
const env={GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'susanbeasles/personal-control',GITHUB_REPOSITORY_ID:'1408909065',GITHUB_RUN_ID:'123',GITHUB_SHA:'a'.repeat(40),DEPLOY_TARGET:'personal-control',RELEASE_DISPATCH_TOKEN:'synthetic'};
test('dispatch preserves exact identity and calls only fixed controller endpoint',async()=>{let calls=0;const result=await dispatch(env,async(url,opts)=>{calls++;assert.equal(url,'https://api.github.com/repos/susanbeasles/deployer/actions/workflows/deploy.yml/dispatches');assert.equal(opts.redirect,'error');assert.equal(JSON.parse(opts.body).inputs.sha,env.GITHUB_SHA);return {status:204};});assert.equal(calls,1);assert.equal(result.state,'requested');});
test('missing dispatch grant, PR or recursive self deployment makes no request',async()=>{for(const change of [{RELEASE_DISPATCH_TOKEN:''},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REPOSITORY:'susanbeasles/deployer'}])await assert.rejects(dispatch({...env,...change},()=>assert.fail('must not call')));});
test('canonical deployer self-dispatch and obsolete receiver aliases are denied',async()=>{
 let requested=false;
 await assert.rejects(dispatch({...env,GITHUB_REPOSITORY:'susanbeasles/deployer',GITHUB_REPOSITORY_ID:'1405415291'},async()=>{requested=true;return {status:204};}));
 assert.equal(requested,false);
});
test('ambiguous failure is never automatically retried or reported deployed',async()=>{let calls=0;await assert.rejects(dispatch(env,async()=>{calls++;return {status:500};}),/Central dispatch failed/);assert.equal(calls,1);});
