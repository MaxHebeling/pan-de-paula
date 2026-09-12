import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: la app responde. No toca la base. */
export function GET() {
  return NextResponse.json({
    ok: true,
    app: "web",
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    time: new Date().toISOString(),
  });
}
