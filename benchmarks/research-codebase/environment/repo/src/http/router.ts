export interface Route {
  method: 'GET' | 'POST';
  path: string;
  handler: (body: unknown) => { status: number; body: unknown };
}

export function handleHealth(): { status: number; body: unknown } {
  return { status: 200, body: { ok: true } };
}

export function registerRoutes(routes: Route[]): Map<string, Route['handler']> {
  const table = new Map<string, Route['handler']>();
  for (const route of routes) table.set(route.method + ' ' + route.path, route.handler);
  table.set('GET /health', handleHealth);
  return table;
}
