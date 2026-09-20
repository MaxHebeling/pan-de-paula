/**
 * Entrega de avisos por push.
 *
 * Lo que importa no es que se llame a la librería, sino las garantías alrededor: que un aviso no se
 * mande dos veces, que un dispositivo muerto se desactive en vez de reintentarse para siempre, que
 * se respete lo que el cliente pidió recibir y que un aviso viejo no despierte a nadie.
 *
 * `web-push` se simula: mandar de verdad exigiría un servicio de push real y no probaría nada nuestro.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enviados: Array<{ endpoint: string; payload: string }> = [];
let siguienteError: { statusCode: number } | null = null;

vi.mock("web-push", () => {
  class WebPushError extends Error {
    statusCode: number;
    constructor(statusCode: number) {
      super(`push ${statusCode}`);
      this.statusCode = statusCode;
    }
  }
  return {
    default: {
      setVapidDetails: vi.fn(),
      generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
      sendNotification: vi.fn(async (sub: { endpoint: string }, payload: string) => {
        if (siguienteError) {
          const e = new WebPushError(siguienteError.statusCode);
          siguienteError = null;
          throw e;
        }
        enviados.push({ endpoint: sub.endpoint, payload });
      }),
    },
    WebPushError,
  };
});

const { createDb, sql } = await import("@pdp/db");
const { deliverPendingPushes, saveSubscription, isPushConfigured } = await import("../src/push.ts");
const { integrationsTestDatabaseUrl } = await import("./db-url.ts");

const { db, pool } = createDb({
  connectionString: integrationsTestDatabaseUrl(),
  ssl: false,
  max: 2,
});

let customer: string;
let order: string;

/** Aviso ya creado, como lo deja el disparador de 0046. */
async function avisoPendiente(titulo: string, creadoHace = "1 minute") {
  const r = await sql<{ id: string }>`
    insert into customer_notifications(customer_id, order_id, kind, title, body, created_at)
    values (${customer}, ${order}, 'ready', ${titulo}, 'cuerpo', now() - ${creadoHace}::interval)
    returning id`.execute(db);
  return r.rows[0]!.id;
}

const vivas = () =>
  sql<{ n: number }>`select count(*)::int as n from push_subscriptions
                      where customer_id = ${customer} and disabled_at is null`
    .execute(db)
    .then((r) => r.rows[0]!.n);

beforeEach(async () => {
  enviados.length = 0;
  siguienteError = null;
  process.env.VAPID_PUBLIC_KEY = "pub";
  process.env.VAPID_PRIVATE_KEY = "priv";
  await sql`truncate table customer_notifications, push_subscriptions, customer_notification_prefs,
            order_status_history, order_items, orders, customers restart identity cascade`.execute(
    db,
  );
  const c = await sql<{ r: { customer_id: string } }>`
    select register_customer('{"full_name":"Ana Push","phone":"6641230001","email":"anapush@x.com","birthday":"1990-01-01"}'::jsonb) as r`.execute(
    db,
  );
  customer = c.rows[0]!.r.customer_id;
  const o = await sql<{ id: string }>`
    insert into orders(channel, customer_id, customer_name, subtotal_cents, total_cents)
    values ('web', ${customer}, 'Ana Push', 1000, 1000) returning id`.execute(db);
  order = o.rows[0]!.id;
  await saveSubscription(db, {
    customerId: customer,
    endpoint: "https://push.test/uno",
    p256dh: "clave-publica-larga",
    auth: "secreto-de-auth-largo",
  });
});

afterEach(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe("entrega de push", () => {
  it("manda el aviso una sola vez, aunque se llame dos veces", async () => {
    await avisoPendiente("Tu pedido está listo");
    const primera = await deliverPendingPushes(db, {});
    expect(primera).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(enviados).toHaveLength(1);
    expect(JSON.parse(enviados[0]!.payload)).toMatchObject({
      title: "Tu pedido está listo",
      url: expect.stringContaining("/portal/pedidos/"),
    });

    const segunda = await deliverPendingPushes(db, {});
    expect(segunda.claimed).toBe(0);
    expect(enviados).toHaveLength(1); // ni uno más
  });

  it("llega a TODOS los dispositivos del cliente", async () => {
    await saveSubscription(db, {
      customerId: customer,
      endpoint: "https://push.test/dos",
      p256dh: "otra-clave-publica",
      auth: "otro-secreto-de-auth",
    });
    await avisoPendiente("Listo");
    await deliverPendingPushes(db, {});
    expect(enviados.map((e) => e.endpoint).sort()).toEqual([
      "https://push.test/dos",
      "https://push.test/uno",
    ]);
  });

  it("re-suscribirse en el mismo navegador actualiza, no duplica", async () => {
    await saveSubscription(db, {
      customerId: customer,
      endpoint: "https://push.test/uno",
      p256dh: "clave-nueva-larga",
      auth: "auth-nuevo-largo",
    });
    expect(await vivas()).toBe(1);
  });

  it("un dispositivo que ya no existe (410) se desactiva en vez de reintentarse", async () => {
    siguienteError = { statusCode: 410 };
    await avisoPendiente("Listo");
    const r = await deliverPendingPushes(db, {});
    expect(r).toMatchObject({ claimed: 1, sent: 0, failed: 1, disabled: 1 });
    expect(await vivas()).toBe(0);
    // Y queda escrito por qué no salió, sin guardar el endpoint ni las claves.
    const n = await sql<{ push_error: string }>`
      select push_error from customer_notifications limit 1`.execute(db);
    expect(n.rows[0]!.push_error).toContain("push_410");
    expect(n.rows[0]!.push_error).not.toContain("push.test");
  });

  it("si el cliente apagó los avisos de pedidos, no se le manda nada", async () => {
    await sql`insert into customer_notification_prefs(customer_id, order_updates)
              values (${customer}, false)`.execute(db);
    await avisoPendiente("Listo");
    const r = await deliverPendingPushes(db, {});
    expect(r.claimed).toBe(0);
    expect(enviados).toHaveLength(0);
  });

  it("un aviso viejo no despierta a nadie", async () => {
    await avisoPendiente("De ayer", "26 hours");
    const r = await deliverPendingPushes(db, {});
    expect(r.claimed).toBe(0);
  });

  it("sin claves VAPID no se intenta nada (el portal sigue funcionando igual)", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    expect(isPushConfigured()).toBe(false);
    await avisoPendiente("Listo");
    const r = await deliverPendingPushes(db, {});
    expect(r).toMatchObject({ claimed: 0, sent: 0 });
    expect(enviados).toHaveLength(0);
  });

  it("acotar por pedido solo entrega los de ese pedido", async () => {
    const otra = await sql<{ id: string }>`
      insert into orders(channel, customer_id, customer_name, subtotal_cents, total_cents)
      values ('web', ${customer}, 'Ana Push', 500, 500) returning id`.execute(db);
    await avisoPendiente("Del primero");
    await sql`insert into customer_notifications(customer_id, order_id, kind, title)
              values (${customer}, ${otra.rows[0]!.id}, 'ready', 'Del segundo')`.execute(db);
    const r = await deliverPendingPushes(db, { orderId: order });
    expect(r.claimed).toBe(1);
    expect(JSON.parse(enviados[0]!.payload).title).toBe("Del primero");
  });
});

afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});
