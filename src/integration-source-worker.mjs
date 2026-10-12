import {WorkerEntrypoint} from 'cloudflare:workers';
import {createIntegrationSource} from './integration-source.mjs';
export class IntegrationSource extends WorkerEntrypoint {
 source(){if(this.env.ENABLED!=='true')throw Error('Integration source disabled');return createIntegrationSource({repository:this.env.INTEGRATION_REPOSITORY,repositoryID:Number(this.env.INTEGRATION_REPOSITORY_ID),credential:input=>this.env.SOURCE_READ_CREDENTIAL.credential(input),policy:this.env.SOURCE_POLICY});}
 current(input){return this.source().current(input);}
 listOpen(input){return this.source().listOpen(input);}
 fetch(){return new Response('Not found',{status:404});}
}
export default {fetch(){return new Response('Not found',{status:404});}};
