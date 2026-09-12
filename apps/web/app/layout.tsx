import type { Metadata, Viewport } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import "./globals.css";

const display = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: { default: "El Pan de Paula · Boulangerie", template: "%s · El Pan de Paula" },
  description:
    "Panadería artesanal. Croissants, galletas, roles y pan dulce recién horneado. Pide en línea y recoge en tienda.",
  openGraph: { type: "website", locale: "es_MX", siteName: "El Pan de Paula" },
};

export const viewport: Viewport = { themeColor: "#f7f3ec", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-MX" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
