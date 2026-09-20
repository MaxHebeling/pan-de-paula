"use client";

/**
 * Lo que el navegador necesita para la aplicación instalable y las notificaciones.
 *
 * Todo aquí asume lo peor: navegadores sin service worker, iPhones sin push fuera de la aplicación
 * instalada, permisos denegados para siempre y almacenamiento bloqueado. Nada lanza excepción hacia
 * la pantalla: si algo no se puede, se devuelve un motivo y la interfaz decide qué decir.
 */

export type PushEstado =
  | "listo" // suscrito y funcionando
  | "puede" // se puede pedir el permiso
  | "denegado" // el cliente dijo que no (hay que ir a los ajustes del navegador)
  | "requiere-instalar" // iPhone: solo hay push dentro de la app instalada
  | "no-soportado";

export const enPantallaCompleta = (): boolean =>
  typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches ||
    // iOS tiene su propia marca y no implementa display-mode: standalone.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true);

/** iPhone o iPad (desde iPadOS 13 el iPad se anuncia como Mac, de ahí la comprobación táctil). */
export const esIOS = (): boolean => {
  if (typeof navigator === "undefined") return false;
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
};

/** Registra el service worker. Silencioso: si el navegador no lo soporta, no pasa nada. */
export async function registrarServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

/** En qué situación está el push AHORA, sin pedir nada ni molestar al cliente. */
export async function estadoPush(): Promise<PushEstado> {
  if (typeof window === "undefined") return "no-soportado";
  const soporta =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  // iPhone solo acepta push dentro de la aplicación agregada a la pantalla de inicio.
  if (!soporta) return esIOS() && !enPantallaCompleta() ? "requiere-instalar" : "no-soportado";
  if (Notification.permission === "denied") return "denegado";
  if (Notification.permission === "granted") {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? "listo" : "puede";
  }
  return "puede";
}

/**
 * La clave pública VAPID en el formato que espera el navegador (base64url → bytes).
 * Se devuelve un `ArrayBuffer` porque es lo que acepta `applicationServerKey` en los tipos del DOM.
 */
function claveAplicacion(base64: string): ArrayBuffer {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

/**
 * Pide el permiso (solo se llama tras un gesto del cliente), se suscribe y lo guarda en el servidor.
 * Devuelve el estado resultante para que la interfaz diga la verdad sin adivinar.
 */
export async function activarPush(vapidPublicKey: string): Promise<PushEstado> {
  const estado = await estadoPush();
  if (estado !== "puede") return estado;
  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") return permiso === "denied" ? "denegado" : "puede";
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registrarServiceWorker());
  if (!reg) return "no-soportado";
  try {
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: claveAplicacion(vapidPublicKey),
      }));
    const r = await fetch("/api/portal/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    return r.ok ? "listo" : "puede";
  } catch {
    return "puede";
  }
}

/** Apaga los avisos en ESTE dispositivo (no toca los demás ni las preferencias de la cuenta). */
export async function desactivarPush(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/portal/push", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
