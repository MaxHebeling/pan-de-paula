"use client";

import { useEffect, useRef } from "react";

/**
 * Lectores de código USB/Bluetooth: escuchan en TODA la pantalla del POS, no en un campo.
 *
 * Esos lectores se comportan como un teclado muy rápido: escriben el código y mandan Enter. El
 * problema es dónde cae ese texto — si el foco está en "Buscar producto", el código del cliente se
 * mete ahí y no pasa nada. Este enganche escucha en el documento y se queda con las ráfagas de
 * teclas que NINGUNA persona podría escribir a esa velocidad; lo que se teclea a mano sigue su
 * camino normal.
 *
 * No interfiere: si el foco está en un campo de texto (incluido el buscador de clientes, que ya
 * maneja su Enter), la ráfaga se ignora aquí y la trata ese campo.
 */
const MAX_MS_ENTRE_TECLAS = 50; // una persona no escribe a 20 teclas por segundo
const MIN_LARGO = 6;

export function useScanner(onScan: (codigo: string) => void, activo = true): void {
  const buffer = useRef("");
  const ultima = useRef(0);
  const cb = useRef(onScan);
  useEffect(() => {
    cb.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!activo) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const escribiendo =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (escribiendo) return; // ese campo se encarga

      const ahora = Date.now();
      if (ahora - ultima.current > MAX_MS_ENTRE_TECLAS) buffer.current = "";
      ultima.current = ahora;

      if (e.key === "Enter") {
        const codigo = buffer.current.trim();
        buffer.current = "";
        if (codigo.length >= MIN_LARGO) {
          e.preventDefault();
          cb.current(codigo);
        }
        return;
      }
      // Solo caracteres imprimibles: se ignoran F2, Escape, flechas y demás atajos del POS.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) buffer.current += e.key;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activo]);
}
