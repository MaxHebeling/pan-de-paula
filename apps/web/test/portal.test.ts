/**
 * Portal del cliente contra Postgres real (base `${DATABASE_URL_TEST}_web`).
 *
 * Cubre lo que no se ve en el navegador:
 *  - la solicitud de enlace responde IGUAL exista o no la cuenta, y solo crea token si existe;
 *  - el canje es de un solo uso, respeta la caducidad y abre sesión en cookie httpOnly;
 *  - `resolveCustomerSession` acepta solo sesiones vivas (no caducadas, no revocadas);
 *  - sin sesión, las páginas del portal redirigen a /portal/entrar;
 *  - TODAS las consultas del portal filtran por el cliente de la sesión: con el folio de otro
 *    cliente no se devuelve nada.
 *
 * `next/headers` se simula (IP para el rate limit + tarro de cookies en memoria).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, sql, type Database } from "@pdp/db";
import { webTestDatabaseUrl } from "./db-url.ts";

let ip = "203.0.113.70";

/** Tarro de cookies en memoria con la superficie que usa el portal. */
const jar = new Map<string, { value: string; options: Record<string, unknown> }>();
const cookieStore = {
  get: (name: string) => {
    const c = jar.get(name);
    return c ? { name, value: c.value } : undefined;
  },
  set: (name: string, value: string, options: Record<string, unknown> = {}) => {
    jar.set(name, { value, options });
  },
  delete: (name: string) => {
    jar.delete(name);
  },
};

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": ip, "user-agent": "vitest" }),
  cookies: async () => cookieStore,
}));

type EntrarActions = typeof import("../app/portal/entrar/actions");
type AccesoActions = typeof import("../app/portal/acceso/actions");
type SesionActions = typeof import("../app/portal/(sesion)/actions");
type PortalSession = typeof import("../lib/portal/session");
type PortalData = typeof import("../lib/portal/data");

let requestPortalLinkAction: EntrarActions["requestPortalLinkAction"];
let redeemAccessTokenAction: AccesoActions["redeemAccessTokenAction"];
let portalLogoutAction: SesionActions["portalLogoutAction"];
let getCustomerSession: PortalSession["getCustomerSession"];
let requireCustomerSession: PortalSession["requireCustomerSession"];
let CUSTOMER_SESSION_COOKIE: PortalSession["CUSTOMER_SESSION_COOKIE"];
let getPortalCustomer: PortalData["getPortalCustomer"];
let listPortalPurchases: PortalData["listPortalPurchases"];
let getPortalPurchase: PortalData["getPortalPurchase"];
let listPortalPointsMovements: PortalData["listPortalPointsMovements"];

let db: Database;
let pool: { end: () => Promise<void> };
let staff: string;
let croissant: string;

/** redirect() de Next lanza un error con digest "NEXT_REDIRECT;…;/ruta;…". */
async function redirectOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw e;
    return digest.split(";")[2] ?? "";
  }
}

const form = (f: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(f)) fd.set(k, v);
  return fd;
};

async function register(p: Record<string, unknown>) {
  const r = await sql<{
    r: { customer_id: string; public_code: string; qr_token: string };
  }>`select register_customer(${JSON.stringify(p)}::jsonb) as r`.execute(db);
  return r.rows[0]!.r;
}

/** Venta de mostrador para un cliente (misma función SQL que usa el POS de verdad). */
async function sell(customerId: string, qty: number, amountCents: number) {
  const r = await sql<{ r: { folio: string } }>`
    select pos_checkout(${JSON.stringify({
      customer_id: customerId,
      items: [{ product_id: croissant, qty }],
      payments: [{ provider: "cash", method: "cash", amount_cents: amountCents }],
    })}::jsonb) as r`.execute(db);
  return r.rows[0]!.r.folio;
}

/** El último token de acceso emitido, tal como lo canjearía el cliente desde el enlace. */
async function issuedTokenHashes(customerId: string) {
  const r = await sql<{ token_hash: string; used_at: Date | null }>`
    select token_hash, used_at from customer_access_tokens
     where customer_id = ${customerId} order by created_at`.execute(db);
  return r.rows;
}

