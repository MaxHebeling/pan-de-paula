/**
 * Capturas del CRM para el video promocional.
 *
 * Recorre el CRM real con un navegador automatizado y guarda PNG a 2× en `media/promo/capturas/`.
 * No inventa pantallas ni retoca la interfaz: lo que sale en el video es lo que ve quien lo usa.
 *
 * Las secuencias (`rafaga`) son interacciones de verdad, fotograma a fotograma: escribir el código de
 * un cliente en la caja, abrir un pedido. Después el montaje las reproduce a su ritmo.
 *
 * Requisitos: el CRM corriendo en PROMO_URL (por omisión http://localhost:3001) contra la base local
 * con `datos-demo.ts` ya cargado.
 *
 *   pnpm --filter @pdp/admin exec tsx ../../media/promo/src/capturar.ts
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { databaseUrl } from "../../../packages/db/scripts/env.ts";

const BASE = process.env.PROMO_URL ?? "http://localhost:3001";
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";
const OUT = resolve(import.meta.dirname, "../capturas");

const url = process.env.DATABASE_URL ?? databaseUrl();
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  console.error("Rechazado: capturar solo contra una base local.");
  process.exit(2);
}

// Datos concretos de la demo, leídos de la base para no escribirlos a mano.
const cx = new pg.Client({ connectionString: url });
await cx.connect();
const uno = async (sql: string) => (await cx.query<{ v: string }>(sql)).rows[0]?.v ?? "";
const codigoCliente = await uno(
  `select public_code as v from customers order by points_balance desc limit 1`,
);
const clienteId = await uno(
  `select id::text as v from customers order by points_balance desc limit 1`,
);
const pedidoId = await uno(
  `select id::text as v from orders where status in ('confirmed','in_production','ready') order by placed_at desc limit 1`,
);
const productos = (
  await cx.query<{ name: string }>(
    `select name from products where is_active and deleted_at is null and parent_id is null
       and current_price_cents(id) > 0 and product_cost_cents(id) > 0 order by name limit 4`,
  )
).rows.map((r) => r.name);
await cx.end();

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  locale: "es-MX",
  timezoneId: "America/Tijuana",
  colorScheme: "light",
  reducedMotion: "no-preference",
});
const page = await ctx.newPage();
// La barra de desplazamiento del navegador no es parte del producto: fuera de cuadro.
await page.addStyleTag({ content: `::-webkit-scrollbar{width:0;height:0}` }).catch(() => {});

let n = 0;
const tomar = async (
  nombre: string,
  opts: { clip?: { x: number; y: number; width: number; height: number } } = {},
) => {
  n++;
  const file = `${OUT}/${String(n).padStart(2, "0")}-${nombre}.png`;
  await page.screenshot({ path: file, clip: opts.clip, animations: "disabled" });
  console.info(`  ${file.split("/").pop()}`);
};

/** Espera a que la pantalla esté realmente lista: sin red pendiente y sin esqueletos de carga. */
const asentar = async (ms = 900) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
};

const ir = async (ruta: string) => {
  await page.goto(`${BASE}${ruta}`, { waitUntil: "domcontentloaded" });
  await asentar();
};

/** Una interacción real, fotograma a fotograma. */
const rafaga = async (nombre: string, pasos: number, accion: (i: number) => Promise<void>) => {
  for (let i = 0; i < pasos; i++) {
    await accion(i);
    n++;
    await page.screenshot({
      path: `${OUT}/${String(n).padStart(2, "0")}-${nombre}-${String(i).padStart(2, "0")}.png`,
      animations: "disabled",
    });
  }
  console.info(`  ráfaga ${nombre}: ${pasos} fotogramas`);
};

// ── Entrar ──────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.fill("#email", EMAIL);
await page.fill("#password", PASSWORD);
await page.getByRole("button", { name: "Entrar" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
await asentar(1200);

// ── Panel ───────────────────────────────────────────────────────────────────
console.info("Panel");
await ir("/dashboard");
await tomar("panel");
await tomar("panel-encabezado", { clip: { x: 0, y: 0, width: 1600, height: 330 } });
await tomar("panel-metricas", { clip: { x: 0, y: 250, width: 1600, height: 420 } });
await page.mouse.wheel(0, 620);
await asentar(700);
await tomar("panel-cobros");

// ── Caja (POS) ──────────────────────────────────────────────────────────────
console.info("Caja");
await ir("/pos");
await tomar("pos-vacio");
// Se arma un ticket con productos DISTINTOS del catálogo real, como una venta de mostrador.
for (const nombre of productos) {
  await page
    .getByRole("button", { name: `Agregar ${nombre}`, exact: true })
    .first()
    .click();
  await page.waitForTimeout(240);
}
await asentar(500);
await tomar("pos-ticket");

// Interacción real: identificar al cliente escribiendo su código. Sin Enter, como en la caja.
const buscador = page.getByLabel("Buscar cliente");
await buscador.click();
await rafaga("pos-cliente", codigoCliente.length + 4, async (i) => {
  if (i < codigoCliente.length) await buscador.type(codigoCliente[i]!, { delay: 0 });
  else await page.waitForTimeout(260);
});
await asentar(600);
await tomar("pos-cliente-listo");

// ── Pedidos ─────────────────────────────────────────────────────────────────
console.info("Pedidos");
await ir("/pedidos");
await tomar("pedidos");
if (pedidoId) {
  await ir(`/pedidos/${pedidoId}`);
  await tomar("pedido-detalle");
}

// ── Clientes y fidelización ─────────────────────────────────────────────────
console.info("Clientes");
await ir("/clientes");
await tomar("clientes");
if (clienteId) {
  await ir(`/clientes/${clienteId}`);
  await tomar("cliente-ficha");
  await ir(`/clientes/${clienteId}/tarjeta`);
  await tomar("cliente-tarjeta");
}
await ir("/fidelizacion");
await tomar("fidelizacion");

// ── Operación ───────────────────────────────────────────────────────────────
console.info("Operación");
await ir("/produccion");
await tomar("produccion");
await ir("/inventario");
await tomar("inventario");
await ir("/caja");
await tomar("caja");

// ── Reportes ────────────────────────────────────────────────────────────────
console.info("Reportes");
await ir("/reportes");
await tomar("reportes");
await tomar("reportes-grafica", { clip: { x: 0, y: 220, width: 1600, height: 560 } });
await ir("/reportes/productos");
await tomar("reportes-productos");
await ir("/reportes/mensual");
await tomar("reportes-mensual");
await ir("/recetas/hoja");
await tomar("recetas-hoja");

// ── Búsqueda y auditoría ────────────────────────────────────────────────────
console.info("Extras");
await ir("/buscar?q=croissant");
await tomar("buscar");
await ir("/auditoria");
await tomar("auditoria");

console.info(`\n${n} capturas en ${OUT}`);
await browser.close();
