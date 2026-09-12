import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export function GET() {
  return NextResponse.json({
    ok: true,
    app: "admin",
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    time: new Date().toISOString(),
  });
}