/** Inserta un token conocido (el token en claro no se puede leer de la base: solo vive en el enlace). */
async function plantToken(customerId: string, token: string, expiresIn = "1 hour") {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`insert into customer_access_tokens(customer_id, token_hash, expires_at)
            values (${customerId}, ${hash}, now() + ${expiresIn}::interval)`.execute(db);
  return token;
}

beforeAll(async () => {
  process.env.DATABASE_URL = webTestDatabaseUrl();
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3114";
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 }));
  ({ requestPortalLinkAction } = await import("../app/portal/entrar/actions"));
  ({ redeemAccessTokenAction } = await import("../app/portal/acceso/actions"));
  ({ portalLogoutAction } = await import("../app/portal/(sesion)/actions"));
  ({ getCustomerSession, requireCustomerSession, CUSTOMER_SESSION_COOKIE } =
    await import("../lib/portal/session"));
  ({ getPortalCustomer, listPortalPurchases, getPortalPurchase, listPortalPointsMovements } =
    await import("../lib/portal/data"));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const s = await sql<{
    id: string;
  }>`insert into staff_users(email, full_name, password_hash, role_key) values ('portal@pdp.local', 'Portal', 'x', 'owner') returning id`.execute(
    db,
  );
  staff = s.rows[0]!.id;
  const p = await sql<{
    id: string;
  }>`insert into products(name, slug, track_stock) values ('Croissant Portal', 'croissant-portal', true) returning id`.execute(
    db,
  );
  croissant = p.rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents) values (${croissant}, 'all', 'regular', 4500)`.execute(
    db,
  );
  await sql`select set_config('app.staff_id', ${staff}, false)`.execute(db);
  await sql`update feature_flags set enabled = true where key = 'loyalty'`.execute(db);
  await sql`update business_settings set allow_negative_stock = true`.execute(db);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await pool.end().catch(() => {});
});

beforeEach(async () => {
  jar.clear();
  ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  await sql`truncate table customer_sessions, customer_access_tokens, loyalty_transactions,
                           payments, sales, order_items, order_status_history, orders,
                           customer_events, customers, rate_limits, domain_events, audit_logs
            restart identity cascade`.execute(db);
  await sql`select set_config('app.staff_id', ${staff}, false)`.execute(db);
});

describe("/portal/entrar · solicitud del enlace", () => {
  it("correo vacío o mal escrito se rechaza con un mensaje claro y sin tocar la base", async () => {
    expect(await requestPortalLinkAction(null, form({ email: "" }))).toMatchObject({
      error: expect.stringMatching(/obligatorio/i),
    });
    expect(await requestPortalLinkAction(null, form({ email: "ana@" }))).toMatchObject({
      error: expect.stringMatching(/no parece válido/i),
    });
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from customer_access_tokens`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
  });

  it("responde EXACTAMENTE igual exista o no la cuenta, pero solo emite token si existe", async () => {
    const c = await register({ full_name: "Ana López", email: "ana@example.com" });

    const conCuenta = await requestPortalLinkAction(null, form({ email: "Ana@Example.com" }));
    const sinCuenta = await requestPortalLinkAction(null, form({ email: "nadie@example.com" }));
    expect(conCuenta).toEqual({ sent: true, email: "ana@example.com" });
    expect(sinCuenta).toEqual({ sent: true, email: "nadie@example.com" });
    // Ninguna respuesta lleva el token ni pista alguna de la cuenta.
    expect(JSON.stringify(conCuenta)).not.toMatch(/token|qr|PDP-/i);

    const tokens = await issuedTokenHashes(c.customer_id);
    expect(tokens).toHaveLength(1);
    const total = await sql<{
      n: number;
    }>`select count(*)::int as n from customer_access_tokens`.execute(db);
    expect(total.rows[0]!.n).toBe(1);
  });

  it("emitir un enlace nuevo invalida el anterior (solo sirve el último)", async () => {
    const c = await register({ full_name: "Ana López", email: "ana@example.com" });
    await requestPortalLinkAction(null, form({ email: "ana@example.com" }));
    await requestPortalLinkAction(null, form({ email: "ana@example.com" }));
    const tokens = await issuedTokenHashes(c.customer_id);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.used_at).not.toBeNull(); // el primero quedó quemado
    expect(tokens[1]!.used_at).toBeNull();
  });

  it("queda rastro en audit_logs de cada enlace generado (y no del intento sin cuenta)", async () => {
    const c = await register({ full_name: "Ana López", email: "ana@example.com" });
    await requestPortalLinkAction(null, form({ email: "ana@example.com" }));
    await requestPortalLinkAction(null, form({ email: "nadie@example.com" }));
    const logs = await sql<{ entity_id: string }>`
      select entity_id from audit_logs where action = 'CUSTOMER_ACCESS_LINK'`.execute(db);
    expect(logs.rows.map((r) => r.entity_id)).toEqual([c.customer_id]);
  });

  it("rate limit: la 9.ª solicitud desde la misma IP se rechaza", async () => {
    ip = "198.51.100.77";
    await register({ full_name: "Ana López", email: "ana@example.com" });
    for (let i = 0; i < 8; i++) {
      expect(await requestPortalLinkAction(null, form({ email: "ana@example.com" }))).toMatchObject(
        { sent: true },
      );
    }
    expect(await requestPortalLinkAction(null, form({ email: "ana@example.com" }))).toMatchObject({
      error: expect.stringMatching(/demasiados intentos/i),
    });
  });
});

