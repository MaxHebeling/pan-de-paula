/**
 * Datos de DEMOSTRACIÓN para el video promocional.
 *
 * Puebla una base LOCAL con información ficticia pero coherente, para que las pantallas del CRM se
 * graben con contenido real del producto y no con tablas vacías. Nada de esto toca producción: el
 * guion se niega a correr si `DATABASE_URL` no apunta a localhost.
 *
 * Todo pasa por las funciones del propio sistema (`register_customer`, `record_production`,
 * `import_historical_sale`, `pos_checkout`, `create_order`), así que el resultado respeta las mismas
 * invariantes que revisa `scripts/db-integrity.sql`: los puntos cuadran con su ledger, el inventario
 * con sus movimientos y los pagos con los pedidos.
 *
 * Los nombres son inventados, los teléfonos usan el prefijo 555 (convención de ficción) y los correos
 * el dominio `example.com`, que la RFC 2606 reserva justamente para esto.
 *
 *   pnpm --filter @pdp/db exec tsx ../../media/promo/src/datos-demo.ts
 */
import pg from "pg";
import { databaseUrl } from "../../../packages/db/scripts/env.ts";

const url = process.env.DATABASE_URL ?? databaseUrl();
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1"].includes(host) || process.env.APP_ENV === "production") {
  console.error(`Rechazado: los datos de demo solo se cargan en localhost (host=${host}).`);
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await client.query<T>(text, params)).rows;

/** Autor de todo lo que se registra: sin esto las funciones auditadas no saben quién actúa. */
const staff = await q<{ id: string; full_name: string }>(
  `select id, full_name from staff_users where is_active and deleted_at is null order by created_at limit 1`,
);
if (!staff[0]) throw new Error("No hay staff. Corre primero `pnpm db:reset -- --seed`.");
await q(`select set_config('app.staff_id', $1, false)`, [staff[0].id]);

// El encabezado del panel saluda por el nombre de pila de quien entró. "Paula" es la marca, no una
// persona real: así la grabación no muestra el nombre de nadie.
await q(`update staff_users set full_name = 'Paula Demo' where id = $1`, [staff[0].id]);

const productos = await q<{ id: string; name: string; price: number | null; cost: number | null }>(
  `select p.id, p.name, current_price_cents(p.id) as price, product_cost_cents(p.id) as cost
     from products p
    where p.deleted_at is null and p.is_active and p.parent_id is null
    order by p.name`,
);
if (productos.length === 0) throw new Error("No hay productos. Corre `pnpm db:reset -- --seed`.");
/*
 * Para vender solo se usan los productos que tienen precio Y costo salido de su RECETA. Así los
 * márgenes que enseña el CRM son cuentas reales del sistema y no un número inventado para la cámara:
 * sin costo, el panel mostraría "margen 100%" y el reporte diría "costo de lo vendido: incompleto".
 */
const vendibles = productos.filter((p) => (p.price ?? 0) > 0 && (p.cost ?? 0) > 0);
if (vendibles.length < 4) throw new Error("Muy pocos productos con receta y precio para la demo.");
console.info(`· ${productos.length} productos · ${vendibles.length} con precio y costo de receta`);

// ── Clientes ficticios ──────────────────────────────────────────────────────
const PERSONAS = [
  ["Renata Mendoza Cabrera", "1991-03-12"],
  ["Ignacio Beltrán Ríos", "1985-07-26"],
  ["Camila Fuentes Ordóñez", "1996-11-04"],
  ["Mauricio Salgado Vidal", "1978-01-19"],
  ["Ximena Ocampo Ferrer", "1993-05-30"],
  ["Gerardo Ponce Arreola", "1988-09-08"],
  ["Valeria Cruz Montenegro", "1999-02-17"],
  ["Sebastián Aguirre Lozano", "1982-12-23"],
  ["Ana Sofía Quintero Nava", "1994-06-11"],
  ["Rodrigo Escamilla Pardo", "1990-10-02"],
  ["Lucía Arredondo Vega", "1997-04-25"],
  ["Emiliano Cárdenas Rubio", "1986-08-14"],
  ["Regina Villanueva Soto", "1992-01-07"],
  ["Adrián Zamudio Herrera", "1984-03-29"],
] as const;

const clientes: Array<{ id: string; nombre: string }> = [];
for (const [i, [nombre, cumple]] of PERSONAS.entries()) {
  const r = await q<{ r: { customer_id: string } }>(`select register_customer($1::jsonb) as r`, [
    JSON.stringify({
      full_name: nombre,
      phone: `664555${String(1000 + i).slice(-4)}`,
      email: `demo${i + 1}@example.com`,
      birthday: cumple,
      marketing_consent: i % 3 !== 0,
    }),
  ]);
  clientes.push({ id: r[0]!.r.customer_id, nombre });
}
console.info(`· ${clientes.length} clientes ficticios`);

// ── Producción del día: el inventario deja de estar en cero ─────────────────
for (const p of productos) {
  const piezas = 18 + ((p.name.length * 7) % 40);
  await q(`select record_production($1::uuid, $2::numeric, $3, false)`, [
    p.id,
    piezas,
    "Horneada de demostración",
  ]);
}
console.info(`· producción cargada en ${productos.length} productos`);

