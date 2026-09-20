"use client";

import { useEffect, useRef } from "react";
import { marcarAvisosDelPedidoAction } from "@/app/portal/(sesion)/actions";

/**
 * Marca como leídos los avisos de ESTE pedido cuando el cliente abre su seguimiento.
 *
 * Va en una acción al montar y no en el render de la página a propósito: Next precarga los enlaces
 * al pasar el dedo o el ratón por encima, y marcar durante el render apagaría la campana de avisos
 * que el cliente todavía no ha visto. La acción revalida el portal, así que el contador se apaga
 * solo en cuanto de verdad abre el pedido.
 */
export function MarkOrderRead({ folio }: { folio: string }) {
  const hecho = useRef(false);
  useEffect(() => {
    if (hecho.current) return;
    hecho.current = true;
    void marcarAvisosDelPedidoAction(folio);
  }, [folio]);
  return null;
}
