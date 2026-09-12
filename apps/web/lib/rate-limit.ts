import "server-only";
import { headers } from "next/headers";
import { callFn, db } from "@/lib/db";

export type RateLimitResult = { allowed: boolean; hits: number; limit: number; resets_at: string };

/** IP del cliente (Vercel/proxies) o "local" en desarrollo. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  const ip = (fwd ? fwd.split(",")[0] : null) ?? h.get("x-real-ip") ?? h.get("cf-connecting-ip");
  return (ip ?? "local").trim().slice(0, 64);
}

/** Ventana fija de 10 minutos, máximo 20 intentos por IP y ruta (tabla rate_limits, migración 0050). */
export async function rateLimit(
  route: string,
  opts: { max?: number; windowSeconds?: number } = {},
) {
  const ip = await clientIp();
  const r = await callFn<RateLimitResult>(db(), "rate_limit_hit", [
    ip,
    route,
    opts.windowSeconds ?? 600,
    opts.max ?? 20,
  ]);
  if (!r.allowed) {
    console.warn(`[rate-limit] ${route} bloqueado para ${ip} (${r.hits}/${r.limit})`);
  }
  return r;
}

export const RATE_LIMIT_MESSAGE =
  "Recibimos demasiados intentos desde tu conexión. Espera unos minutos e inténtalo de nuevo.";
