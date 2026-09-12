import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "El Pan de Paula · Panadería artesanal";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const logo = await readFile(join(process.cwd(), "public/brand/logo-512.png"));
  const logoSrc = `data:image/png;base64,${logo.toString("base64")}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 56,
          background: "#f7f3ec",
          color: "#1f2a3a",
          fontFamily: "Georgia, serif",
        }}
      >
        <img src={logoSrc} alt="" width={380} height={380} style={{ borderRadius: 999 }} />
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 560 }}>
          <div style={{ fontSize: 22, letterSpacing: 6, color: "#2f6b5f", textTransform: "uppercase" }}>Boulangerie</div>
          <div style={{ fontSize: 76, lineHeight: 1.05, marginTop: 8 }}>El Pan de Paula</div>
          <div style={{ fontSize: 30, marginTop: 18, color: "#3a4658", fontFamily: "Arial, sans-serif" }}>
            Pan artesanal recién horneado. Pide en línea y recoge en tu fecha.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
