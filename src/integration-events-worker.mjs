import {createIntegrationWebhook} from './integration-events.mjs';
// Explicit commissioning only. A provider webhook never receives signer keys.
export default {async fetch(request,env){
 if(env.ENABLED!=='true'||new URL(request.url).pathname!=='/v1/integration/events')return new Response('Not found',{status:404});
 try{return await createIntegrationWebhook({secret:env.INTEGRATION_WEBHOOK_SECRET,repository:env.INTEGRATION_REPOSITORY,repositoryID:Number(env.INTEGRATION_REPOSITORY_ID),source:env.INTEGRATION_SOURCE,reconciler:env.INTEGRATION_RECONCILER})(request);}catch{return new Response('Integration unavailable',{status:503});}
}};
