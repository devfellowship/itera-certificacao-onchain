/**
 * S6 per-case compare rule (plan 20261112-tma-c5-studio-area-web2, task C5-T7).
 *
 * The rule lives in ONE library that web2 and the API share (plan 20261112-tma-c7-model-comparison-per-use-case,
 * ADR-7): packages/contracts/compare.js. This file only re-exports it, so the studio keeps its import path.
 */
export * from '@itera/contracts/compare'
