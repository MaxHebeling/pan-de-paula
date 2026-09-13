"use client";

import { useSyncExternalStore } from "react";

/**
 * Estado global de movimiento: `<html data-motion="on" | "reduced">`.
 * Lo fija MOTION_BOOT_SCRIPT (inline, antes del primer paint) y lo mantiene sincronizado syncMotionAttribute().
 * Toda regla CSS que oculte o mueva contenido debe colgar de `html[data-motion="on"]`:
 * sin JS el atributo no existe y todo se ve; con reduced motion vale "reduced" y todo se ve.
 */
export const REDUCED_MQ = "(prefers-reduced-motion: reduce)";
export const FINE_POINTER_MQ = "(hover: hover) and (pointer: fine)";

export const MOTION_BOOT_SCRIPT = `(function(){var d=document.documentElement;try{d.setAttribute("data-motion",window.matchMedia("${REDUCED_MQ}").matches?"reduced":"on")}catch(e){d.setAttribute("data-motion","reduced")}})();`;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_MQ).matches;
}

/** ¿El movimiento está activo en este documento? (false en servidor, sin JS y con reduced motion) */
export function motionEnabled(): boolean {
  return (
    typeof document !== "undefined" && document.documentElement.getAttribute("data-motion") === "on"
  );
}

/** Puntero fino con hover (escritorio). En táctil no hay hover, magnetismo, tilt ni parallax. */
export function finePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia(FINE_POINTER_MQ).matches;
}

/** Mantiene `data-motion` al día si el usuario cambia la preferencia con la página abierta. */
export function syncMotionAttribute(): () => void {
  const mq = window.matchMedia(REDUCED_MQ);
  const apply = () =>
    document.documentElement.setAttribute("data-motion", mq.matches ? "reduced" : "on");
  apply();
  mq.addEventListener("change", apply);
  return () => mq.removeEventListener("change", apply);
}

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia(REDUCED_MQ);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** Hook: true si el usuario pidió reducir el movimiento. En servidor devuelve false. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
