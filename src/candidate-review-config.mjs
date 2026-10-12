// Source-owned commissioning data, reviewed with this depot revision. No
// application input, repository variable or downloaded artifact can supply it.
// Entries are keyed by numeric source repository ID and contain only
// {repository,provider}. Runtime/workflow/caller SHA pins and the accepted review
// and scan policies come from the existing private candidate authority.
// See candidate-review.md. An API vendor is not authorized for source upload.
export const reviewPolicies=Object.freeze({});

// Existing runtime-issued credential capabilities must be commissioned here.
// A static App JWT secret is not a solution: it expires before later jobs run.
// No credential minting, enrollment or source upload is enabled by this module.
export const reviewCredentials=Object.freeze({getReviewerAppJWT:null,getProviderCredential:null});
