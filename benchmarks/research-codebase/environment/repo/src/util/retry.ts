export function backoffDelayMs(attempt: number, baseMs = 100, capMs = 5000): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}

export async function retryWithBackoff<T>(task: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
    }
  }
  throw lastError;
}
