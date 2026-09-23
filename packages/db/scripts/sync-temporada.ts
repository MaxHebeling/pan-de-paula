/**
 * Sincroniza el catálogo con la hoja de productos de la temporada.
 *
 * La fuente de verdad es el .xlsx exportado del Google Sheet del dueño, y la señal de "ya no se
 * vende" son las FILAS OCULTAS: así las marca él. Un producto oculto se **retira** (is_active=false,
 * fuera de web y de caja) pero NUNCA se borra: sus ventas, sus puntos y su historial de precios
 * siguen intactos, que es lo que exige la integridad del negocio.
 *
 * El número de la columna `#` se guarda como `sku` (`PDP-07`). A partir de ahí el emparejamiento de
 * la siguiente temporada es por identificador y no por nombre, que es frágil: esta hoja trae dos
 * erratas de tecleo ("Kougn-amann Churro", "Kouig-amann Guayaba") que por nombre habrían creado
 * productos duplicados.
 *
 * Idempotente: correrlo dos veces no duplica nada ni vuelve a retirar nada. Simula por omisión.
 *
 *   tsx packages/db/scripts/sync-temporada.ts --file <hoja.xlsx> [--fotos <carpeta>] [--apply] [--yes-production]
 */
import ExcelJS from "exceljs";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import pg from "pg";
import { databaseUrl, sslConfig } from "./env.ts";

// ── Argumentos ──────────────────────────────────────────────────────────────
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);
const archivo = arg("file");
if (!archivo) {
  console.error("Falta --file <hoja.xlsx> (exporta el Sheet con Archivo → Descargar → .xlsx)");
  process.exit(2);
}
const carpetaFotos = arg("fotos");
const aplicar = flag("apply");
if (aplicar && process.env.APP_ENV === "production" && !flag("yes-production")) {
  console.error("Estás en producción: agrega --yes-production tras revisar la simulación.");
  process.exit(2);
}

