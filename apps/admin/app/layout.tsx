import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "El Pan de Paula · CRM", template: "%s · CRM El Pan de Paula" },
  description:
    "Sistema operativo de El Pan de Paula: POS, producción, inventario, clientes y reportes.",
  robots: { index: false, follow: false },
  icons: { icon: "/logo.png", apple: "/apple-icon.png" },
};
export const viewport: Viewport = {
  themeColor: "#f5f5f7",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-MX">
      <body className="min-h-dvh bg-bg text-ink antialiased">{children}</body>
    </html>
  );
}
