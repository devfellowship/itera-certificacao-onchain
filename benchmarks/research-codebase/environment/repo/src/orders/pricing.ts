export interface LineItem {
  sku: string;
  unitCents: number;
  quantity: number;
}

export interface Coupon {
  code: string;
  percentOff: number;
  minSubtotalCents: number;
}

export function calculateSubtotal(items: LineItem[]): number {
  let total = 0;
  for (const item of items) total += item.unitCents * item.quantity;
  return total;
}

export function applyCoupon(subtotalCents: number, coupon: Coupon | null): number {
  if (coupon === null) return subtotalCents;
  if (subtotalCents < coupon.minSubtotalCents) return subtotalCents;
  const discount = Math.floor((subtotalCents * coupon.percentOff) / 100);
  return subtotalCents - discount;
}

const TAX_RATE_BY_REGION: Record<string, number> = { eu: 0.21, us: 0.07, br: 0.17 };

export function calculateTax(amountCents: number, region: string): number {
  const rate = TAX_RATE_BY_REGION[region] ?? 0;
  return Math.round(amountCents * rate);
}
