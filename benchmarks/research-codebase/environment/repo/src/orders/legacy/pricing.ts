// Deprecated: replaced by src/orders/pricing.ts. Kept only for the v1 import job.
export function applyCoupon(subtotal: number, percent: number): number {
  return subtotal - subtotal * (percent / 100);
}

export function calculateTax(amount: number): number {
  return amount * 0.2;
}
