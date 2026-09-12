import "server-only";
import QRCode from "qrcode";

/** PNG (data URL) del QR de la tarjeta, con la paleta de la marca. */
export async function qrDataUrl(text: string, size = 512): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: size,
    color: { dark: "#1f2a3a", light: "#fffdf9" },
  });
}

export function cardUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return `${base}/mi-tarjeta/${encodeURIComponent(token)}`;
}
