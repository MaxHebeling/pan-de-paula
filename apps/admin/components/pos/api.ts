/** Cliente HTTP mínimo del POS: distingue error de red (encolable) de error de negocio (no encolable). */
import type { ApiError } from "./types";

export class NetworkError extends Error {
  constructor(message = "Sin conexión con el servidor") {
    super(message);
    this.name = "NetworkError";
  }
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code?: string };

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new NetworkError();
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch (e) {
    // fetch solo rechaza por red/CORS/abort: nunca por códigos HTTP.
    throw new NetworkError((e as Error).message);
  }
  // Sesión expirada: el proxy redirige a /login y fetch sigue la redirección → 200 con HTML. Sin esto el POS
  // tomaba el HTML como éxito (pantalla de venta rota) y la cola offline daba por sincronizada una venta
  // que nunca llegó al servidor (se perdía).
  if (res.redirected && new URL(res.url, "http://x").pathname.startsWith("/login")) {
    return {
      ok: false,
      status: 401,
      error: "Sesión expirada: vuelve a iniciar sesión (la venta no se registró)",
      code: "UNAUTHENTICATED",
    };
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (res.ok && !isJson) {
    return {
      ok: false,
      status: 502,
      error: "Respuesta inesperada del servidor",
      code: "BAD_RESPONSE",
    };
  }
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (e) {
      console.error("[pos] respuesta no JSON", url, res.status, (e as Error).message);
      body = null;
    }
  }
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const err = (body ?? {}) as Partial<ApiError>;
  return {
    ok: false,
    status: res.status,
    error: err.error ?? (res.status >= 500 ? "Error del servidor" : `Error ${res.status}`),
    code: err.code,
  };
}

export const postJson = <T>(url: string, body: unknown) =>
  apiFetch<T>(url, { method: "POST", body: JSON.stringify(body) });
