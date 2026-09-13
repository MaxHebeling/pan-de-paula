import { isIP } from "node:net";

/**
 * Normaliza una IP recibida por cabeceras HTTP a algo que Postgres acepte como `inet`.
 * Devuelve null si no es una IP válida (nunca hay que pasar texto arbitrario a `::inet`: revienta el login).
 * Acepta "1.2.3.4", "1.2.3.4:5678", "[::1]:443", "::ffff:1.2.3.4".
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s || s.length > 64) return null;
  // [ipv6]:puerto
  const m6 = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (m6) s = m6[1]!;
  // ipv4:puerto
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  return isIP(s) ? s : null;
}

/**
 * IP del cliente a partir de `x-forwarded-for` (primer salto) o `x-real-ip`.
 * Devuelve null si no hay ninguna IP válida; la app trata null como "sin IP" (sin rate limit por IP).
 */
export function clientIpFromHeaders(get: (name: string) => string | null): string | null {
  const xff = get("x-forwarded-for");
  if (xff) {
    for (const part of xff.split(",")) {
      const ip = normalizeIp(part);
      if (ip) return ip;
    }
  }
  return normalizeIp(get("x-real-ip"));
}