// ── Normalización de nombres ────────────────────────────────────────────────
/** Minúsculas, sin acentos y sin signos: "Kouign-amann Churro" y "kouign amann churro" son lo mismo. */
const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Distancia de edición, para reconocer erratas de tecleo sin inventar parecidos. */
function distancia(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

// ── Lectura de la hoja ──────────────────────────────────────────────────────
type Fila = {
  fila: number;
  numero: number | null;
  nombre: string;
  descripcion: string;
  precioCents: number | null;
  oculta: boolean;
};

const celda = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v !== null && "richText" in v)
    return (v as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join("");
  return String(v).trim();
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(resolve(process.env.INIT_CWD ?? process.cwd(), archivo));
const ws = wb.worksheets[0]!;
const filas: Fila[] = [];
ws.eachRow({ includeEmpty: false }, (row, n) => {
  if (n === 1) return; // encabezados
  const v = (row.values as unknown[]).slice(1);
  const numero = celda(v[0]) ? Number(celda(v[0])) : null;
  const nombre = celda(v[1]);
  if (!nombre) return;
  const precio = celda(v[3]);
  filas.push({
    fila: n,
    numero: Number.isFinite(numero) ? numero : null,
    nombre,
    descripcion: celda(v[2]),
    precioCents: precio ? Math.round(Number(precio.replace(/[^0-9.]/g, "")) * 100) : null,
    oculta: row.hidden === true,
  });
});

const visibles = filas.filter((f) => !f.oculta);
const ocultas = filas.filter((f) => f.oculta);

// ── Estado actual del catálogo ──────────────────────────────────────────────
type Prod = {
  id: string;
  name: string;
  sku: string | null;
  is_active: boolean;
  show_on_web: boolean;
  show_on_pos: boolean;
  short_description: string | null;
  price_cents: number | null;
  fotos: number;
};

const client = new pg.Client({ connectionString: databaseUrl("app"), ssl: sslConfig() });
await client.connect();
const q = async <T extends pg.QueryResultRow>(t: string, p: unknown[] = []) =>
  (await client.query<T>(t, p)).rows;

const productos = await q<Prod>(`
  select p.id::text, p.name, p.sku, p.is_active, p.show_on_web, p.show_on_pos, p.short_description,
         current_price_cents(p.id) as price_cents,
         (select count(*)::int from product_images i where i.product_id = p.id) as fotos
    from products p
   where p.deleted_at is null and p.parent_id is null
   order by p.name`);

// ── Emparejamiento: sku → nombre exacto → errata evidente ───────────────────
type Match = { fila: Fila; prod?: Prod; via: string; aviso?: string };
const categoriaDe = new Map(
  (
    await q<{ id: string; categoria: string | null }>(
      `select p.id::text, c.name as categoria from products p
         left join categories c on c.id = p.category_id
        where p.deleted_at is null and p.parent_id is null`,
    )
  ).map((r) => [r.id, r.categoria ?? "—"]),
);

const porSku = new Map(productos.filter((p) => p.sku).map((p) => [p.sku!, p]));
const porNombre = new Map(productos.map((p) => [norm(p.name), p]));
const usados = new Set<string>();
const conflictos: Array<{ tipo: string; detalle: string }> = [];

const emparejar = (f: Fila): Match => {
  if (f.numero !== null) {
    const p = porSku.get(`PDP-${String(f.numero).padStart(2, "0")}`);
    if (p) return { fila: f, prod: p, via: "sku" };
  }
  const exacto = porNombre.get(norm(f.nombre));
  if (exacto) return { fila: f, prod: exacto, via: "nombre" };
  // Errata: se acepta solo si hay UNA candidata a distancia ≤ 2. Con dos, es conflicto.
  const cerca = productos.filter((p) => distancia(norm(p.name), norm(f.nombre)) <= 2);
  if (cerca.length === 1)
    return {
      fila: f,
      prod: cerca[0],
      via: "errata",
      aviso: `la hoja dice "${f.nombre}" y el catálogo "${cerca[0]!.name}"`,
    };
  if (cerca.length > 1) {
    conflictos.push({
      tipo: "nombre ambiguo",
      detalle: `"${f.nombre}" se parece a ${cerca.map((c) => `"${c.name}"`).join(" y ")}`,
    });
    return { fila: f, via: "ambiguo" };
  }
  return { fila: f, via: "sin match" };
};

const mVisibles = visibles.map(emparejar);
const mOcultas = ocultas.map(emparejar);
for (const m of [...mVisibles, ...mOcultas]) if (m.prod) usados.add(m.prod.id);

/**
 * De dónde salen los campos de un producto nuevo. No se inventan: se copian del producto existente
 * más parecido por nombre (las cuatro "Docena Mini…" viven todas en "Para compartir" y se venden por
 * docena). Si no hay ninguno parecido, se deja sin categoría y el reporte lo dice, para que alguien
 * decida en vez de que el guion adivine.
 */
function moldePara(nombre: string) {
  const palabras = norm(nombre).split(" ");
  let mejor: Prod | undefined;
  let mejorPuntos = 0;
  for (const p of productos) {
    const suyas = norm(p.name).split(" ");
    // "Minis" y "Mini" son la misma palabra para esto: se comparan por prefijo desde 4 letras.
    const puntos = palabras.filter((w) =>
      suyas.some((o) => o === w || (w.length >= 4 && (o.startsWith(w) || w.startsWith(o)))),
    ).length;
    if (puntos > mejorPuntos) {
      mejorPuntos = puntos;
      mejor = p;
    }
  }
  return {
    origen: mejor && mejorPuntos >= 2 ? `"${mejor.name}"` : "ninguno (sin categoría)",
    categoria: mejor && mejorPuntos >= 2 ? (categoriaDe.get(mejor.id) ?? "—") : "—",
    id: mejor && mejorPuntos >= 2 ? mejor.id : null,
  };
}

// ── Plan de cambios ─────────────────────────────────────────────────────────
type Cambio = { accion: string; nombre: string; detalle: string; sql?: () => Promise<void> };
const plan: Cambio[] = [];

for (const m of mVisibles) {
  const f = m.fila;
  const sku = f.numero !== null ? `PDP-${String(f.numero).padStart(2, "0")}` : null;
  if (!m.prod) {
    const molde = moldePara(f.nombre);
    plan.push({
      accion: "ALTA",
      nombre: f.nombre,
      detalle:
        `$${((f.precioCents ?? 0) / 100).toFixed(2)} · categoría "${molde.categoria}"` +
        ` · mismo perfil que ${molde.origen}`,
    });
    continue;
  }
  const p = m.prod;
  const difs: string[] = [];
  if (!p.is_active) difs.push("reactivar");
  if (!p.show_on_web) difs.push("mostrar en web");
  if (!p.show_on_pos) difs.push("mostrar en caja");
  if (sku && p.sku !== sku) difs.push(`sku ${p.sku ?? "—"} → ${sku}`);
  if (f.precioCents !== null && p.price_cents !== f.precioCents)
    difs.push(
      `precio $${((p.price_cents ?? 0) / 100).toFixed(2)} → $${(f.precioCents / 100).toFixed(2)}`,
    );
  if (f.descripcion && (p.short_description ?? "").trim() !== f.descripcion)
    difs.push("descripción");
  if (difs.length)
    plan.push({
      accion: "ACTUALIZA",
      nombre: p.name,
      detalle: difs.join(" · ") + (m.aviso ? ` · ${m.aviso}` : ""),
    });
}

for (const m of mOcultas) {
  if (!m.prod) continue; // oculto y sin producto: nada que hacer
  if (m.prod.is_active || m.prod.show_on_web || m.prod.show_on_pos)
    plan.push({
      accion: "RETIRA",
      nombre: m.prod.name,
      detalle: `fila oculta en la hoja${m.aviso ? ` · ${m.aviso}` : ""} · se conserva el historial`,
    });
}

const activosFueraDeHoja = productos.filter((p) => p.is_active && !usados.has(p.id));

// ── Fotos ───────────────────────────────────────────────────────────────────
type Foto = { archivo: string; numero: number | null; nombre: string };
let fotos: Foto[] = [];
if (carpetaFotos) {
  const dir = resolve(process.env.INIT_CWD ?? process.cwd(), carpetaFotos);
  if (!existsSync(dir)) {
    console.error(`No existe la carpeta de fotos ${dir}`);
    process.exit(2);
  }
  /*
   * Dos formas de saber a qué producto pertenece un archivo, por orden de confianza:
   *   1. el manifiesto `fotos.csv` del lote, que es una decisión humana ya revisada;
   *   2. el número al principio del nombre (`21_Docena Minis Mixtos.jpg`), la convención de Drive.
   * Sin ninguna de las dos no se adivina: el archivo sale en el reporte como imagen sin producto.
   */
  const porArchivo = new Map<string, string>();
  const manifiesto = join(dir, "fotos.csv");
  if (existsSync(manifiesto))
    for (const l of readFileSync(manifiesto, "utf8").split(/\r?\n/).slice(1)) {
      const m = /^([^,]+),([^,]+)/.exec(l.trim());
      if (m) porArchivo.set(m[2]!.trim(), m[1]!.trim());
    }
  fotos = readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => {
      const delManifiesto = porArchivo.get(f);
      if (delManifiesto)
        return {
          archivo: f,
          numero: visibles.find((x) => norm(x.nombre) === norm(delManifiesto))?.numero ?? null,
          nombre: delManifiesto,
        };
      const m = /^(\d+)[_\s-]+(.+?)\.(jpe?g|png|webp)$/i.exec(f);
      return {
        archivo: f,
        numero: m ? Number(m[1]) : null,
        nombre: m ? m[2]!.trim() : basename(f),
      };
    });
}
const fotoDe = new Map(fotos.filter((f) => f.numero !== null).map((f) => [f.numero!, f]));
const numerosDuplicados = fotos
  .filter((f) => f.numero !== null)
  .reduce<Record<number, number>>((a, f) => ((a[f.numero!] = (a[f.numero!] ?? 0) + 1), a), {});
