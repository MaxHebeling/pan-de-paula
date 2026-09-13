import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logout, SESSION_COOKIE } from "@pdp/auth";
import { db } from "@/lib/db";

/** Cierra la sesión actual (revoca en base y borra la cookie). Solo POST del mismo origen (defensa en profundidad: el proxy ya rechaza Origin ajeno). */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== host)
      return NextResponse.json({ error: "Origen no permitido" }, { status: 403 });
  }
  const jar = await cookies();
  await logout(db(), jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
