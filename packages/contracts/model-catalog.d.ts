// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
/** The model catalog (model-catalog/labs.json + routes.json). See model-catalog.js. */
export type Lab = { key: string; name: string; logo: string };
export type ModelRoute = { key: string; name: string };
/** A lab key from labs.json (`anthropic`, `openai`, ..., or the fallback `generic`). */
export type ProviderKey = string;

export declare const FALLBACK_LAB: Lab;
export declare const LABS: Lab[];
export declare const PROVIDER_KEYS: string[];
export declare const PROVIDER_NAME: Record<ProviderKey, string>;
export declare function labOf(m: { id?: string | null; provider?: string | null; label?: string | null }): Lab;
export declare function providerOf(m: { id?: string | null; provider?: string | null; label?: string | null }): ProviderKey;
export declare const DEFAULT_ROUTE: ModelRoute;
export declare const ROUTES: ModelRoute[];
export declare const ROUTE_KEYS: string[];
export declare function routeOf(modelId?: string | null): ModelRoute;
export declare function isProviderKey(key: unknown): key is string;
export declare function isRouteKey(key: unknown): key is string;
