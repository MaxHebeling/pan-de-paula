import { db, sql } from "@/lib/db";

/**
 * Catálogo para agregar productos a un pedido ya hecho (ver `add_order_items`, migración 0084).
 *
 * Dos criterios distintos, a propósito:
 *
 *  · El PRECIO sigue al canal del pedido. Un pedido web agrega a precio web, aunque se esté
 *    agregando en el mostrador: el ticket no puede mostrar dos precios para el mismo pan.
 *  · La DISPONIBILIDAD sigue al mostrador (`show_on_pos`). La persona está enfrente pidiendo lo
 *    que ve en la vitrina; limitar la lista a lo que se publica en la web no tendría sentido.
 *
 * Un producto sin precio para ese canal viene con `priceCents` en null y no se puede agregar: la
 * función de base lo rechazaría igual, pero es mejor que no se pueda elegir.
 */
export type ProductoAgregable = {
  id: string;
  name: string;
  variantLabel: string | null;
  categoryName: string | null;
  priceCents: number | null;
  trackStock: boolean;
  allowPreorder: boolean;
  onHand: number;
};

export type CatalogoAgregable = {
  productos: ProductoAgregable[];
  /** Si está encendido, el mostrador puede vender en negativo y no se bloquea nada por stock. */
  allowNegativeStock: boolean;
};

export async function loadCatalogoAgregable(canal: string): Promise<CatalogoAgregable> {
  const d = db();
  const esPos = canal === "pos";
  const [prods, bs] = await Promise.all([
    sql<{
      id: string;
      name: string;
      variant_label: string | null;
      category_name: string | null;
      price_cents: number | null;
      track_stock: boolean;
      allow_preorder: boolean;
      on_hand: string | number | null;
    }>`
      select cp.id, cp.name, cp.variant_label, cp.category_name,
             ${esPos ? sql`cp.pos_price_cents` : sql`cp.web_price_cents`} as price_cents,
             cp.track_stock, cp.allow_preorder, ss.on_hand
        from catalog_products cp
        left join stock_status ss on ss.product_id = cp.id
       where cp.is_active and cp.show_on_pos
       order by cp.sort_order, cp.name`.execute(d),
    sql<{ allow_negative_stock: boolean }>`
      select allow_negative_stock from business_settings where id = 1`.execute(d),
  ]);

  return {
    productos: prods.rows.map((p) => ({
      id: p.id,
      name: p.name,
      variantLabel: p.variant_label,
      categoryName: p.category_name,
      priceCents: p.price_cents,
      trackStock: p.track_stock,
      allowPreorder: p.allow_preorder,
      onHand: Number(p.on_hand ?? 0),
    })),
    allowNegativeStock: bs.rows[0]?.allow_negative_stock ?? false,
  };
}
