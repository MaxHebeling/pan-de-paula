import type { CartLineState } from "./types";

/**
 * El carrito del punto de venta sobrevive a salir de la pantalla.
 *
 * Por qué hace falta: `lines` vive en `useState` y no se guardaba en ninguna parte. Cobrar un
 * pedido (`/pos/cobrar/[id]`), abrir la caja o mirar los pendientes desmonta `PosScreen` y el
 * cajero perdía todo lo que llevaba escaneado, sin aviso. En un mostrador con cola eso es trabajo
 * tirado y un cliente esperando.
 *
 * Qué se guarda y qué NO, a propósito:
 *
 *  · Los renglones, sí: es el trabajo manual irrecuperable (escanear o buscar pieza por pieza).
 *  · El cupón y la recompensa, no. Los valida el servidor y pueden haberse consumido mientras la
 *    pantalla estaba cerrada; restaurarlos de memoria aplicaría un descuento que ya no existe.
 *    Volver a aplicarlos es un clic y pasa por su validación.
 *  · El cliente, no. Su saldo de puntos pudo cambiar, y un saldo viejo puede habilitar una
 *    recompensa que ya no alcanza. Identificarlo otra vez es una búsqueda.
 *
 * Caduca: un carrito de la jornada anterior no debe resucitar sobre el mostrador. A las 12 horas se
 * descarta solo.
 *
 * Todo va en try/catch: en modo privado, con el almacenamiento lleno o bloqueado, `localStorage`
 * lanza. Perder el respaldo del carrito es aceptable; tumbar el punto de venta no.
 */
const CLAVE = "pdp.pos.carrito.v1";
const VIGENCIA_MS = 12 * 60 * 60 * 1000;

type Guardado = { at: number; lines: CartLineState[] };

function esRenglon(x: unknown): x is CartLineState {
  if (!x || typeof x !== "object") return false;
  const l = x as Record<string, unknown>;
  return (
    typeof l.productId === "string" &&
    typeof l.name === "string" &&
    typeof l.unitPriceCents === "number" &&
    typeof l.qty === "number" &&
    l.qty > 0 &&
    typeof l.discountCents === "number" &&
    typeof l.notes === "string" &&
    (l.variantLabel === null || typeof l.variantLabel === "string")
  );
}

export function guardarCarrito(lines: CartLineState[]): void {
  try {
    if (lines.length === 0) {
      window.localStorage.removeItem(CLAVE);
      return;
    }
    const d: Guardado = { at: Date.now(), lines };
    window.localStorage.setItem(CLAVE, JSON.stringify(d));
  } catch (e) {
    console.warn("[pos] no se pudo guardar el carrito", (e as Error).message);
  }
}

/** Devuelve los renglones recuperables, o null. Nunca lanza y nunca devuelve basura a medias. */
export function leerCarrito(): CartLineState[] | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(CLAVE);
  } catch (e) {
    console.warn("[pos] no se pudo leer el carrito", (e as Error).message);
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as unknown;
    if (!d || typeof d !== "object") return null;
    const g = d as Partial<Guardado>;
    if (typeof g.at !== "number" || Date.now() - g.at > VIGENCIA_MS) {
      limpiarCarrito();
      return null;
    }
    if (!Array.isArray(g.lines)) return null;
    // Se valida renglón por renglón: un formato viejo o corrupto no debe meter un precio inventado
    // en una venta. Si algo no cuadra, se descarta todo en lugar de restaurar a medias.
    if (!g.lines.every(esRenglon)) {
      limpiarCarrito();
      return null;
    }
    return g.lines.length > 0 ? (g.lines as CartLineState[]) : null;
  } catch {
    limpiarCarrito();
    return null;
  }
}

export function limpiarCarrito(): void {
  try {
    window.localStorage.removeItem(CLAVE);
  } catch {
    // Sin almacenamiento no hay nada que limpiar.
  }
}
