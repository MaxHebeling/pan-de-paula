/**
 * Validación del destino de retorno (`?next=`) al abrir la caja desde el panel de cobro.
 *
 * El caso que resuelve: con la caja cerrada, cobrar un pedido manda a abrirla, y antes el operador
 * tenía que volver a buscar el pedido a mano. El `next` le devuelve al mismo pedido.
 *
 * Vive aparte de `caja/actions.ts` porque lo necesitan DOS sitios —la acción de apertura y la
 * propia página de caja, que honra el retorno cuando la caja ya estaba abierta— y un módulo
 * `"use server"` solo puede exportar funciones asíncronas. Una sola regla, un solo sitio.
 *
 * El parámetro no se arregla, se acepta o se rechaza. Es una lista blanca estricta: rutas internas
 * del punto de venta con caracteres de ruta y nada más. Así quedan fuera, sin enumerar trampas:
 * `https://…` y `//otro.sitio` (redirección abierta servida por nuestro dominio), `..` y `%2e%2e`
 * (el punto no está permitido), `\` y cualquier escape porcentual, y las cadenas con consulta o
 * fragmento. El enlace real que lo produce es `usePathname()` del panel de cobro —`/pos/cobrar/<id>`
 * o `/pos/pendientes`—, que siempre cumple.
 */
const RUTA_POS = /^\/pos\/[A-Za-z0-9/_-]*$/;

/** La ruta de retorno si es un destino interno aceptable; `null` si no lo es. */
export function rutaPosSegura(next: string | undefined | null): string | null {
  if (!next || next.length > 200) return null;
  if (next.startsWith("//")) return null;
  return RUTA_POS.test(next) ? next : null;
}