for (const [n, c] of Object.entries(numerosDuplicados))
  if (c > 1)
    conflictos.push({ tipo: "número duplicado", detalle: `${c} fotos con el número ${n}` });

/*
 * "Sin imagen" es el producto que no tiene foto EN NINGÚN LADO: ni en este lote ni ya cargada en el
 * catálogo. Contar solo el lote diría que faltan veinte fotos que en realidad llevan meses publicadas.
 */
const sinFoto = mVisibles.filter(
  (m) => (m.fila.numero === null || !fotoDe.has(m.fila.numero)) && (m.prod?.fotos ?? 0) === 0,
);
const fotosSinProducto = fotos.filter(
  (f) => f.numero === null || !visibles.some((v) => v.numero === f.numero),
);
// Discrepancia de nombre entre la foto y la hoja: se avisa, no se corrige sola.
for (const m of mVisibles) {
  const f = m.fila.numero !== null ? fotoDe.get(m.fila.numero) : undefined;
  if (f && norm(f.nombre) !== norm(m.fila.nombre))
    conflictos.push({
      tipo: "nombre distinto entre foto y hoja",
      detalle: `#${m.fila.numero}: foto "${f.nombre}" · hoja "${m.fila.nombre}"`,
    });
}

// ── Reporte ─────────────────────────────────────────────────────────────────
const L: string[] = [];
const p = (s = "") => L.push(s);
p(`# Sincronización de temporada · ${new Date().toISOString().slice(0, 10)}`);
p();
p(
  `Hoja: \`${basename(archivo)}\` · ${filas.length} productos (${visibles.length} visibles, ${ocultas.length} ocultos)`,
);
p(
  `Catálogo: ${productos.length} productos, ${productos.filter((x) => x.is_active).length} activos`,
);
if (carpetaFotos) p(`Fotos: ${fotos.length} archivos en \`${carpetaFotos}\``);
p();
p(`## Productos correctamente asociados (${mVisibles.filter((m) => m.prod).length})`);
p();
p("| # | Producto | Precio | Foto | Estado |");
p("| --- | --- | --- | --- | --- |");
for (const m of mVisibles) {
  const f = m.fila.numero !== null ? fotoDe.get(m.fila.numero) : undefined;
  const estado = !m.prod
    ? "**alta nueva**"
    : plan.some((c) => c.nombre === m.prod!.name && c.accion === "ACTUALIZA")
      ? "actualiza"
      : "sin cambios";
  p(
    `| ${m.fila.numero ?? "—"} | ${m.fila.nombre} | $${((m.fila.precioCents ?? 0) / 100).toFixed(2)} | ${f ? "✓" : "—"} | ${estado} |`,
  );
}
p();
p(`## Productos que se retiran (${plan.filter((c) => c.accion === "RETIRA").length})`);
p();
p("Filas ocultas en la hoja. Se desactivan y salen de web y caja; **no se borran**.");
p();
for (const c of plan.filter((x) => x.accion === "RETIRA")) p(`- ${c.nombre}`);
const ocultasSinProducto = mOcultas.filter((m) => !m.prod);
if (ocultasSinProducto.length) {
  p();
  p(
    `Ocultos que ni siquiera existen en el catálogo (nada que hacer): ${ocultasSinProducto.map((m) => m.fila.nombre).join(", ")}.`,
  );
}
p();
p(`## Productos sin imagen (${sinFoto.length})`);
p();
for (const m of sinFoto) p(`- #${m.fila.numero ?? "—"} ${m.fila.nombre}`);
if (!sinFoto.length) p("Ninguno.");
p();
p(`## Imágenes sin producto (${fotosSinProducto.length})`);
p();
for (const f of fotosSinProducto)
  p(`- \`${f.archivo}\`${f.numero !== null ? ` (número ${f.numero})` : " (sin número)"}`);
