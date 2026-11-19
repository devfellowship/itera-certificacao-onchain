import type { Order } from '../orders/checkout.js';

export function renderReceiptEmail(order: Order): string {
  const lines = order.items.map((i) => i.quantity + ' x ' + i.sku);
  return 'Thanks for your order.\n' + lines.join('\n') + '\nTotal: ' + (order.totalCents / 100).toFixed(2);
}

export function sendReceipt(order: Order, send: (to: string, text: string) => void): void {
  send(order.userId + '@example.test', renderReceiptEmail(order));
}
