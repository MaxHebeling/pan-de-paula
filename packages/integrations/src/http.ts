/** Cliente HTTP resiliente: timeout, reintentos con backoff, circuit breaker simple por host. */
export type HttpOptions = RequestInit & {
  timeoutMs?: number;
  retries?: number;
  retryOn?: (res: Response | null, err: unknown) => boolean;
  idempotent?: boolean;
};

const breakers = new Map<string, { failures: number; openUntil: number }>();
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30_000;

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} ${url}`);
  }
}

export async function fetchWithResilience(url: string, opts: HttpOptions = {}): Promise<Response> {
  const host = new URL(url).host;
  const b = breakers.get(host);
  if (b && b.openUntil > Date.now())
    throw new Error(`Circuito abierto para ${host} (demasiados fallos recientes)`);
  const { timeoutMs = 8000, retries = opts.idempotent === false ? 0 : 2, retryOn, ...init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(t);
      const shouldRetry = retryOn ? retryOn(res, null) : res.status >= 500 || res.status === 429;
      if (res.ok || !shouldRetry || attempt === retries) {
        if (res.ok) breakers.delete(host);
        else recordFailure(host);
        return res;
      }
      recordFailure(host);
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      recordFailure(host);
      const shouldRetry = retryOn ? retryOn(null, e) : true;
      if (!shouldRetry || attempt === retries) throw e;
    }
    await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 100));
  }
  throw lastErr ?? new Error("fetch falló");
}

function recordFailure(host: string) {
  const b = breakers.get(host) ?? { failures: 0, openUntil: 0 };
  b.failures++;
  if (b.failures >= BREAKER_THRESHOLD) {
    b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    b.failures = 0;
  }
  breakers.set(host, b);
}

/** Solo para tests. */
export function _resetBreakers() {
  breakers.clear();
}