if (!fotosSinProducto.length) p("Ninguna.");
p();
p(`## Conflictos (${conflictos.length})`);
p();
if (!conflictos.length) p("Ninguno.");
for (const c of conflictos) p(`- **${c.tipo}** — ${c.detalle}`);
if (activosFueraDeHoja.length) {
  p();
  p(`## Activos que la hoja no menciona (${activosFueraDeHoja.length})`);
  p();
  p("No se tocan: la hoja no dice nada de ellos, y callar no es lo mismo que retirar.");
  p();
  for (const x of activosFueraDeHoja) p(`- ${x.name}`);
}
p();
p("## Plan");
p();
if (!plan.length) p("Sin cambios: el catálogo ya coincide con la hoja.");
for (const c of plan) p(`- \`${c.accion}\` **${c.nombre}** — ${c.detalle}`);

const reporte = L.join("\n") + "\n";
console.info(reporte);

// ── Aplicación ──────────────────────────────────────────────────────────────
if (!aplicar) {
  console.info("SIMULACIÓN · no se escribió nada. Agrega --apply para aplicar el plan.");
  await client.end();
  process.exit(conflictos.length ? 1 : 0);
}

const staff = await q<{ id: string }>(
  `select id from staff_users where is_active and deleted_at is null
    order by (role_key in ('super_admin','owner')) desc, created_at limit 1`,
);
if (!staff[0]) throw new Error("No hay staff activo para firmar los cambios.");

