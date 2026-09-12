import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logout, SESSION_COOKIE } from "@pdp/auth";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const jar = await cookies();
  await logout(db(), jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
