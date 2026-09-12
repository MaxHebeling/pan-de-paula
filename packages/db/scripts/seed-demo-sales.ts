/**
 * Datos DEMO para desarrollo: clientes, producción, ventas (POS y web) repartidas en 60 días, mermas,
 * un turno de caja, un reembolso, conversaciones de Instagram y leads.
 * Idempotente: ventas con idempotency_key `demo-…`, clientes deduplicados por teléfono, marcas `demo` en notas.
 * Requiere el seed base (catálogo + admin). NUNCA corre con APP_ENV=production.
 * Uso: pnpm --filter @pdp/db exec tsx scripts/seed-demo-sales.ts
 */
import pg from "pg";
import { databaseUrl, sslConfig } from "./env.ts";

if (process.env.APP_ENV === "production") {
  console.error("seed-demo-sales no se ejecuta en producción");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl(), ssl: sslConfig() });
await client.connect();
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await client.query(text, params)).rows as T[];

// PRNG determinista (mulberry32) para que el demo sea reproducible
let seed = 20260901;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

const DAYS = 60;
const now = new Date();
const daysAgo = (d: number, hour = 10) => {
  const x = new Date(now);
  x.setDate(x.getDate() - d);
  x.setHours(hour, int(0, 59), 0, 0);
  return x;
};

const staff = await q<{ id: string }>(
  "select id from staff_users where deleted_at is null order by created_at limit 1",
);
if (!staff[0]) throw new Error("Falta el usuario admin: corre primero pnpm db:seed");
const staffId = staff[0].id;

const products = await q<{ id: string; name: string; price: number; track_stock: boolean }>(
  `select p.id, p.name, current_price_cents(p.id, 'pos') as price, p.track_stock
   from products p where p.deleted_at is null and p.is_active and current_price_cents(p.id,'pos') is not null
   order by p.sort_order, p.name`,
);
if (products.length === 0) throw new Error("Sin productos: corre primero pnpm db:seed");
const stocked = products.filter((p) => p.track_stock);

