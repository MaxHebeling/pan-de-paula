import { NextResponse, type NextRequest } from "next/server";

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

/** Gate ligero: sin cookie de sesión no se entra al CRM. La validación real ocurre en el servidor (requireSession). */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const res = NextResponse.next({
    request: {
      headers: new Headers({ ...Object.fromEntries(req.headers), "x-pathname": pathname }),
    },
  });
  if (
    PUBLIC_PATHS.some(
      (p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p),
    )
  )
    return res;
  // Protección CSRF básica para mutaciones: Origin debe coincidir con Host.
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) {
      return NextResponse.json({ error: "Origen no permitido" }, { status: 403 });
    }
  }
  if (!req.cookies.get("pdp_session")?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
