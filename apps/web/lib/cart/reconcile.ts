/**
 * Reconciliación del carrito guardado en el navegador contra los precios y la disponibilidad del servidor.
 * Función pura (sin red ni almacenamiento): recibe las líneas guardadas y la foto del servidor, y devuelve
 * el carrito corregido más la lista de cambios que hay que avisarle al cliente.
 */
import { money } from "@/lib/format";
import { MAX_QTY, type CartLine } from "./types";

/** Foto de un producto según el servidor (canal web) en el momento de revalidar. */
export type ServerProduct = {
  productId: string;
  slug: string;
  name: string;
  variantLabel: string | null;
  /** Precio web vigente (`current_price_cents(product, 'web')`). */
  unitPriceCents: number;
  imageUrl: string | null;
  categorySlug: string | null;
  /** `availability().canAdd`: se puede seguir pidiendo (incluye lo que se hornea bajo pedido). */
  canAdd: boolean;
  soldOut: boolean;
  note: string | null;
};

export type CartChangeKind = "precio_subio" | "precio_bajo" | "agotado" | "retirado" | "cantidad";

export type CartChange = {
  kind: CartChangeKind;
  productId: string;
  name: string;
  fromCents?: number;
  toCents?: number;
  message: string;
};

export type Reconciliation = { lines: CartLine[]; changes: CartChange[] };

const piezas = (n: number) => `${n} ${n === 1 ? "pieza" : "piezas"}`;

/**
 * Compara el carrito guardado con la respuesta del servidor.
 * - Producto que ya no llega del servidor → se quitó del menú (o dejó de venderse en línea).
 * - Producto sin disponibilidad (`canAdd = false`) → se quita del carrito con su motivo.
 * - Precio distinto → la línea se actualiza al precio vigente y se avisa si subió o bajó.
 * - Cantidad fuera de rango → se recorta al máximo por pedido.
 * El resto de los datos de la línea (nombre, foto, categoría) también se refresca en silencio:
 * el servidor siempre manda.
 */
export function reconcileCart(lines: CartLine[], server: ServerProduct[]): Reconciliation {
  const byId = new Map<string, ServerProduct>();
  for (const p of server) if (!byId.has(p.productId)) byId.set(p.productId, p);

  const next: CartLine[] = [];
  const changes: CartChange[] = [];

  for (const line of lines) {
    const p = byId.get(line.productId);
    if (!p) {
      changes.push({
        kind: "retirado",
        productId: line.productId,
        name: line.name,
        message: `${line.name} ya no está en el menú. Lo quitamos de tu carrito.`,
      });
      continue;
    }
    if (!p.canAdd) {
      changes.push({
        kind: "agotado",
        productId: p.productId,
        name: p.name,
        message: p.soldOut
          ? `${p.name} se agotó. Lo quitamos de tu carrito.`
          : `${p.name} ya no está disponible. Lo quitamos de tu carrito.`,
      });
      continue;
    }

    const qty = Math.min(MAX_QTY, Math.max(1, Math.trunc(line.qty)));
    if (qty !== line.qty) {
      changes.push({
        kind: "cantidad",
        productId: p.productId,
        name: p.name,
        message: `Ajustamos ${p.name} a ${piezas(qty)}: es el máximo por pedido en línea.`,
      });
    }
    if (p.unitPriceCents !== line.unitPriceCents) {
      changes.push({
        kind: p.unitPriceCents > line.unitPriceCents ? "precio_subio" : "precio_bajo",
        productId: p.productId,
        name: p.name,
        fromCents: line.unitPriceCents,
        toCents: p.unitPriceCents,
        message: `El precio de ${p.name} cambió de ${money(line.unitPriceCents)} a ${money(p.unitPriceCents)}. Actualizamos tu carrito con el precio vigente.`,
      });
    }

    next.push({
      productId: p.productId,
      slug: p.slug,
      name: p.name,
      variantLabel: p.variantLabel,
      unitPriceCents: p.unitPriceCents,
      qty,
      imageUrl: p.imageUrl,
      categorySlug: p.categorySlug,
    });
  }

  return { lines: next, changes };
}
