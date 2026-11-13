import { reserveStock } from '../inventory/stock.js';
import { applyCoupon, calculateSubtotal, calculateTax, type Coupon, type LineItem } from './pricing.js';

export interface Order {
  userId: string;
  items: LineItem[];
  totalCents: number;
}

export function validateCart(items: LineItem[]): string[] {
  const problems: string[] = [];
  if (items.length === 0) problems.push('cart is empty');
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      problems.push('invalid quantity for ' + item.sku);
    }
  }
  return problems;
}

export function placeOrder(userId: string, items: LineItem[], coupon: Coupon | null, region: string): Order {
  const problems = validateCart(items);
  if (problems.length > 0) throw new Error(problems.join('; '));
  for (const item of items) reserveStock(item.sku, item.quantity);
  const discounted = applyCoupon(calculateSubtotal(items), coupon);
  return { userId, items, totalCents: discounted + calculateTax(discounted, region) };
}
