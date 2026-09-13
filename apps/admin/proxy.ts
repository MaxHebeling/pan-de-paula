import { NextResponse, type NextRequest } from "next/server";

/** Rutas sin sesión (coincidencia exacta o por prefijo de segmento: "/login" cubre "/login/x" pero no "/loginx"). */
const PUBLIC_PATHS = [
  "/login",
  "/recuperar",
  "/restablecer",
  "/api/health",
  "/api/ready",
  "/api/auth",
  "/api/cron",
  "/403",
  "/_next",
  "/favicon.ico",
  "/logo.png",
  "/apple-icon.png",
  "/manifest.webmanifest",
  "/icons",
];

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** Host del header Origin, o null si no es una URL válida. */
function originHost(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** Gate ligero: sin cookie de sesión no se entra al CRM. La validación real ocurre en el servidor (requireSession). */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const res = NextResponse.next({
    request: {
      headers: new Headers({ ...Object.fromEntries(req.headers), "x-pathname": pathname }),
    },
  });
  // Protección CSRF para TODA mutación, también en rutas públicas (p. ej. /api/auth/logout): Origin debe coincidir con Host.
  if (MUTATING.has(req.method)) {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && originHost(origin) !== host) {
      return NextResponse.json({ error: "Origen no permitido" }, { status: 403 });
    }
  }
  if (isPublic(pathname)) return res;
  if (!req.cookies.get("pdp_session")?.value) {
    // APIs: 401 JSON (mismo formato que apiSession). Un redirect a /login hacía que fetch recibiera HTML con 200.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Sesión expirada", code: "UNAUTHENTICATED" },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
