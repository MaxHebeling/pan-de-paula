import { describe, expect, it } from "vitest";
import { dbErrorMessage } from "../src/index.ts";

describe("dbErrorMessage (regresión auditoría 360°: mensajes crudos de Postgres al usuario)", () => {
  it("conserva los mensajes de negocio lanzados por nuestras funciones", () => {
    expect(dbErrorMessage({ code: "P0001", message: "Pedido cancelado" }).message).toBe(
      "Pedido cancelado",
    );
    expect(
      dbErrorMessage({ code: "23514", message: 'Stock insuficiente para "Pan"' }).message,
    ).toContain("Stock insuficiente");
    expect(dbErrorMessage({ code: "23505", message: "Ya hay una caja abierta" }).message).toBe(
      "Ya hay una caja abierta",
    );
  });
  it("oculta el detalle de violaciones nativas y errores internos", () => {
    const native = dbErrorMessage({
      code: "23505",
      message: 'duplicate key value violates unique constraint "products_slug_key"',
      constraint: "products_slug_key",
      table: "products",
    });
    expect(native.message).toBe("Ya existe un registro con esos datos");
    expect(
      dbErrorMessage({ code: "22P02", message: 'invalid input syntax for type uuid: "x"' }).message,
    ).not.toMatch(/uuid|syntax/);
    expect(
      dbErrorMessage({ code: "42703", message: 'column "foo" does not exist' }).message,
    ).not.toMatch(/column|foo/);
    expect(
      dbErrorMessage({
        code: "23514",
        message: 'new row for relation "orders" violates check constraint "orders_total_chk"',
        constraint: "orders_total_chk",
        table: "orders",
      }).message,
    ).not.toMatch(/orders/);
  });
});
