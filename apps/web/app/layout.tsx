import type { Metadata, Viewport } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import { WEEKDAY_LABELS } from "@pdp/domain";
import { CartDrawer } from "@/components/CartDrawer";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { JsonLd } from "@/components/JsonLd";
import { CartProvider } from "@/lib/cart/CartProvider";
import { MotionProvider } from "@/lib/motion/MotionProvider";
import { PageTransition } from "@/lib/motion/pageTransition";
import { MOTION_BOOT_SCRIPT } from "@/lib/motion/reducedMotion";
import { fullAddress, getBusiness, instagramUrl } from "@/lib/site";
import "./globals.css";

// El sitio lee horarios, catálogo y estado "abierto" en cada petición: nada se congela en build.
export const dynamic = "force-dynamic";

const display = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "El Pan de Paula · Panadería artesanal", template: "%s · El Pan de Paula" },
  description:
    "Panadería artesanal. Croissants, kouign-amann, galletas y pan de temporada recién horneados. Pide en línea y recoge en tienda en tu fecha.",
  applicationName: "El Pan de Paula",
  openGraph: { type: "website", locale: "es_MX", siteName: "El Pan de Paula" },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
  icons: {
    // .ico (16/32/48) para la pestaña y PNG de 96 para pantallas densas. El .svg del paquete original
    // no era vectorial (traía un PNG de 2020 px incrustado, 112 KB) y no se usa.
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/brand/favicon-96.png", sizes: "96x96", type: "image/png" },
    ],
    apple: "/brand/apple-icon.png",
  },
};

export const viewport: Viewport = { themeColor: "#f7f3ec", width: "device-width", initialScale: 1 };

const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const business = await getBusiness();
  const address = fullAddress(business);
  const bakeryLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Bakery",
    name: business.name,
    url: SITE_URL,
    image: `${SITE_URL}/brand/logo-512.png`,
    logo: `${SITE_URL}/brand/logo-512.png`,
    servesCuisine: "Panadería artesanal",
    priceRange: "$$",
    currenciesAccepted: "MXN",
    openingHoursSpecification: business.hours
      .filter((h) => h.isOpen && h.opensAt && h.closesAt)
      .map((h) => ({
        "@type": "OpeningHoursSpecification",
        dayOfWeek: EN_DAYS[h.weekday],
        opens: h.opensAt,
        closes: h.closesAt,
        name: WEEKDAY_LABELS[h.weekday],
      })),
  };
  if (business.phone) bakeryLd.telephone = business.phone;
  if (business.email) bakeryLd.email = business.email;
  if (address) {
    bakeryLd.address = {
      "@type": "PostalAddress",
      streetAddress: business.address ?? undefined,
      addressLocality: business.city ?? undefined,
      addressRegion: business.state ?? undefined,
      addressCountry: "MX",
    };
  }
  const ig = instagramUrl(business.instagramHandle);
  if (ig) bakeryLd.sameAs = [ig];

  return (
    <html
      lang="es-MX"
      className={`${display.variable} ${body.variable}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body className="paper-bg flex min-h-dvh flex-col">
        {/* Fija html[data-motion] antes del primer paint (≈200 B). Sin JS nunca se aplica: el sitio se ve completo. */}
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOT_SCRIPT }} />
        <CartProvider>
          <Header />
          <main id="contenido" className="flex-1">
            <PageTransition>{children}</PageTransition>
          </main>
          <Footer business={business} />
          <CartDrawer />
        </CartProvider>
        <MotionProvider />
        <JsonLd data={bakeryLd} />
      </body>
    </html>
  );
}
