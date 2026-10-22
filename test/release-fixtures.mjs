// Synthetic application + release fixtures for the release tests. All identifiers
// and values are fake ("example-owner", fixed hex) and nothing is credential-shaped.
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {canonicalBytes,formatTimestamp} from '../src/shared/release-contract.mjs';
import {buildWorkerBundle} from '../ci/release/build-worker-bundle.mjs';
import {bundleMigrations} from '../ci/release/bundle-migrations.mjs';
import {authorizationPolicy} from '../ci/release/write-authorization-policy.mjs';
import {writeChecksums} from '../ci/release/checksum-bundles.mjs';
import {assembleRelease} from '../ci/release/assemble-release.mjs';
import {releaseManifest} from '../ci/release/write-release-manifest.mjs';

export const SOURCE_COMMIT='0123456789abcdef0123456789abcdef01234567';
export const DEPOT={repository:'example-owner/workflow_depot',sha:'89abcdef0123456789abcdef0123456789abcdef'};
export const CREATED_AT='2026-10-15T12:00:00Z';
export const SOURCE_DATE_EPOCH=1791000000;

export function application(){
 return {
  schema:'application-deployment/v1',application:'demoapp',repository:'example-owner/demo-app',repositoryId:4242,
  targets:[
   {id:'demoapp-d1-migrations',adapter:'cloudflare-d1-migrate/v1',build:{migrationsDir:'migrations',binding:'DB'},dependsOn:[],recoveryPolicy:'forward-only'},
   {id:'demoapp-worker',adapter:'cloudflare-worker/v1',build:{wranglerConfig:'wrangler.jsonc',entry:'src/worker.ts',assetsDir:'dist',buildCommand:'build'},dependsOn:['demoapp-d1-migrations'],healthContract:'http-release-marker/v1'},
  ],
  environments:{staging:{allowedRefs:['refs/heads/main'],requiredApprovals:0},production:{allowedRefs:['refs/tags/v*'],requiredApprovals:1}},
 };
}
// Product worker + separate replicator worker + D1 migrations (contracts section 10).
export function applicationWithReplicator(){
 const app=application();
 app.targets.push({id:'demoapp-replicator',adapter:'cloudflare-worker/v1',build:{wranglerConfig:'wrangler.replicator.jsonc',entry:'src/replicator/worker.ts'},dependsOn:['demoapp-d1-migrations'],healthContract:'worker-version/v1'});
 return app;
}
export function context(overrides={}){
 return {schema:'release-context/v1',repository:'example-owner/demo-app',repositoryId:4242,sourceCommit:SOURCE_COMMIT,ref:'refs/heads/main',releaseTag:'v1.2.3',runId:'1001',runAttempt:'1',...overrides};
}

export const WRANGLER=`{
 // comment with "quotes" and a // nested marker
 "$schema":"node_modules/wrangler/config-schema.json",
 "name":"demo-app-staging",
 "main":"./src/worker.ts",
 "compatibility_date":"2026-10-08",
 "compatibility_flags":["nodejs_compat"],
 "workers_dev":false,"preview_urls":false,
 /* block comment
    spanning lines */
 "assets":{"directory":"./dist","binding":"ASSETS","run_worker_first":true,"not_found_handling":"single-page-application"},
 "observability":{"enabled":true},
 "vars":{"GATEWAY_ORIGIN":"https://control.example.invalid/path//x","OWNER_ID":"UNCONFIGURED","EMPTY":""},
 "d1_databases":[{"binding":"DB","database_name":"demo-staging","database_id":"00000000-0000-0000-0000-000000000000","migrations_dir":"migrations"}],
 "r2_buckets":[{"binding":"ARTIFACTS","bucket_name":"demo-staging"}],
 "durable_objects":{"bindings":[{"name":"COORDINATOR","class_name":"Coordinator"}]},
 "services":[{"binding":"CONTROL_AUTHORITY","service":"control-plane","entrypoint":"DemoAuthority"}],
 "migrations":[{"tag":"v1","new_sqlite_classes":["Coordinator"]}],
 "queues":{"producers":[{"binding":"JOBS","queue":"demo-staging"}],"consumers":[]},
 "triggers":{"crons":[]},
 "secrets_store_secrets":[{"binding":"SIGNING_MATERIAL","store_id":"00000000000000000000000000000000","secret_name":"demo-demo-demo"}],
}
`;