await client.query("begin");
try {
  await client.query(`select set_config('app.staff_id', $1, true)`, [staff[0].id]);

  for (const m of mVisibles) {
    const f = m.fila;
    const sku = f.numero !== null ? `PDP-${String(f.numero).padStart(2, "0")}` : null;
    if (!m.prod) {
      /*
       * Alta. Los campos operativos (categoría, unidad, si lleva stock, si acepta preventa) se COPIAN
       * del hermano más parecido que ya existe, en el mismo INSERT: así un producto nuevo nace con el
       * mismo comportamiento que sus iguales y no con valores inventados aquí.
       */
      const molde = moldePara(f.nombre);
      if (!molde.id) {
        console.warn(
          `  ⚠ ${f.nombre}: sin producto parecido del que copiar perfil; no se da de alta.`,
        );
        continue;
      }
      const slug = norm(f.nombre).replace(/ /g, "-");
      const nuevo = await q<{ id: string }>(
        `insert into products
           (slug, name, short_description, category_id, unit_label, track_stock, allow_preorder,
            requires_preorder, is_active, show_on_web, show_on_pos, sku, sort_order)
         select $1, $2, $3, m.category_id, m.unit_label, m.track_stock, m.allow_preorder,
                m.requires_preorder, true, true, true, $4,
                coalesce((select max(sort_order) from products), 0) + 10
           from products m where m.id = $5
         on conflict (slug) do nothing
         returning id::text`,
        [slug, f.nombre, f.descripcion, sku, molde.id],
      );
      const id = nuevo[0]?.id;
      if (!id) {
        console.warn(`  ⚠ ${f.nombre}: ya existía un producto con el slug ${slug}; no se duplica.`);
        continue;
      }
      // Canal `all`, como el resto del catálogo: con precios por canal `current_price_cents()` no los ve.
      if (f.precioCents !== null)
        await client.query(`select set_regular_price($1::uuid, 'all'::price_channel, $2, $3)`, [
          id,
          f.precioCents,
          "Temporada",
        ]);
      console.info(`  + alta ${f.nombre} (${slug}) con el perfil de ${molde.origen}`);
      continue;
    }
    await client.query(
      `update products set is_active = true, show_on_web = true, show_on_pos = true,
              sku = coalesce($2, sku),
              short_description = case when $3 <> '' then $3 else short_description end
        where id = $1`,
      [m.prod.id, sku, f.descripcion],
    );
    if (f.precioCents !== null && m.prod.price_cents !== f.precioCents)
      await client.query(`select set_regular_price($1::uuid, 'all'::price_channel, $2, $3)`, [
        m.prod.id,
        f.precioCents,
        "Temporada",
      ]);
  }

  for (const m of mOcultas) {
    if (!m.prod) continue;
    await client.query(
      `update products set is_active = false, show_on_web = false, show_on_pos = false
        where id = $1 and (is_active or show_on_web or show_on_pos)`,
      [m.prod.id],
    );
  }

  await client.query("commit");
  console.info(`APLICADO · ${plan.length} cambios`);
} catch (e) {
  await client.query("rollback");
  throw e;
}

const destino = arg("reporte");
if (destino) {
  writeFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), destino), reporte);
  console.info(`Reporte en ${destino}`);
}
await client.end();
