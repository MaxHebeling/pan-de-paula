import type { CartLineState } from "./types";

/**
 * El carrito del punto de venta sobrevive a salir de la pantalla.
 *
 * Por qué hace falta: `lines` vive en `useState` y no se guardaba en ninguna parte. Cobrar un
 * pedido (`/pos/cobrar/[id]`), abrir la caja o mirar los pendientes desmonta `PosScreen` y el
 * cajero perdía todo lo que llevaba escaneado, sin aviso. En un mostrador con cola eso es trabajo
 * tirado y un cliente esperando.
 *
 * DE QUIÉN es el carrito: la clave lleva el id del cajero Y un id de pestaña, y solo se recupera
 * un carrito que coincida en los dos. No es un detalle de implementación, es la regla que evita
 * cobrar lo que no es:
 *
 *  · Por cajero, porque la tablet del mostrador es compartida. Un carrito guardado por quien
 *    atendió antes NO debe aparecerle al siguiente turno: lo cobraría creyendo que es suyo, y el
 *    aviso de "se recuperó tu venta" le estaría mintiendo. `localStorage` no se borra al cerrar
 *    sesión —el cierre es un POST de formulario que no ejecuta nada en el navegador—, así que la
 *    separación tiene que estar en la clave, no en el cierre de sesión.
 *  · Por pestaña, porque dos pestañas del POS abiertas a la vez compartirían un único respaldo y
 *    la última en guardar borraría el de la otra. Con una ranura por pestaña no se pisan, y
 *    ninguna adopta lo que tecleó la otra. El id vive en `sessionStorage`, que es propio de cada
 *    pestaña y sobrevive a la navegación y a recargar.
 *
 * El precio de hacerlo por pestaña: una pestaña cerrada no deja carrito recuperable. Es el canje
 * correcto —volver a escanear cuesta minutos; cobrar la venta de otro cuesta dinero y confianza—.
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
 * descarta solo. Y al leer se podan las ranuras caducadas de cualquier cajero o pestaña, para que
 * el almacenamiento no crezca sin tope en una tablet que nunca se reinicia.
 *
 * Todo va en try/catch: en modo privado, con el almacenamiento lleno o bloqueado, `localStorage`
 * lanza. Perder el respaldo del carrito es aceptable; tumbar el punto de venta no.
 */
const PREFIJO = "pdp.pos.carrito.v2.";
/** Clave sin dueño de la primera versión: se borra en cuanto se ve, nunca se restaura. */
const CLAVE_LEGADA = "pdp.pos.carrito.v1";
const CLAVE_PESTANA = "pdp.pos.pestana";
const VIGENCIA_MS = 12 * 60 * 60 * 1000;

type Guardado = { at: number; lines: CartLineState[] };

/**
 * Id de esta pestaña, estable mientras viva. Si `sessionStorage` no está disponible NO se inventa
 * uno: sin forma de distinguir pestañas, todas compartirían ranura y volverían a pisarse. Se
 * devuelve `null` y el respaldo simplemente no funciona, que es el fallo seguro.
 */
function idPestana(): string | null {
  try {
    const previo = window.sessionStorage.getItem(CLAVE_PESTANA);
    if (previo) return previo;
    const nuevo =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(CLAVE_PESTANA, nuevo);
    return nuevo;
  } catch {
    return null;
  }
}

function clave(staffId: string): string | null {
  if (!staffId) return null;
  const pestana = idPestana();
  return pestana ? `${PREFIJO}${staffId}.${pestana}` : null;
}

/** Borra la clave sin dueño de la versión anterior y toda ranura ya caducada. */
function podar(): void {
  try {
    const s = window.localStorage;
    s.removeItem(CLAVE_LEGADA);
    // Se recolecta y después se borra: quitar durante el recorrido desplaza los índices.
    const sobran: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(PREFIJO)) continue;
      let caducada = true;
      try {
        const g = JSON.parse(s.getItem(k) ?? "null") as Partial<Guardado> | null;
        caducada = !g || typeof g.at !== "number" || Date.now() - g.at > VIGENCIA_MS;
      } catch {
        caducada = true;
      }
      if (caducada) sobran.push(k);
    }
    for (const k of sobran) s.removeItem(k);
  } catch {
    // Sin almacenamiento no hay nada que podar.
  }
}

export function guardarCarrito(staffId: string, lines: CartLineState[]): void {
  const k = clave(staffId);
  if (!k) return;
  try {
    if (lines.length === 0) {
      window.localStorage.removeItem(k);
      return;
    }
    const d: Guardado = { at: Date.now(), lines };
    window.localStorage.setItem(k, JSON.stringify(d));
  } catch (e) {
    console.warn("[pos] no se pudo guardar el carrito", (e as Error).message);
  }
}

/**
 * Los renglones recuperables de ESTE cajero en ESTA pestaña, o null. Nunca lanza y nunca devuelve
 * basura a medias.
 */
export function leerCarrito(staffId: string): CartLineState[] | null {
  const k = clave(staffId);
  if (!k) return null;
  podar();
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(k);
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
      limpiarCarrito(staffId);
      return null;
    }
    if (!Array.isArray(g.lines)) return null;
    // Se valida renglón por renglón: un formato viejo o corrupto no debe meter un precio inventado
    // en una venta. Si algo no cuadra, se descarta todo en lugar de restaurar a medias.
    if (!g.lines.every(esRenglon)) {
      limpiarCarrito(staffId);
      return null;
    }
    return g.lines.length > 0 ? (g.lines as CartLineState[]) : null;
  } catch {
    limpiarCarrito(staffId);
    return null;
  }
}

export function limpiarCarrito(staffId: string): void {
  const k = clave(staffId);
  if (!k) return;
  try {
    window.localStorage.removeItem(k);
  } catch {
    // Sin almacenamiento no hay nada que limpiar.
  }
}

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
