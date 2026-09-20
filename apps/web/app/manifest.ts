import type { MetadataRoute } from "next";

/**
 * Manifiesto de la aplicación instalable.
 *
 * `start_url` apunta al portal porque eso es lo que el cliente instala: su cuenta, sus pedidos y su
 * QR a un toque. Quien no tenga sesión cae en /portal/entrar, que es justo donde debe empezar.
 * El menú y la tienda siguen a un toque desde los accesos directos.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/portal",
    name: "El Pan de Paula",
    short_name: "Pan de Paula",
    description: "Tus pedidos, tus puntos y tu tarjeta del club, siempre a la mano.",
    start_url: "/portal",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f3ec",
    theme_color: "#f7f3ec",
    lang: "es-MX",
    categories: ["food", "shopping"],
    shortcuts: [
      { name: "Mis pedidos", url: "/portal/pedidos" },
      { name: "Mi tarjeta", url: "/portal" },
      { name: "Menú", url: "/menu" },
    ],
    icons: [
      { src: "/brand/logo-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/logo-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/brand/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
