/**
 * Compatibility entry point. The Solana Pay gateway lives behind the payment adapter seam
 * (plan 20261015-testmyagent-web2-client, ADR-6): `payments/adapters/solana-pay-gateway.ts`.
 * Existing imports keep working through this file. It imports no Solana package.
 */
export { SolanaPayGateway } from "../payments/adapters/solana-pay-gateway.js";
export type { PaymentGateway, TransferFields, VerifyResult } from "../payments/adapters/solana-pay-gateway.js";
