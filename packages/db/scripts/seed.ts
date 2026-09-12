/**
 * Seed idempotente: catálogo base, ingredientes, recetas, precios, configuración, usuario admin.
 * Seguro de re-ejecutar (usa upsert por slug/nombre). No borra datos.
 * Uso: tsx scripts/seed.ts  (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD desde .env)
 */
import { hash } from "@node-rs/argon2";
import pg from "pg";
import { databaseUrl, sslConfig } from "./env.ts";

const url = process.env.DATABASE_URL ?? databaseUrl();
const client = new pg.Client({ connectionString: url, ssl: sslConfig() });
await client.connect();

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await client.query(text, params)).rows as T[];

try {
  await client.query("begin");

  // ── Admin ──
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@elpandepaula.local";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";
  const existing = await q<{ id: string }>("select id from staff_users where email = $1", [email]);
  if (existing.length === 0) {
    const ph = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    await q(
      "insert into staff_users(email, full_name, password_hash, role_key, must_change_password) values ($1,$2,$3,'super_admin', $4)",
      [email, "Administrador", ph, process.env.APP_ENV === "production"],
    );
    console.info(`Admin creado: ${email}`);
  }

  // ── Negocio ──
  await q(`update business_settings set name='El Pan de Paula', tagline='Boulangerie · Made with love', instagram_handle=coalesce(instagram_handle,'elpandepaula'),
           timezone=coalesce(timezone,'America/Tijuana') where id=1`);
  await q(`insert into pickup_points(name, address, is_default, sort_order) select 'Panadería (mostrador)', 'Dirección por configurar', true, 0
           where not exists (select 1 from pickup_points)`);
  await q(`insert into ordering_windows(name, fulfillment_type, order_weekdays, cutoff_time, fulfillment_weekday, fulfillment_from, fulfillment_to, lead_days_min)
           select 'Pedidos de la semana', 'scheduled_pickup', '{1,2,3}', '18:00', 5, '10:00', '18:00', 1
           where not exists (select 1 from ordering_windows)`);

  // ── Categorías ──
  const categories = [
    ["croissants", "Croissants", 1],
    ["galletas", "Galletas", 2],
    ["roles", "Roles", 3],
    ["pan-dulce", "Pan dulce", 4],
    ["brownies", "Brownies", 5],
    ["polvorones", "Polvorones", 6],
    ["cochinitos", "Cochinitos", 7],
    ["especialidades", "Especialidades", 8],
    ["combos", "Combos", 9],
    ["dubai", "Dubai", 10],
    ["temporada", "Temporada", 11],
    ["nuevos", "Nuevos", 12],
  ] as const;
  const catId: Record<string, string> = {};
  for (const [slug, name, order] of categories) {
    const r = await q<{ id: string }>(
      `insert into categories(slug, name, sort_order) values ($1,$2,$3) on conflict (slug) do update set name = excluded.name, sort_order = excluded.sort_order returning id`,
      [slug, name, order],
    );
    catId[slug] = r[0]!.id;
  }

  // ── Ingredientes (precio, contenido en unidad base) ──
  const ingredients: Array<[string, "g" | "ml" | "pz", number, number, string]> = [
    ["Harina de trigo", "g", 1000, 2200, "Bolsa 1 kg"],
    ["Mantequilla", "g", 1808, 40000, "Barra 1.808 kg"],
    ["Azúcar", "g", 1000, 2800, "Bolsa 1 kg"],
    ["Huevo", "pz", 30, 9500, "Cartón 30 pz"],
    ["Leche", "ml", 1000, 2600, "Litro"],
    ["Levadura seca", "g", 500, 12000, "Paquete 500 g"],
    ["Sal", "g", 1000, 1500, "Bolsa 1 kg"],
    ["Chocolate semiamargo", "g", 1000, 18000, "Bolsa 1 kg"],
    ["Canela molida", "g", 250, 6500, "Frasco 250 g"],
    ["Cocoa", "g", 500, 9000, "Bolsa 500 g"],
    ["Nuez", "g", 500, 16000, "Bolsa 500 g"],
    ["Pistache", "g", 500, 38000, "Bolsa 500 g"],
    ["Kataifi", "g", 500, 14000, "Paquete 500 g"],
    ["Vainilla", "ml", 250, 9000, "Frasco 250 ml"],
    ["Manteca vegetal", "g", 1000, 5200, "Barra 1 kg"],
    ["Piloncillo", "g", 1000, 4500, "Bolsa 1 kg"],
  ];
  const ingId: Record<string, string> = {};
  for (const [name, unit, qty, price, label] of ingredients) {
    const r = await q<{ id: string }>(
      `select id from ingredients where lower(name) = lower($1) and deleted_at is null`,
      [name],
    );
    let id = r[0]?.id;
    if (!id) {
      id = (
        await q<{ id: string }>(
          `insert into ingredients(name, base_unit, min_stock_qty) values ($1,$2,$3) returning id`,
          [name, unit, unit === "pz" ? 12 : 500],
        )
      )[0]!.id;
      await q(
        `insert into ingredient_prices(ingredient_id, package_qty, price_cents, package_label, source) values ($1,$2,$3,$4,'seed')`,
        [id, qty, price, label],
      );
    }
    ingId[name] = id;
  }

  // ── Productos + precios + recetas ──
  type P = {
    slug: string;
    name: string;
    cat: string;
    price: number;
    desc: string;
    featured?: boolean;
    recipe?: { yield: number; items: Array<[string, number]> };
    preorder?: boolean;
    tags?: string[];
  };
  const products: P[] = [
    {
      slug: "croissant-mantequilla",
      name: "Croissant de mantequilla",
      cat: "croissants",
      price: 4500,
      desc: "Hojaldre de 27 capas, mantequilla pura, horneado cada mañana.",
      featured: true,
      recipe: {
        yield: 12,
        items: [
          ["Harina de trigo", 1000],
          ["Mantequilla", 500],
          ["Azúcar", 100],
          ["Huevo", 2],
          ["Leche", 300],
          ["Levadura seca", 12],
          ["Sal", 18],
        ],
      },
    },
    {
      slug: "croissant-chocolate",
      name: "Croissant de chocolate",
      cat: "croissants",
      price: 5500,
      desc: "Nuestro croissant con dos barras de chocolate semiamargo.",
      recipe: {
        yield: 12,
        items: [
          ["Harina de trigo", 1000],
          ["Mantequilla", 500],
          ["Azúcar", 100],
          ["Huevo", 2],
          ["Leche", 300],
          ["Levadura seca", 12],
          ["Sal", 18],
          ["Chocolate semiamargo", 240],
        ],
      },
    },
    {
      slug: "croissant-almendra",
      name: "Croissant de almendra",
      cat: "croissants",
      price: 6000,
      desc: "Relleno de crema de almendra y tostado con láminas de almendra.",
    },
    {
      slug: "galleta-chispas",
      name: "Galleta de chispas de chocolate",
      cat: "galletas",
      price: 3500,
      desc: "Grande, crujiente por fuera y suave por dentro.",
      featured: true,
      recipe: {
        yield: 16,
        items: [
          ["Harina de trigo", 600],
          ["Mantequilla", 250],
          ["Azúcar", 300],
          ["Huevo", 2],
          ["Chocolate semiamargo", 300],
          ["Vainilla", 10],
          ["Sal", 5],
        ],
      },
    },
    {
      slug: "galleta-nuez",
      name: "Galleta de nuez",
      cat: "galletas",
      price: 3500,
      desc: "Mantequilla, nuez tostada y un toque de canela.",
    },
    {
      slug: "rol-canela",
      name: "Rol de canela",
      cat: "roles",
      price: 5500,
      desc: "Masa esponjosa, relleno de canela y glaseado de queso crema.",
      featured: true,
      recipe: {
        yield: 12,
        items: [
          ["Harina de trigo", 900],
          ["Mantequilla", 200],
          ["Azúcar", 250],
          ["Huevo", 2],
          ["Leche", 350],
          ["Levadura seca", 10],
          ["Canela molida", 20],
          ["Sal", 8],
        ],
      },
    },
    {
      slug: "rol-nutella",
      name: "Rol de Nutella",
      cat: "roles",
      price: 6500,
      desc: "Rol relleno de crema de avellana.",
    },
    {
      slug: "concha-vainilla",
      name: "Concha de vainilla",
      cat: "pan-dulce",
      price: 2500,
      desc: "La concha clásica, con costra de vainilla.",
      recipe: {
        yield: 20,
        items: [
          ["Harina de trigo", 1000],
          ["Manteca vegetal", 200],
          ["Azúcar", 250],
          ["Huevo", 4],
          ["Leche", 300],
          ["Levadura seca", 12],
          ["Vainilla", 8],
          ["Sal", 10],
        ],
      },
    },
    {
      slug: "concha-chocolate",
      name: "Concha de chocolate",
      cat: "pan-dulce",
      price: 2500,
      desc: "Concha con costra de cocoa.",
    },
    {
      slug: "brownie-clasico",
      name: "Brownie clásico",
      cat: "brownies",
      price: 4000,
      desc: "Denso, húmedo, con chocolate semiamargo.",
      recipe: {
        yield: 16,
        items: [
          ["Chocolate semiamargo", 400],
          ["Mantequilla", 250],
          ["Azúcar", 350],
          ["Huevo", 4],
          ["Harina de trigo", 150],
          ["Cocoa", 40],
          ["Sal", 3],
        ],
      },
    },
    {
      slug: "brownie-nuez",
      name: "Brownie con nuez",
      cat: "brownies",
      price: 4500,
      desc: "Brownie clásico con nuez tostada.",
    },
    {
      slug: "polvoron",
      name: "Polvorón",
      cat: "polvorones",
      price: 1500,
      desc: "Se deshace en la boca. Receta de la abuela.",
      recipe: {
        yield: 40,
        items: [
          ["Harina de trigo", 800],
          ["Manteca vegetal", 350],
          ["Azúcar", 300],
          ["Canela molida", 8],
        ],
      },
    },
    {
      slug: "cochinito",
      name: "Cochinito de piloncillo",
      cat: "cochinitos",
      price: 2000,
      desc: "Pan de piloncillo suave con forma de cerdito.",
      recipe: {
        yield: 24,
        items: [
          ["Harina de trigo", 1000],
          ["Piloncillo", 350],
          ["Manteca vegetal", 200],
          ["Huevo", 2],
          ["Canela molida", 6],
        ],
      },
    },
    {
      slug: "croissant-dubai",
      name: "Croissant Dubai",
      cat: "dubai",
      price: 12000,
      desc: "Relleno de pistache y kataifi crujiente, cubierto de chocolate.",
      featured: true,
      tags: ["nuevo"],
      recipe: {
        yield: 12,
        items: [
          ["Harina de trigo", 1000],
          ["Mantequilla", 500],
          ["Azúcar", 100],
          ["Huevo", 2],
          ["Leche", 300],
          ["Levadura seca", 12],
          ["Sal", 18],
          ["Pistache", 360],
          ["Kataifi", 240],
          ["Chocolate semiamargo", 300],
        ],
      },
    },
    {
      slug: "caja-6-croissants",
      name: "Caja de 6 croissants",
      cat: "combos",
      price: 24000,
      desc: "Seis croissants de mantequilla en caja de regalo.",
      preorder: true,
    },
    {
      slug: "rosca-temporada",
      name: "Rosca de temporada",
      cat: "temporada",
      price: 45000,
      desc: "Disponible solo en temporada. Bajo pedido.",
      preorder: true,
    },
  ];
  for (const p of products) {
    const r = await q<{ id: string }>(
      `insert into products(slug, name, short_description, category_id, is_featured, requires_preorder, tags, track_stock)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (slug) do update set name = excluded.name, short_description = excluded.short_description, category_id = excluded.category_id
       returning id`,
      [
        p.slug,
        p.name,
        p.desc,
        catId[p.cat],
        p.featured ?? false,
        p.preorder ?? false,
        p.tags ?? [],
        !(p.preorder ?? false),
      ],
    );
    const id = r[0]!.id;
    const hasPrice = await q(`select 1 from product_prices where product_id = $1`, [id]);
    if (hasPrice.length === 0)
      await q(
        `insert into product_prices(product_id, channel, kind, price_cents) values ($1,'all','regular',$2)`,
        [id, p.price],
      );
    if (p.recipe) {
      const hasRecipe = await q(`select 1 from recipes where product_id = $1`, [id]);
      if (hasRecipe.length === 0) {
        const rec = await q<{ id: string }>(
          `insert into recipes(product_id, yield_qty) values ($1,$2) returning id`,
          [id, p.recipe.yield],
        );
        let i = 0;
        for (const [ing, qty] of p.recipe.items) {
          await q(
            `insert into recipe_items(recipe_id, ingredient_id, qty, sort_order) values ($1,$2,$3,$4)`,
            [rec[0]!.id, ingId[ing], qty, i++],
          );
        }
      }
    }
  }

  // ── Recompensas y cupón de bienvenida ──
  await q(`insert into rewards(name, description, kind, points_cost, value_cents) select 'Descuento de $20', 'Canjea 50 puntos por $20 en tu compra', 'discount_amount', 50, 2000
           where not exists (select 1 from rewards where name = 'Descuento de $20')`);
  await q(`insert into rewards(name, description, kind, points_cost, product_id) select 'Croissant de regalo', 'Canjea 120 puntos por un croissant de mantequilla', 'free_product', 120, (select id from products where slug = 'croissant-mantequilla')
           where not exists (select 1 from rewards where name = 'Croissant de regalo')`);
  await q(`insert into coupons(code, name, kind, value_bps, max_uses_per_customer, segment) select 'BIENVENIDA', 'Bienvenida 10%', 'pct', 1000, 1, '{"new_customers_only": true}'
           where not exists (select 1 from coupons where code = 'BIENVENIDA')`);

  await client.query("commit");
  console.info("Seed aplicado correctamente");
} catch (e) {
  await client.query("rollback");
  console.error("Seed falló:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