/** Ejecuta fn dentro de una transacción con identidad de staff. */
async function asStaff<T>(fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await client.query("select set_config('app.staff_id', $1, true)", [staffId]);
    const r = await fn();
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

// ── Clientes ──
const FIRST = [
  "Ana",
  "Luis",
  "María",
  "Jorge",
  "Sofía",
  "Carlos",
  "Valeria",
  "Diego",
  "Fernanda",
  "Andrés",
  "Paula",
  "Ricardo",
  "Daniela",
  "Miguel",
  "Camila",
  "Eduardo",
  "Regina",
  "Javier",
  "Lucía",
  "Héctor",
  "Mariana",
  "Alejandro",
  "Ximena",
  "Roberto",
  "Isabela",
  "Fernando",
  "Renata",
  "Óscar",
  "Julia",
  "Pablo",
  "Elena",
  "Sergio",
  "Natalia",
  "Raúl",
  "Carmen",
  "Iván",
  "Andrea",
  "Gerardo",
  "Alicia",
  "Tomás",
];
const LAST = [
  "López",
  "García",
  "Martínez",
  "Hernández",
  "Ruiz",
  "Torres",
  "Flores",
  "Ramírez",
  "Castro",
  "Vega",
];
const customers: Array<{ id: string; code: string }> = [];
for (let i = 0; i < 40; i++) {
  const name = `${FIRST[i]} ${pick(LAST)} ${pick(LAST)}`;
  const phone = `664${String(2000000 + i * 7919).padStart(7, "0")}`;
  const email =
    i % 3 === 0
      ? `${FIRST[i]!.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()}${i}@example.com`
      : undefined;
  // Cumpleaños: 3 hoy, 5 este mes, resto aleatorio
  const bd = new Date(now);
  if (i < 3) bd.setFullYear(1985 + i);
  else if (i < 8) {
    bd.setFullYear(1990 + i);
    bd.setDate(Math.min(28, 1 + ((i * 5) % 28)));
  } else {
    bd.setFullYear(1970 + int(0, 35));
    bd.setMonth(int(0, 11), int(1, 28));
  }
  const r = await asStaff(() =>
    q<{ r: { customer_id: string; public_code: string } }>("select register_customer($1) as r", [
      JSON.stringify({
        full_name: name,
        phone,
        email,
        birthday: bd.toISOString().slice(0, 10),
        marketing_consent: i % 2 === 0,
        source: pick(["pos", "qr", "web", "instagram"]),
      }),
    ]),
  );
  customers.push({ id: r[0]!.r.customer_id, code: r[0]!.r.public_code });
}
// Fechas de alta repartidas (para reportes de "nuevos" y aniversarios)
for (let i = 0; i < customers.length; i++) {
  await q(
    `update customers set created_at = least(created_at, $2) where id = $1 and notes is distinct from 'demo-dated'`,
    [customers[i]!.id, daysAgo(int(0, DAYS + 30), 9)],
  );
}
// Dos duplicados evidentes para probar la fusión
await asStaff(() =>
  q("select register_customer($1)", [
    JSON.stringify({ full_name: "Ana Lopez Garcia", phone: "6649990001", source: "instagram" }),
  ]),
);
await asStaff(() =>
  q("select register_customer($1)", [
    JSON.stringify({ full_name: "Ana López García", phone: "+526649990001", source: "pos" }),
  ]),
).catch(() =>
  asStaff(() =>
    q("select register_customer($1)", [
      JSON.stringify({ full_name: "Ana López García", phone: "6649990002", source: "pos" }),
    ]),
  ),
);
console.info(`Clientes: ${customers.length} (+2 duplicados demo)`);

// ── Producción repartida en 60 días ──
const hasProd = await q("select 1 from production_batches where notes = 'demo' limit 1");
if (hasProd.length === 0) {
  let n = 0;
  for (let d = DAYS; d >= 0; d--) {
    for (const p of stocked) {
      if (rnd() < 0.7) {
        await asStaff(() =>
          q("select record_production($1, $2, 'demo', false, $3)", [
            p.id,
            int(12, 40),
            daysAgo(d, 7),
          ]),
        );
        n++;
      }
    }
  }
  console.info(`Producción: ${n} lotes`);
}

// ── Ventas POS + web repartidas ──
const salesExisting = await q<{ n: number }>(
  "select count(*)::int as n from orders where idempotency_key like 'demo-sale-%'",
);
if (salesExisting[0]!.n === 0) {
  let n = 0;
  const frequent = customers.slice(0, 8); // compran cada semana
  for (let d = DAYS; d >= 0; d--) {
    const weekday = daysAgo(d).getDay();
    if (weekday === 0) continue; // domingo cerrado
    const count = weekday === 6 ? int(8, 14) : int(4, 10);
    for (let k = 0; k < count; k++) {
      const key = `demo-sale-${d}-${k}`;
      const isWeb = rnd() < 0.25;
      const items = Array.from({ length: int(1, 3) }, () => ({
        product_id: pick(products).id,
        qty: int(1, 4),
      }));
      let customer: string | null = null;
      if (rnd() < 0.6) {
        customer =
          k % 7 === 0 || (d % 7 === 0 && k < frequent.length)
            ? frequent[k % frequent.length]!.id
            : pick(customers).id;
      }
      // Los últimos 10 clientes no compran hace >30 días (para el filtro de inactivos)
      if (customer && customers.slice(30).some((c) => c.id === customer) && d < 35) customer = null;
      const total = await q<{ t: number }>(
        `select sum(current_price_cents(p.id, $2) * i.qty)::int as t
         from jsonb_to_recordset($1::jsonb) as i(product_id uuid, qty int) join products p on p.id = i.product_id`,
        [JSON.stringify(items), isWeb ? "web" : "pos"],
      );
      const amount = total[0]!.t;
      const method = isWeb
        ? { provider: "mercadopago", method: "mercadopago", external_id: `demo-mp-${key}` }
        : pick([
            { provider: "cash", method: "cash", tendered_cents: Math.ceil(amount / 5000) * 5000 },
            { provider: "cash", method: "cash", tendered_cents: amount },
            { provider: "manual", method: "card_terminal" },
            { provider: "manual", method: "transfer", reference: `TR-${key}` },
          ]);
      try {
        const res = await asStaff(() =>
          q<{ r: { order_id: string; sale_id: string } }>("select pos_checkout($1) as r", [
            JSON.stringify({
              idempotency_key: key,
              channel: isWeb ? "web" : "pos",
              fulfillment_type: isWeb ? "scheduled_pickup" : "pickup",
              customer_id: customer,
              items,
              payments: [{ ...method, amount_cents: amount }],
            }),
          ]),
        );
        const at = daysAgo(d, int(8, 17));
        const { order_id, sale_id } = res[0]!.r;
        await q("update sales set sold_at = $2 where id = $1", [sale_id, at]);
        await q(
          "update orders set placed_at = $2, paid_at = $2, completed_at = $2, created_at = $2 where id = $1",
          [order_id, at],
        );
        await q("update payments set confirmed_at = $2, created_at = $2 where order_id = $1", [
          order_id,
          at,
        ]);
        n++;
      } catch (e) {
        console.error(`Venta ${key} falló:`, (e as Error).message);
      }
    }
  }
  // Recalcular primera/última compra a partir de las ventas fechadas
  await q(`update customers c set first_purchase_at = s.f, last_purchase_at = s.l
           from (select customer_id, min(sold_at) f, max(sold_at) l from sales where voided_at is null and customer_id is not null group by customer_id) s
           where s.customer_id = c.id`);
  console.info(`Ventas: ${n}`);
}

// ── Mermas ──
const hasWaste = await q("select 1 from waste_records where note = 'demo' limit 1");
if (hasWaste.length === 0) {
  const reasons = ["burnt", "broken", "expired", "tasting", "gift", "courtesy", "error"];
  let n = 0;
  for (let d = DAYS; d >= 0; d -= int(1, 3)) {
    await asStaff(() =>
      q("select record_waste($1, $2, $3, 'demo', $4)", [
        pick(stocked).id,
        int(1, 5),
        pick(reasons),
        daysAgo(d, 18),
      ]),
    );
    n++;
  }
  console.info(`Mermas: ${n}`);
}

// ── Caja: un turno cerrado con diferencia + un reembolso ──
const hasDemoSession = await q("select 1 from register_sessions where notes = 'demo' limit 1");
const openSession = await q("select 1 from register_sessions where status = 'open'");
if (hasDemoSession.length === 0 && openSession.length === 0) {
  const sess = await asStaff(() => q<{ s: string }>("select open_register(50000, 'demo') as s"));
  const sid = sess[0]!.s;
  const p = stocked[0]!;
  const sale = await asStaff(() =>
    q<{ r: { order_id: string } }>("select pos_checkout($1) as r", [
      JSON.stringify({
        idempotency_key: "demo-register-1",
        register_session_id: sid,
        items: [{ product_id: p.id, qty: 2 }],
        payments: [
          {
            provider: "cash",
            method: "cash",
            amount_cents: p.price * 2,
            tendered_cents: p.price * 2,
          },
        ],
      }),
    ]),
  );
  const pay = await q<{ id: string }>("select id from payments where order_id = $1", [
    sale[0]!.r.order_id,
  ]);
  await asStaff(() =>
    q("select record_refund($1)", [
      JSON.stringify({
        payment_id: pay[0]!.id,
        amount_cents: p.price,
        reason: "Producto en mal estado (demo)",
        idempotency_key: "demo-refund-1",
      }),
    ]),
  );
  await asStaff(() =>
    q("select close_register($1, $2, 'demo')", [sid, 50000 + p.price * 2 - p.price - 2000]),
  );
  console.info("Caja: turno demo cerrado con reembolso y diferencia");
}

// ── Instagram: conversaciones, mensajes y leads ──
const IG = [
  {
    user: "demo-ig-1",
    handle: "sofi.bakes",
    intent: "precio",
    msgs: ["Hola! ¿cuánto cuesta el croissant Dubai?", "Y ¿hacen envíos a Playas?"],
  },
  {
    user: "demo-ig-2",
    handle: "luis_tj",
    intent: "pedido",
    msgs: ["Quiero 12 roles de canela para el sábado", "¿Se puede pagar con transferencia?"],
  },
  {
    user: "demo-ig-3",
    handle: "maru.gzz",
    intent: "horario",
    msgs: ["¿A qué hora abren los domingos?"],
  },
  {
    user: "demo-ig-4",
    handle: "eventos_bc",
    intent: "mayoreo",
    msgs: [
      "Buen día, necesito cotización para 200 piezas para un evento corporativo",
      "Fecha: 28 del próximo mes",
    ],
  },
  {
    user: "demo-ig-5",
    handle: "karla.ph",
    intent: "producto",
    msgs: ["¿Tienen opciones sin gluten?"],
  },
  {
    user: "demo-ig-6",
    handle: "dani_r",
    intent: "pedido",
    msgs: ["Me apartas una caja de 6 croissants para mañana por favor 🙏"],
  },
];
let igN = 0;
for (let i = 0; i < IG.length; i++) {
  const c = IG[i]!;
  const conv = await q<{ id: string }>(
    `insert into instagram_conversations(ig_user_id, ig_username, status, last_intent, last_message_at)
     values ($1, $2, $3, $4, $5) on conflict (ig_user_id) do nothing returning id`,
    [
      c.user,
      c.handle,
      i < 3 ? "open" : i === 3 ? "handled" : "converted",
      c.intent,
      daysAgo(i * 2, 12),
    ],
  );
  if (!conv[0]) continue;
  let t = daysAgo(i * 2, 11).getTime();
  for (const m of c.msgs) {
    await q(
      `insert into instagram_messages(conversation_id, external_mid, direction, text, intent, created_at) values ($1, $2, 'in', $3, $4, $5)`,
      [conv[0].id, `${c.user}-${t}`, m, c.intent, new Date(t)],
    );
    t += 15 * 60_000;
    if (i >= 3) {
      await q(
        `insert into instagram_messages(conversation_id, external_mid, direction, text, auto_reply, sent_by, created_at) values ($1, $2, 'out', $3, false, $4, $5)`,
        [
          conv[0].id,
          `${c.user}-out-${t}`,
          "¡Hola! Claro que sí, te comparto la info por aquí 😊",
          staffId,
          new Date(t),
        ],
      );
      t += 10 * 60_000;
    }
  }
  if (c.intent === "pedido" || c.intent === "mayoreo") {
    await q(
      `insert into leads(source, source_ref, name, handle, interest, status, created_at)
       select 'instagram', $1, $2, $3, $4, $5, $6 where not exists (select 1 from leads where source_ref = $1)`,
      [
        conv[0].id,
        c.handle,
        c.handle,
        c.msgs[0],
        i >= 4 ? "converted" : i === 3 ? "contacted" : "new",
        daysAgo(i * 2, 12),
      ],
    );
  }
  igN++;
}
console.info(`Instagram: ${igN} conversaciones nuevas`);

// Eventos automáticos de hoy (cumpleaños/inactividad) para que el tablero tenga contenido
const ev = await q<{ r: unknown }>("select run_customer_events() as r");
console.info("Eventos de cliente:", JSON.stringify(ev[0]!.r));

await client.end();
console.info("Demo listo");