// ── Historial de ventas: 21 días, para que las gráficas y los reportes vivan ─
// `import_historical_sale` NO mueve stock (por diseño), así que el inventario queda intacto.
const CANALES = ["pos", "pos", "pos", "web", "whatsapp", "admin"] as const;
const METODOS = ["cash", "card_terminal", "mercadopago", "transfer"] as const;
let ventas = 0;
let semilla = 20260922;
const rnd = () => (semilla = (semilla * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

for (let dia = 21; dia >= 1; dia--) {
  // Fin de semana con más movimiento: la curva del reporte se parece a la de una panadería.
  const fecha = new Date(Date.now() - dia * 86_400_000);
  const finde = [0, 6].includes(fecha.getDay());
  const nTickets = (finde ? 9 : 5) + Math.floor(rnd() * 4);
  for (let t = 0; t < nTickets; t++) {
    const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
      const p = vendibles[Math.floor(rnd() * vendibles.length)]!;
      // El costo va explícito: en una fecha pasada no hay historial de precios de insumos y saldría 0.
      return { product_id: p.id, qty: 1 + Math.floor(rnd() * 3), unit_cost_cents: p.cost };
    });
    const cliente = rnd() < 0.55 ? clientes[Math.floor(rnd() * clientes.length)] : null;
    await q(`select import_historical_sale($1::jsonb) as r`, [
      JSON.stringify({
        source_ref: `import:demo-video:${dia}-${t}`,
        sold_at: new Date(fecha.setHours(8 + Math.floor(rnd() * 10), Math.floor(rnd() * 60), 0, 0)),
        channel: CANALES[Math.floor(rnd() * CANALES.length)],
        payment_method: METODOS[Math.floor(rnd() * METODOS.length)],
        customer_id: cliente?.id ?? null,
        items,
      }),
    ]);
    ventas++;
  }
}
console.info(`· ${ventas} ventas de historial en 21 días`);

// ── Caja abierta y cobros de hoy, que es lo que mira el panel ───────────────
const abierta = await q<{ id: string }>(`select id from register_sessions where status = 'open'`);
const caja =
  abierta[0]?.id ??
  (
    await q<{ id: string }>(`select open_register($1, $2) as id`, [150000, "Turno de demostración"])
  )[0]!.id;

const hoy = [
  { cliente: clientes[0]!, metodo: "cash" as const, n: 2 },
  { cliente: clientes[4]!, metodo: "card_terminal" as const, n: 3 },
  { cliente: null, metodo: "cash" as const, n: 1 },
  { cliente: clientes[8]!, metodo: "transfer" as const, n: 2 },
  { cliente: clientes[2]!, metodo: "card_terminal" as const, n: 4 },
  { cliente: null, metodo: "cash" as const, n: 2 },
];
for (const [i, t] of hoy.entries()) {
  const items = Array.from({ length: t.n }, (_, k) => {
    const p = vendibles[(i * 5 + k * 3) % vendibles.length]!;
    return { product_id: p.id, qty: 1 + (k % 2) };
  });
  const total = items.reduce((s, it) => {
    const p = vendibles.find((x) => x.id === it.product_id)!;
    return s + (p.price ?? 0) * it.qty;
  }, 0);
  await q(`select pos_checkout($1::jsonb) as r`, [
    JSON.stringify({
      items,
      customer_id: t.cliente?.id ?? null,
      payments: [
        {
          provider: t.metodo === "cash" ? "cash" : "manual",
          method: t.metodo,
          amount_cents: total,
          ...(t.metodo === "cash" ? { tendered_cents: Math.ceil(total / 5000) * 5000 } : {}),
        },
      ],
      register_session_id: caja,
      idempotency_key: `demo-video-hoy-${i}`,
    }),
  ]);
}
console.info(`· ${hoy.length} cobros de hoy en la caja abierta`);

// ── Pedidos en curso, para que el tablero muestre estados distintos ─────────
// Estados reales del flujo (`order_status`), respetando las transiciones que permite el sistema.
const ESTADOS = [
  ["confirmed"],
  ["confirmed", "in_production"],
  ["confirmed", "in_production", "ready"],
  ["confirmed"],
  ["confirmed", "in_production"],
] as const;
for (const [i, estado] of ESTADOS.entries()) {
  const c = clientes[(i + 3) % clientes.length]!;
  const items = [
    { product_id: vendibles[(i * 4) % vendibles.length]!.id, qty: 2 + (i % 3) },
    { product_id: vendibles[(i * 4 + 2) % vendibles.length]!.id, qty: 1 },
  ];
  const [{ id }] = await q<{ id: string }>(`select create_order($1::jsonb) as id`, [
    JSON.stringify({
      channel: i % 2 === 0 ? "web" : "whatsapp",
      customer_id: c.id,
      customer_name: c.nombre,
      customer_phone: `664555${String(1000 + ((i + 3) % clientes.length)).slice(-4)}`,
      items,
      notes: i === 1 ? "Sin azúcar glass, por favor" : undefined,
      idempotency_key: `demo-video-pedido-${i}`,
    }),
  ]);
  for (const paso of estado) {
    await q(`select change_order_status($1::uuid, $2::order_status, null)`, [id, paso]);
  }
}
console.info(`· ${ESTADOS.length} pedidos en curso`);

const resumen = await q<Record<string, string>>(`
  select (select count(*) from customers where deleted_at is null)::text as clientes,
         (select count(*) from orders)::text as pedidos,
         (select count(*) from sales)::text as ventas,
         (select count(*) from notifications where read_at is null)::text as avisos`);
console.info("Listo:", resumen[0]);
await client.end();