describe("/portal/acceso · canje del enlace", () => {
  it("abre sesión en cookie httpOnly y el token queda quemado", async () => {
    const c = await register({ full_name: "Ana López", email: "ana@example.com" });
    const token = await plantToken(c.customer_id, "token-de-acceso-valido-1234567890");

    const to = await redirectOf(redeemAccessTokenAction(form({ t: token })));
    expect(to).toBe("/portal?bienvenida=1");

    const cookie = jar.get(CUSTOMER_SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie!.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(cookie!.value).not.toBe(token);

    // La sesión resuelve al cliente correcto y en la base solo vive el hash.
    const session = await getCustomerSession();
    expect(session?.customer.id).toBe(c.customer_id);
    const stored = await sql<{
      token_hash: string;
    }>`select token_hash from customer_sessions`.execute(db);
    expect(stored.rows[0]!.token_hash).not.toBe(cookie!.value);

    // Segundo canje del MISMO enlace: rebota.
    jar.clear();
    expect(await redirectOf(redeemAccessTokenAction(form({ t: token })))).toBe(
      "/portal/entrar?expirado=1",
    );
    expect(jar.get(CUSTOMER_SESSION_COOKIE)).toBeUndefined();
  });

  it("token caducado, inventado o vacío no abre sesión", async () => {
    const c = await register({ full_name: "Ana López", email: "ana@example.com" });
    await plantToken(c.customer_id, "token-caducado-1234567890123", "-1 minute");
    for (const t of ["token-caducado-1234567890123", "token-inventado-0000000000000", "", "x"]) {
      jar.clear();
      expect(await redirectOf(redeemAccessTokenAction(form({ t }))), t).toBe(
        "/portal/entrar?expirado=1",
      );
      expect(jar.get(CUSTOMER_SESSION_COOKIE), t).toBeUndefined();
    }
    const n = await sql<{ n: number }>`select count(*)::int as n from customer_sessions`.execute(
      db,
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it("el enlace de un cliente eliminado no abre sesión", async () => {
    const c = await register({ full_name: "Ana López", email: "ana@example.com" });
    const token = await plantToken(c.customer_id, "token-de-cliente-borrado-12345");
    await sql`update customers set deleted_at = now() where id = ${c.customer_id}`.execute(db);
    expect(await redirectOf(redeemAccessTokenAction(form({ t: token })))).toBe(
      "/portal/entrar?expirado=1",
    );
  });
});

describe("sesión del portal", () => {
  async function login(email: string) {
    const c = await register({ full_name: "Ana López", email });
    const token = await plantToken(c.customer_id, `token-${email.replace(/\W/g, "")}-0123456789`);
    await redirectOf(redeemAccessTokenAction(form({ t: token })));
    return c;
  }

  it("sin cookie no hay sesión y requireCustomerSession manda a /portal/entrar", async () => {
    jar.clear();
    expect(await getCustomerSession()).toBeNull();
    expect(await redirectOf(requireCustomerSession())).toBe("/portal/entrar");
  });

  it("una cookie inventada o recortada tampoco vale", async () => {
    for (const fake of ["x", "no-es-un-token-pero-es-largo-000", "a".repeat(64)]) {
      jar.clear();
      cookieStore.set(CUSTOMER_SESSION_COOKIE, fake);
      expect(await getCustomerSession(), fake).toBeNull();
    }
  });

  it("una sesión caducada o revocada deja de valer", async () => {
    await login("ana@example.com");
    expect(await getCustomerSession()).not.toBeNull();
    await sql`update customer_sessions set expires_at = now() - interval '1 second'`.execute(db);
    expect(await getCustomerSession()).toBeNull();
    await sql`update customer_sessions set expires_at = now() + interval '30 days', revoked_at = now()`.execute(
      db,
    );
    expect(await getCustomerSession()).toBeNull();
  });

  it("cerrar sesión revoca el token en la base y borra la cookie", async () => {
    await login("ana@example.com");
    const to = await redirectOf(portalLogoutAction());
    expect(to).toBe("/portal/entrar?salir=1");
    expect(jar.get(CUSTOMER_SESSION_COOKIE)).toBeUndefined();
    const revoked = await sql<{
      n: number;
    }>`select count(*)::int as n from customer_sessions where revoked_at is not null`.execute(db);
    expect(revoked.rows[0]!.n).toBe(1);
    const logs = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_logs where action = 'CUSTOMER_LOGOUT'`.execute(db);
    expect(logs.rows[0]!.n).toBe(1);
  });

  it("el inicio de sesión deja rastro en audit_logs y domain_events", async () => {
    const c = await login("ana@example.com");
    const a = await sql<{
      entity_id: string;
    }>`select entity_id from audit_logs where action = 'CUSTOMER_LOGIN'`.execute(db);
    expect(a.rows.map((r) => r.entity_id)).toEqual([c.customer_id]);
    const e = await sql<{
      aggregate_id: string;
    }>`select aggregate_id from domain_events where event_type = 'CUSTOMER_PORTAL_LOGIN'`.execute(
      db,
    );
    expect(e.rows.map((r) => r.aggregate_id)).toEqual([c.customer_id]);
  });
});

describe("consultas del portal · aislamiento por cliente", () => {
  let ana: { customer_id: string; qr_token: string; public_code: string };
  let beto: { customer_id: string; qr_token: string; public_code: string };
  let folioAna: string;
  let folioBeto: string;

  beforeEach(async () => {
    ana = await register({ full_name: "Ana López", email: "ana@example.com" });
    beto = await register({ full_name: "Beto Ruiz", email: "beto@example.com" });
    folioAna = await sell(ana.customer_id, 2, 9000);
    folioBeto = await sell(beto.customer_id, 1, 4500);
  });

  it("cada quien ve solo sus compras", async () => {
    const deAna = await listPortalPurchases(ana.customer_id);
    const deBeto = await listPortalPurchases(beto.customer_id);
    expect(deAna.map((p) => p.folio)).toEqual([folioAna]);
    expect(deBeto.map((p) => p.folio)).toEqual([folioBeto]);
    expect(deAna[0]!.pointsEarned).toBe(9);
    expect(deAna[0]!.totalCents).toBe(9000);
    expect(deAna[0]!.summary).toContain("Croissant Portal");
  });

  it("el detalle con el folio de OTRO cliente devuelve null (la página responde 404)", async () => {
    expect(await getPortalPurchase(ana.customer_id, folioAna)).not.toBeNull();
    expect(await getPortalPurchase(ana.customer_id, folioBeto)).toBeNull();
    expect(await getPortalPurchase(beto.customer_id, folioAna)).toBeNull();
  });

  it("un folio con formato inválido no llega siquiera a consultar", async () => {
    for (const f of ["", "x", "PDP-1", "' or 1=1 --", folioAna.toLowerCase().replace("pdp", "xxx")])
      expect(await getPortalPurchase(ana.customer_id, f), f).toBeNull();
    // El folio en minúsculas sí es el suyo: se normaliza antes de consultar.
    expect(await getPortalPurchase(ana.customer_id, folioAna.toLowerCase())).not.toBeNull();
  });

  it("el detalle trae productos, cantidades, precios, totales, pago y puntos; nada interno", async () => {
    const d = (await getPortalPurchase(ana.customer_id, folioAna))!;
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({
      name: "Croissant Portal",
      qty: 2,
      unitPriceCents: 4500,
      totalCents: 9000,
    });
    expect(d.totalCents).toBe(9000);
    expect(d.payments).toEqual([{ method: "cash", amountCents: 9000 }]);
    expect(d.pointsEarned).toBe(9);
    // Ni ids internos ni costos ni notas internas salen de aquí.
    const serialized = JSON.stringify(d);
    expect(serialized).not.toMatch(/unit_cost|cost_cents|internal|order_id|sale_id/i);
    expect(serialized).not.toContain(ana.customer_id);
  });

  it("los movimientos de puntos son solo los del cliente y no exponen la nota del staff", async () => {
    await sql`select loyalty_post(${ana.customer_id}, 'adjust', 5, null, null, 'Ajuste manual: cliente enojado por la fila')`.execute(
      db,
    );
    const deAna = await listPortalPointsMovements(ana.customer_id);
    const deBeto = await listPortalPointsMovements(beto.customer_id);
    expect(deAna).toHaveLength(2);
    expect(deBeto).toHaveLength(1);
    expect(deAna[0]).toMatchObject({ kind: "adjust", points: 5, balanceAfter: 14 });
    expect(deAna[1]).toMatchObject({ kind: "earn", points: 9, folio: folioAna });
    expect(JSON.stringify(deAna)).not.toMatch(/enojado|Ajuste manual/);
  });

  it("la ficha del portal es la misma fila de customers que ve el CRM", async () => {
    const c = (await getPortalCustomer(ana.customer_id))!;
    expect(c).toMatchObject({
      publicCode: ana.public_code,
      qrToken: ana.qr_token, // el MISMO QR: no se genera otro token
      email: "ana@example.com",
      pointsBalance: 9,
      totalOrders: 1,
      totalSpentCents: 9000,
    });
  });

  it("consistencia: una venta nueva se refleja de inmediato en saldo, historial y nivel", async () => {
    const antes = (await getPortalCustomer(ana.customer_id))!;
    expect(antes.pointsBalance).toBe(9);
    expect(antes.tierKey).toBe("new");

    // 5 compras y $1,500 llevan al nivel "frequent" (loyalty_tiers de 0004).
    for (let i = 0; i < 5; i++) await sell(ana.customer_id, 10, 45000);

    const despues = (await getPortalCustomer(ana.customer_id))!;
    expect(despues.pointsBalance).toBe(9 + 5 * 45);
    expect(despues.totalOrders).toBe(6);
    expect(despues.tierKey).toBe("frequent"); // el nivel subió solo, sin trabajo manual
    const compras = await listPortalPurchases(ana.customer_id);
    expect(compras).toHaveLength(6);
    const movimientos = await listPortalPointsMovements(ana.customer_id);
    expect(movimientos).toHaveLength(6);
    expect(movimientos[0]!.balanceAfter).toBe(despues.pointsBalance);
  });

  it("una venta anulada aparece marcada, no desaparece", async () => {
    await sql`select void_sale(s.id, 'Prueba') from sales s join orders o on o.id = s.order_id where o.folio = ${folioAna}`.execute(
      db,
    );
    const compras = await listPortalPurchases(ana.customer_id);
    expect(compras).toHaveLength(1);
    expect(compras[0]!.voided).toBe(true);
    expect((await getPortalPurchase(ana.customer_id, folioAna))!.voided).toBe(true);
  });

  it("un cliente sin compras ve listas vacías, no errores", async () => {
    const solo = await register({ full_name: "Sola", email: "sola@example.com" });
    expect(await listPortalPurchases(solo.customer_id)).toEqual([]);
    expect(await listPortalPointsMovements(solo.customer_id)).toEqual([]);
    expect((await getPortalCustomer(solo.customer_id))!.pointsBalance).toBe(0);
  });
});
