/**
 * Integración: webhook de Instagram contra Postgres (base `${DATABASE_URL_TEST}_web`).
 * `sendInstagramMessage` se mockea (no se llama a Meta). Verifica challenge, firma, idempotencia por mid,
 * conversación/mensajes, respuesta automática (flag instagram_bot) y lead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, sql, type Database } from "@pdp/db";
import { signMetaPayload } from "@pdp/integrations";
import { webTestDatabaseUrl } from "./db-url.ts";

const APP_SECRET = "meta-app-secret-de-prueba";
const VERIFY_TOKEN = "verify-token-de-prueba";
const send = vi.fn<(i: { recipientId: string; text: string }) => Promise<{ messageId: string }>>();

vi.mock("@pdp/integrations", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@pdp/integrations")>();
  return { ...mod, sendInstagramMessage: (i: { recipientId: string; text: string }) => send(i) };
});

let db: Database;
let pool: { end: () => Promise<void> };
let POST: (req: Request) => Promise<Response>;
let GET: (req: Request) => Response;

beforeAll(async () => {
  process.env.DATABASE_URL = webTestDatabaseUrl();
  process.env.APP_ENV = "development";
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_VERIFY_TOKEN = VERIFY_TOKEN;
  process.env.NEXT_PUBLIC_SITE_URL = "https://elpandepaula.mx";
  delete process.env.ANTHROPIC_API_KEY;
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 }));
  ({ POST, GET } = await import("../app/api/webhooks/instagram/route"));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

beforeEach(async () => {
  send.mockReset();
  send.mockImplementation(async () => ({
    messageId: "out-" + Math.random().toString(36).slice(2),
  }));
  await sql`truncate table leads, instagram_messages, instagram_conversations, webhook_events, product_prices, products, audit_logs restart identity cascade`.execute(
    db,
  );
  await sql`update feature_flags set enabled = true where key = 'instagram_bot'`.execute(db);
  await sql`update feature_flags set enabled = false where key = 'instagram_ai_replies'`.execute(
    db,
  );
  const p = (
    await sql<{
      id: string;
    }>`insert into products(name, slug, track_stock) values ('Croissant Dubai', 'croissant-dubai', false) returning id`.execute(
      db,
    )
  ).rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents) values (${p}, 'all', 'regular', 9500)`.execute(
    db,
  );
});

function deliver(events: unknown[], opts: { secret?: string | null } = {}) {
  const raw = JSON.stringify({
    object: "instagram",
    entry: [{ id: "17841400000000000", time: Date.now(), messaging: events }],
  });
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.secret !== null)
    headers.set("x-hub-signature-256", signMetaPayload(raw, opts.secret ?? APP_SECRET));
  return new Request("https://elpandepaula.mx/api/webhooks/instagram", {
    method: "POST",
    headers,
    body: raw,
  });
}

const incoming = (mid: string, text: string, sender = "9001") => ({
  sender: { id: sender },
  recipient: { id: "17841400000000000" },
  timestamp: Date.now(),
  message: { mid, text },
});

describe("/api/webhooks/instagram", () => {
  it("GET: responde el challenge solo con el verify token correcto", () => {
    const ok = GET(
      new Request(
        `https://x.mx/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=424242`,
      ),
    );
    expect(ok.status).toBe(200);
    const bad = GET(
      new Request(
        "https://x.mx/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1",
      ),
    );
    expect(bad.status).toBe(403);
  });
  it("GET devuelve el challenge en texto plano", async () => {
    const ok = GET(
      new Request(
        `https://x.mx/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=424242`,
      ),
    );
    expect(await ok.text()).toBe("424242");
  });

  it("firma inválida o ausente → 401 sin registrar", async () => {
    expect((await POST(deliver([incoming("m1", "hola")], { secret: "otra" }))).status).toBe(401);
    expect((await POST(deliver([incoming("m1", "hola")], { secret: null }))).status).toBe(401);
    const n = await sql<{ n: number }>`select count(*)::int as n from webhook_events`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
  });

  it("mensaje entrante → conversación, mensaje, respuesta automática con precio real y lead; reentrega no duplica", async () => {
    const r = await POST(deliver([incoming("mid-100", "precio del croissant dubai")]));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      ok: true,
      received: 1,
      results: [{ status: "processed" }],
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0];
    expect(sent.recipientId).toBe("9001");
    expect(sent.text).toContain("$95");
    expect(sent.text).toContain(
      "https://elpandepaula.mx/producto/croissant-dubai?utm_source=instagram",
    );

    const r2 = await POST(deliver([incoming("mid-100", "precio del croissant dubai")]));
    expect(await r2.json()).toMatchObject({
      results: [{ status: "ignored", reason: "duplicate" }],
    });
    expect(send).toHaveBeenCalledTimes(1);

    const conv = await sql<{
      id: string;
      ig_user_id: string;
      last_intent: string;
      status: string;
    }>`select id, ig_user_id, last_intent, status from instagram_conversations`.execute(db);
    expect(conv.rows).toHaveLength(1);
    expect(conv.rows[0]).toMatchObject({
      ig_user_id: "9001",
      last_intent: "price",
      status: "open",
    });
    const msgs = await sql<{
      direction: string;
      auto_reply: boolean;
      intent: string | null;
      external_mid: string | null;
    }>`select direction, auto_reply, intent, external_mid from instagram_messages order by created_at`.execute(
      db,
    );
    expect(msgs.rows).toHaveLength(2);
    expect(msgs.rows[0]).toMatchObject({
      direction: "in",
      auto_reply: false,
      intent: "price",
      external_mid: "mid-100",
    });
    expect(msgs.rows[1]).toMatchObject({ direction: "out", auto_reply: true, intent: "price" });
    const leads = await sql<{
      source: string;
      handle: string;
      interest: string;
      link_sent: string;
      status: string;
      product_id: string | null;
    }>`select source, handle, interest, link_sent, status, product_id from leads`.execute(db);
    expect(leads.rows).toHaveLength(1);
    expect(leads.rows[0]).toMatchObject({
      source: "instagram",
      handle: "9001",
      interest: "Croissant Dubai",
      status: "new",
    });
    expect(leads.rows[0]!.product_id).toBeTruthy();
    expect(leads.rows[0]!.link_sent).toContain("/producto/croissant-dubai");
    const ev = await sql<{
      status: string;
      external_id: string;
      provider: string;
    }>`select status, external_id, provider from webhook_events`.execute(db);
    expect(ev.rows).toEqual([
      { status: "processed", external_id: "mid:mid-100", provider: "meta" },
    ]);
  });

  it("segundo mensaje del mismo usuario reutiliza conversación y lead", async () => {
    await POST(deliver([incoming("mid-201", "hola")]));
    await POST(deliver([incoming("mid-202", "hacen envíos?")]));
    const conv = await sql<{
      n: number;
    }>`select count(*)::int as n from instagram_conversations`.execute(db);
    expect(conv.rows[0]!.n).toBe(1);
    const leads = await sql<{ n: number }>`select count(*)::int as n from leads`.execute(db);
    expect(leads.rows[0]!.n).toBe(1);
    const msgs = await sql<{
      n: number;
    }>`select count(*)::int as n from instagram_messages`.execute(db);
    expect(msgs.rows[0]!.n).toBe(4);
  });

  it("flag instagram_bot apagado: guarda el mensaje y no responde", async () => {
    await sql`update feature_flags set enabled = false where key = 'instagram_bot'`.execute(db);
    const r = await POST(deliver([incoming("mid-300", "a qué hora abren")]));
    expect(await r.json()).toMatchObject({
      results: [{ status: "processed", reason: "bot desactivado" }],
    });
    expect(send).not.toHaveBeenCalled();
    const msgs = await sql<{
      n: number;
    }>`select count(*)::int as n from instagram_messages`.execute(db);
    expect(msgs.rows[0]!.n).toBe(1);
  });

  it("echo (mensaje enviado por la cuenta) se guarda como saliente sin responder; lecturas se ignoran", async () => {
    const r = await POST(
      deliver([
        {
          sender: { id: "17841400000000000" },
          recipient: { id: "9001" },
          timestamp: Date.now(),
          message: { mid: "echo-1", text: "Hola desde la app", is_echo: true },
        },
        {
          sender: { id: "9001" },
          recipient: { id: "17841400000000000" },
          timestamp: Date.now(),
          read: { mid: "echo-1" },
        },
      ]),
    );
    expect(await r.json()).toMatchObject({
      received: 2,
      results: [{ status: "processed" }, { status: "ignored", reason: "read" }],
    });
    expect(send).not.toHaveBeenCalled();
    const msgs = await sql<{
      direction: string;
      auto_reply: boolean;
    }>`select direction, auto_reply from instagram_messages`.execute(db);
    expect(msgs.rows).toEqual([{ direction: "out", auto_reply: false }]);
  });

  it("si el envío a Meta falla, el mensaje entrante queda guardado, el evento en failed y se responde 200", async () => {
    send.mockRejectedValueOnce(
      new Error("Instagram Send API HTTP 400: (#10) Outside allowed window"),
    );
    const r = await POST(deliver([incoming("mid-400", "precio del croissant dubai")]));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ results: [{ status: "failed" }] });
    const ev = await sql<{
      status: string;
      last_error: string;
    }>`select status, last_error from webhook_events`.execute(db);
    expect(ev.rows[0]!.status).toBe("failed");
    expect(ev.rows[0]!.last_error).toContain("Outside allowed window");
    const msgs = await sql<{ direction: string }>`select direction from instagram_messages`.execute(
      db,
    );
    expect(msgs.rows).toEqual([{ direction: "in" }]);
    // Reentrega de Meta reprocesa un evento failed (y ahora sí responde)
    const r2 = await POST(deliver([incoming("mid-400", "precio del croissant dubai")]));
    expect(await r2.json()).toMatchObject({ results: [{ status: "processed" }] });
    expect(send).toHaveBeenCalledTimes(2);
    const msgs2 = await sql<{
      n: number;
    }>`select count(*)::int as n from instagram_messages`.execute(db);
    expect(msgs2.rows[0]!.n).toBe(2);
  });
});
