/**
 * Avisos al cliente (migración 0046) contra Postgres real.
 *
 * Lo importante no es que se cree el aviso, sino que se cree UNA sola vez y por el camino de siempre:
 * cuelgan de `order_status_history`, que ya escriben create_order, change_order_status y la anulación
 * de ventas. Si mañana aparece otra forma de mover un pedido, el aviso sale igual sin tocar nada.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  createCustomer,
  sql,
  callFn,
  withStaff,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let pan: string;
let ana: { customer_id: string };
let beto: { customer_id: string };

const crearPedido = (customerId: string | null, key: string) =>
  callFn<string>(db, "create_order", [
    JSON.stringify({
      channel: "web",
      customer_id: customerId,
      customer_name: "Quien sea",
      customer_phone: "6640000000",
      items: [{ product_id: pan, qty: 2 }],
      idempotency_key: key,
    }),
  ]);

const mover = (orderId: string, to: string, note?: string) =>
  withStaff(db, staff, (trx) => callFn(trx, "change_order_status", [orderId, to, note ?? null]));

const avisos = (customerId: string) =>
  sql<{ kind: string; title: string; body: string; read_at: Date | null; order_id: string }>`
    select kind, title, body, read_at, order_id::text as order_id
      from customer_notifications where customer_id = ${customerId}
     order by created_at, kind`
    .execute(db)
    .then((r) => r.rows);

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  pan = await createProduct(db, "Concha", 2500);
  ana = await createCustomer(db, "Ana López", "6641230001", "ana@correo.com");
  beto = await createCustomer(db, "Beto Ruiz", "6641230002", "beto@correo.com");
});

afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("avisos del cliente", () => {
  it("cada cambio de estado que le importa al cliente genera su aviso, con el texto centralizado", async () => {
    const o = await crearPedido(ana.customer_id, "n1");
    expect(await avisos(ana.customer_id)).toEqual([]); // 'new' no se anuncia: aún no hay nada que contar

    await mover(o, "confirmed");
    await mover(o, "in_production");
    await mover(o, "ready_for_pickup");

    const lista = await avisos(ana.customer_id);
    expect(lista.map((a) => a.kind)).toEqual(["confirmed", "in_production", "ready_for_pickup"]);
    expect(lista[1]!.title).toBe("Tu pedido está en preparación 🥐");
    expect(lista[2]!.title).toBe("¡Tu pedido está listo! 🎉");
    // El folio va en el cuerpo para que el aviso se entienda solo.
    const folio = (
      await sql<{ folio: string }>`select folio from orders where id = ${o}`.execute(db)
    ).rows[0]!.folio;
    for (const a of lista) expect(a.body).toContain(folio);
    for (const a of lista) expect(a.read_at).toBeNull();
  });

  it("una misma transición no avisa dos veces, aunque se repita la operación", async () => {
    const o = await crearPedido(ana.customer_id, "n2");
    await mover(o, "confirmed");
    // Ir y volver: son DOS transiciones distintas, cada una con su propio renglón de historial.
    await mover(o, "in_production");
    await mover(o, "ready");
    const antes = await avisos(ana.customer_id);

    // El mismo renglón de historial no puede generar otro aviso ni forzándolo.
    const h = await sql<{ id: string }>`
      select id::text as id from order_status_history where order_id = ${o} order by id desc limit 1`.execute(
      db,
    );
    await expect(
      sql`insert into customer_notifications(customer_id, order_id, status_history_id, kind, title)
          values (${ana.customer_id}, ${o}, ${h.rows[0]!.id}::bigint, 'ready', 'Duplicado')`.execute(
        db,
      ),
    ).rejects.toThrow();
    expect(await avisos(ana.customer_id)).toEqual(antes);
  });

  it("un pedido sin cliente identificado no genera avisos para nadie", async () => {
    const o = await crearPedido(null, "n3");
    await mover(o, "confirmed");
    await mover(o, "in_production");
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from customer_notifications`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
  });

  it("los avisos de un cliente no llegan al otro", async () => {
    const oa = await crearPedido(ana.customer_id, "n4a");
    const ob = await crearPedido(beto.customer_id, "n4b");
    await mover(oa, "confirmed");
    await mover(ob, "confirmed");
    await mover(ob, "in_production");

    expect(await avisos(ana.customer_id)).toHaveLength(1);
    expect(await avisos(beto.customer_id)).toHaveLength(2);
    const cruzados = await sql<{ n: number }>`
      select count(*)::int as n from customer_notifications n
       join orders o on o.id = n.order_id
      where n.customer_id <> o.customer_id`.execute(db);
    expect(cruzados.rows[0]!.n).toBe(0);
  });

  it("cancelar avisa, y el historial completo se conserva", async () => {
    const o = await crearPedido(ana.customer_id, "n5");
    await mover(o, "confirmed");
    await mover(o, "cancelled", "Se arrepintió");
    const lista = await avisos(ana.customer_id);
    expect(lista.map((a) => a.kind)).toEqual(["confirmed", "cancelled"]);
    // El historial guarda los dos cambios; no se sobrescribe el anterior.
    const h = await sql<{ to_status: string }>`
      select to_status from order_status_history where order_id = ${o} order by id`.execute(db);
    expect(h.rows.map((x) => x.to_status)).toEqual(["new", "confirmed", "cancelled"]);
    // La nota interna del equipo NO viaja al aviso del cliente.
    for (const a of lista) expect(a.body ?? "").not.toContain("Se arrepintió");
  });

  it("un cambio con fecha vieja (importación histórica) no dispara avisos de hoy", async () => {
    const o = await crearPedido(ana.customer_id, "n6");
    await sql`insert into order_status_history(order_id, from_status, to_status, created_at)
              values (${o}, 'new', 'confirmed', now() - interval '2 days')`.execute(db);
    expect(await avisos(ana.customer_id)).toEqual([]);
  });

  it("marcar como leído no borra el aviso, solo lo marca", async () => {
    const o = await crearPedido(ana.customer_id, "n7");
    await mover(o, "confirmed");
    await sql`update customer_notifications set read_at = now() where customer_id = ${ana.customer_id}`.execute(
      db,
    );
    const lista = await avisos(ana.customer_id);
    expect(lista).toHaveLength(1);
    expect(lista[0]!.read_at).not.toBeNull();
  });
});
