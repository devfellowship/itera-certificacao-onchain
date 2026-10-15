import { dflAdapter } from "./dfl.js";
import { siwsAdapter } from "./siws.js";
import type { AuthAdapter, PrincipalKind } from "./types.js";

export type { AuthAdapter, Principal, PrincipalKind } from "./types.js";
export { dflAdapter, siwsAdapter };

/** Every auth adapter the API mounts, by kind. */
export const AUTH_ADAPTERS: Readonly<Record<PrincipalKind, AuthAdapter>> = {
  siws: siwsAdapter,
  dfl: dflAdapter,
};
