// Immutable reviewed depot-source enrollment only. Caller inputs confer no authority.
// Empty until the owner reviews exact existing identities and endpoints in source.
export const dispatchEnrollments=Object.freeze([]);
export const promotionEnrollments=Object.freeze([]);
export const dispatchFields=Object.freeze(['DISPATCH_APP_APPROVAL_REF','DISPATCH_APP_ID','DISPATCH_APP_CLIENT_ID','DISPATCH_APP_SLUG','DISPATCH_INSTALLATION_ID','DISPATCH_APP_PRIVATE_KEY_REF','GITHUB_REPOSITORY','GITHUB_REPOSITORY_ID','DEPLOY_TARGET']);
export function requireDispatchEnrollment(env,records=dispatchEnrollments){
 if(!records.some(record=>dispatchFields.every(field=>typeof record[field]==='string'&&record[field]===env[field])))throw Error('No trusted exact dispatch commissioning enrollment');
}
export function requirePromotionEnrollment({url,audience,repository,application,environment},records=promotionEnrollments){
 if(!records.some(record=>record.url===url&&record.audience===audience&&record.repository===repository&&record.application===application&&record.environment===environment))throw Error('No trusted exact promotion endpoint enrollment');
}
