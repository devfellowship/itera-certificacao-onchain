/**
 * Which lab made a model. Pure (no assets), so tests run it without a DOM.
 * The data and the match rules live in @itera/contracts (packages/contracts/model-catalog/labs.json,
 * shared with apps/api): add a lab there (and its logo in model-logos/), not here.
 */
export { FALLBACK_LAB, LABS, PROVIDER_NAME, labOf, providerOf } from '@itera/contracts/model-catalog'
export type { Lab, ProviderKey } from '@itera/contracts/model-catalog'
