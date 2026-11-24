const available = new Map<string, number>();

export function seedStock(sku: string, quantity: number): void {
  available.set(sku, quantity);
}

export function reserveStock(sku: string, quantity: number): void {
  const current = available.get(sku) ?? 0;
  if (current < quantity) throw new Error('insufficient stock for ' + sku);
  available.set(sku, current - quantity);
}

export function releaseStock(sku: string, quantity: number): void {
  const current = available.get(sku) ?? 0;
  available.set(sku, current + quantity);
}