// Routeless replicator (worker-version/v1): no assets, no queues, workers_dev false.
export const REPLICATOR_WRANGLER=`{
 "name":"demo-app-staging-replicator",
 "main":"src/replicator/worker.ts",
 "compatibility_date":"2026-10-08",
 "compatibility_flags":["nodejs_compat"],
 "workers_dev":false,
 "observability":{"enabled":true,"head_sampling_rate":1},
 "vars":{"OWNER_ID":"UNCONFIGURED"},
 "d1_databases":[{"binding":"DB","database_name":"demo-staging","database_id":"00000000-0000-0000-0000-000000000000"}],
 "r2_buckets":[{"binding":"ORIGINALS","bucket_name":"demo-staging-originals"},{"binding":"BACKUP","bucket_name":"demo-staging-backup"}],
 "triggers":{"crons":["*/5 * * * *","23 3 * * *","53 3 1 * *"]},
}
`;

export function write(root,path,content){
 const full=join(root,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,content);return full;
}

export function makeApp(){
 const root=mkdtempSync(join(tmpdir(),'release-app-'));
 const app=join(root,'app');
 write(app,'deployment/application.json',JSON.stringify(application(),null,2));
 write(app,'wrangler.jsonc',WRANGLER);
 write(app,'wrangler.replicator.jsonc',REPLICATOR_WRANGLER);
 write(app,'src/replicator/worker.ts','export default {};\n');
 write(app,'src/worker.ts','export default {};\n');
 write(app,'dist/index.html','<!doctype html><title>demo</title>\n');
 write(app,'dist/assets/app-abc123.js','console.log("demo");\n');
 write(app,'dist/.well-known/security.txt','Contact: mailto:security@example.invalid\n');
 write(app,'migrations/0001_init.sql','PRAGMA foreign_keys = ON;\nCREATE TABLE records (id TEXT PRIMARY KEY, body TEXT NOT NULL); -- trailing; comment\nINSERT INTO records VALUES (\'a;b\', \'{}\');\n');
 write(app,'migrations/0002_expand.sql','-- compatibility: expand\nALTER TABLE records ADD COLUMN revision INTEGER;\n');
 write(app,'migrations/0003_contract.sql','-- compatibility: contract\n-- requires: 0002\nCREATE TRIGGER t AFTER INSERT ON records BEGIN\n UPDATE records SET revision = CASE WHEN revision IS NULL THEN 1 ELSE revision END;\n SELECT 1;\nEND;\nDROP INDEX IF EXISTS old_index;\n');
 const wranglerOut=join(root,'wrangler-out');
 write(root,'wrangler-out/worker.js','export default {async fetch(){return new Response("ok");}};\n');
 write(root,'wrangler-out/worker.js.map','{}');
 write(root,'wrangler-out/README.md','wrangler output\n');
 write(root,'wrangler-out-replicator/index.js','export default {async scheduled(){},async queue(){}};\n');
 const state=join(root,'state');mkdirSync(state);
 write(state,'application.json',canonicalBytes(application()));
 write(state,'context.json',canonicalBytes(context()));
 return {root,app,wranglerOut,replicatorOut:join(root,'wrangler-out-replicator'),state,out:join(root,'out'),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

export async function buildRelease(f,{out=f.out,ctx=context(),app=application()}={}){
 const outdirs={'demoapp-worker':f.wranglerOut,'demoapp-replicator':f.replicatorOut},bundles={};
 for(const t of app.targets){
  bundles[t.id]=t.adapter==='cloudflare-worker/v1'
   ?await buildWorkerBundle({appRoot:f.app,application:app,targetId:t.id,wranglerOutdir:outdirs[t.id],outDir:out,releaseTag:ctx.releaseTag,sourceCommit:ctx.sourceCommit})
   :bundleMigrations({appRoot:f.app,application:app,targetId:t.id,outDir:out});
 }
 write(out,'authorization-policy.json',canonicalBytes(authorizationPolicy({application:app,context:ctx,depotRepository:DEPOT.repository,depotSha:DEPOT.sha,clock:()=>Date.parse(CREATED_AT)})));
 write(out,'sbom.cdx.json',JSON.stringify({bomFormat:'CycloneDX',specVersion:'1.6',components:[]}));
 write(out,'sbom.spdx.json',JSON.stringify({spdxVersion:'SPDX-2.3',packages:[]}));
 writeChecksums(out);
 const release=assembleRelease(out);
 const manifest=releaseManifest({releaseDir:out,application:app,context:ctx,depotRepository:DEPOT.repository,depotSha:DEPOT.sha,createdAt:CREATED_AT});
 write(out,'release.meta.json',canonicalBytes(manifest));
 return {bundles,worker:bundles['demoapp-worker'],migrations:bundles['demoapp-d1-migrations'],release,manifest};
}
export const nowStamp=()=>formatTimestamp(Date.now());
