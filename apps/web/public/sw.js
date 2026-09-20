/*
 * Service worker de El Pan de Paula.
 *
 * Hace tres cosas y ninguna más:
 *   1. permite instalar el portal como aplicación (Chrome exige un service worker con `fetch`);
 *   2. recibe las notificaciones push y las muestra;
 *   3. da una página decente cuando no hay conexión.
 *
 * Lo que NO hace, a propósito: cachear páginas con datos. El estado de un pedido cambia solo y
 * enseñar una copia vieja como si fuera la de ahora es peor que no enseñar nada. Las páginas se
 * piden SIEMPRE a la red; si la red falla se muestra /offline, que dice justo eso. Solo se guardan
 * los recursos estáticos con huella (los de /_next/static), que nunca cambian sin cambiar de nombre.
 */
const VERSION = "pdp-v1";
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll([OFFLINE_URL, "/brand/logo-192.png"]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Al cambiar de versión se tiran las cachés viejas: nada de restos de una versión anterior.
      const nombres = await caches.keys();
      await Promise.all(nombres.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Recursos con huella: se sirven de caché y se guardan la primera vez.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/brand/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSETS);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  // Páginas: siempre a la red. Sin conexión, la página de cortesía (nunca datos viejos).
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(SHELL);
          return (await cache.match(OFFLINE_URL)) ?? Response.error();
        }
      })(),
    );
  }
});

// ── Push ────────────────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let datos = {};
  try {
    datos = event.data ? event.data.json() : {};
  } catch {
    datos = {};
  }
  const titulo = datos.title || "El Pan de Paula";
  event.waitUntil(
    self.registration.showNotification(titulo, {
      body: datos.body || "",
      icon: "/brand/logo-192.png",
      badge: "/brand/logo-96.png",
      // Mismo `tag` = el aviso nuevo del pedido sustituye al anterior en vez de apilarse.
      tag: datos.tag || "pdp",
      renotify: true,
      data: { url: datos.url || "/portal" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destino = (event.notification.data && event.notification.data.url) || "/portal";
  event.waitUntil(
    (async () => {
      const ventanas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Si la app ya está abierta se reutiliza esa ventana en vez de abrir otra.
      for (const w of ventanas) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          if ("navigate" in w) await w.navigate(destino);
          return;
        }
      }
      await self.clients.openWindow(destino);
    })(),
  );
});
