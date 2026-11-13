export interface AppConfig {
  port: number;
  databaseUrl: string;
  logLevel: 'debug' | 'info' | 'warn';
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const level = env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'warn' ? env.LOG_LEVEL : 'info';
  return { port: parsePort(env.PORT), databaseUrl, logLevel: level };
}
