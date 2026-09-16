/**
 * Reconciliación del carrito guardado contra la foto del servidor: precio distinto (sube y baja),
 * producto agotado, producto retirado del menú, carrito vacío y cantidades por encima del máximo.
 * Función pura: sin red ni almacenamiento.
 */
import { describe, expect, it } from "vitest";
import { reconcileCart, type ServerProduct } from "../lib/cart/reconcile.ts";
import { MAX_QTY, type CartLine } from "../lib/cart/types.ts";

const CROISSANT = "11111111-1111-4111-8111-111111111111";
const CONCHA = "22222222-2222-4222-8222-222222222222";

const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: CROISSANT,
  slug: "croissant-dubai",
  name: "Croissant Dubai",
  variantLabel: null,
  unitPriceCents: 11500,
  qty: 2,
  imageUrl: null,
  categorySlug: "panaderia",
  ...over,
});

const server = (over: Partial<ServerProduct> = {}): ServerProduct => ({
  productId: CROISSANT,
  slug: "croissant-dubai",
  name: "Croissant Dubai",
  variantLabel: null,
  unitPriceCents: 11500,
  imageUrl: null,
  categorySlug: "panaderia",
  canAdd: true,
  soldOut: false,
  note: null,
  ...over,
});

describe("reconciliación del carrito", () => {
  it("carrito vacío: sin líneas y sin avisos (aunque el servidor traiga productos)", () => {
    expect(reconcileCart([], [server()])).toEqual({ lines: [], changes: [] });
  });

  it("todo igual: no inventa avisos y conserva las líneas", () => {
    const r = reconcileCart([line()], [server()]);
    expect(r.changes).toEqual([]);
    expect(r.lines).toEqual([line()]);
  });

  it("el precio subió: la línea toma el precio vigente y el aviso nombra ambos precios", () => {
    const r = reconcileCart([line()], [server({ unitPriceCents: 12000 })]);
    expect(r.lines[0]!.unitPriceCents).toBe(12000);
    expect(r.lines[0]!.qty).toBe(2);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({
      kind: "precio_subio",
      productId: CROISSANT,
      fromCents: 11500,
      toCents: 12000,
    });
    expect(r.changes[0]!.message).toBe(
      "El precio de Croissant Dubai cambió de $115.00 a $120.00. Actualizamos tu carrito con el precio vigente.",
    );
  });

  it("el precio bajó: también se avisa y se aplica el precio nuevo", () => {
    const r = reconcileCart([line()], [server({ unitPriceCents: 9900 })]);
    expect(r.lines[0]!.unitPriceCents).toBe(9900);
    expect(r.changes[0]).toMatchObject({ kind: "precio_bajo", fromCents: 11500, toCents: 9900 });
    expect(r.changes[0]!.message).toMatch(/\$99\.00/);
  });

  it("producto agotado sin preventa: se quita del carrito con su motivo", () => {
    const r = reconcileCart([line()], [server({ canAdd: false, soldOut: true })]);
    expect(r.lines).toEqual([]);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: "agotado", productId: CROISSANT });
    expect(r.changes[0]!.message).toBe("Croissant Dubai se agotó. Lo quitamos de tu carrito.");
  });

  it("producto sin precio o bloqueado sin estar agotado: se quita con mensaje neutro", () => {
    const r = reconcileCart([line()], [server({ canAdd: false, soldOut: false })]);
    expect(r.lines).toEqual([]);
    expect(r.changes[0]!.message).toBe(
      "Croissant Dubai ya no está disponible. Lo quitamos de tu carrito.",
    );
  });

  it("producto retirado (el servidor ya no lo devuelve): se quita usando el nombre guardado", () => {
    const r = reconcileCart([line()], []);
    expect(r.lines).toEqual([]);
    expect(r.changes[0]).toMatchObject({ kind: "retirado", productId: CROISSANT });
    expect(r.changes[0]!.message).toBe(
      "Croissant Dubai ya no está en el menú. Lo quitamos de tu carrito.",
    );
  });

  it("cantidad por encima del máximo: se recorta y se avisa; 1 pieza se dice en singular", () => {
    const r = reconcileCart([line({ qty: MAX_QTY + 30 })], [server()]);
    expect(r.lines[0]!.qty).toBe(MAX_QTY);
    expect(r.changes[0]).toMatchObject({ kind: "cantidad", productId: CROISSANT });
    expect(r.changes[0]!.message).toBe(
      `Ajustamos Croissant Dubai a ${MAX_QTY} piezas: es el máximo por pedido en línea.`,
    );
    const uno = reconcileCart([line({ qty: 1.7 })], [server()]);
    expect(uno.lines[0]!.qty).toBe(1);
    expect(uno.changes[0]!.message).toMatch(/a 1 pieza:/);
  });

  it("precio y cantidad a la vez: dos avisos para la misma línea", () => {
    const r = reconcileCart([line({ qty: 999 })], [server({ unitPriceCents: 12000 })]);
    expect(r.lines[0]).toMatchObject({ qty: MAX_QTY, unitPriceCents: 12000 });
    expect(r.changes.map((c) => c.kind)).toEqual(["cantidad", "precio_subio"]);
  });

  it("varias líneas: conserva las buenas, corrige las cambiadas y quita las que ya no van", () => {
    const concha = line({
      productId: CONCHA,
      slug: "concha",
      name: "Concha",
      unitPriceCents: 2500,
    });
    const r = reconcileCart(
      [line(), concha],
      [
        server({ unitPriceCents: 12000 }),
        server({
          productId: CONCHA,
          slug: "concha",
          name: "Concha",
          unitPriceCents: 2500,
          canAdd: false,
          soldOut: true,
        }),
      ],
    );
    expect(r.lines.map((l) => l.productId)).toEqual([CROISSANT]);
    expect(r.changes.map((c) => c.kind)).toEqual(["precio_subio", "agotado"]);
  });

  it("el servidor manda también en nombre, foto y categoría: se refrescan sin generar aviso", () => {
    const r = reconcileCart(
      [line({ name: "Croissant viejo", imageUrl: null, categorySlug: null, slug: "viejo" })],
      [
        server({
          name: "Croissant Dubai",
          imageUrl: "/img/croissant.webp",
          categorySlug: "panaderia",
        }),
      ],
    );
    expect(r.changes).toEqual([]);
    expect(r.lines[0]).toMatchObject({
      name: "Croissant Dubai",
      imageUrl: "/img/croissant.webp",
      categorySlug: "panaderia",
      slug: "croissant-dubai",
    });
  });

  it("productos repetidos en la respuesta: se usa el primero y no se duplica la línea", () => {
    const r = reconcileCart([line()], [server(), server({ unitPriceCents: 999 })]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.unitPriceCents).toBe(11500);
  });
});
