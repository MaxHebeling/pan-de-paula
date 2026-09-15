/**
 * Fotos de producto por lote (packages/integrations/src/productPhotos.ts, scripts/fotos-productos.sh):
 * sube con el mismo almacenamiento que el admin, registra la imagen principal, no pisa fotos existentes,
 * es idempotente y no deja archivos huérfanos cuando algo falla.
 */
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, sql, type Database } from "@pdp/db";
import type { StorageConfig } from "@pdp/integrations";
import {
  attachProductPhotos,
  parseManifest,
} from "../../../packages/integrations/src/productPhotos.ts";
import { webTestDatabaseUrl } from "./db-url.ts";

let db: Database;
let pool: { end: () => Promise<void> };
let photos: string;
let storage: StorageConfig;
/** Sufijo por prueba: la base es compartida con otras suites, así que no se trunca nada. */
let run: string;
const n = (name: string) => `${name} ${run}`;

const uploadsDir = () => join(storage.localRoot, "uploads", "products");
const uploadedFiles = () => (existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : []);

async function product(name: string): Promise<string> {
  const r = await sql<{ id: string }>`insert into products (name, slug)
    values (${name}, ${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Math.random().toString(36).slice(2, 7)})
    returning id`.execute(db);
  return r.rows[0]!.id;
}
async function images(productId: string) {
  return (
    await sql<{
      url: string;
      alt: string | null;
      is_primary: boolean;
    }>`select url, alt, is_primary from product_images where product_id = ${productId}`.execute(db)
  ).rows;
}

beforeAll(() => {
  const created = createDb({ connectionString: webTestDatabaseUrl(), ssl: false, max: 2 });
  db = created.db;
  pool = created.pool;
});
beforeEach(async () => {
  run = Math.random().toString(36).slice(2, 8);
  photos = mkdtempSync(join(tmpdir(), "pdp-fotos-"));
  copyFileSync(
    resolve(import.meta.dirname, "../public/editorial/almond-original.webp"),
    join(photos, "croissant.webp"),
  );
  writeFileSync(join(photos, "falsa.webp"), "esto no es una imagen");
  storage = {
    driver: "local",
    localRoot: mkdtempSync(join(tmpdir(), "pdp-storage-")),
    publicBaseUrl: "http://admin.test",
    bucket: "product-images",
  };
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("fotos de producto por lote", () => {
  it("simular no sube ni registra nada y reporta productos inexistentes", async () => {
    const id = await product(n("Croissant Natural"));
    const res = await attachProductPhotos({
      db,
      dir: photos,
      storage,
      mode: "dry-run",
      rows: [
        { product: n("croissant natural"), file: "croissant.webp" },
        { product: n("Pan que no existe"), file: "croissant.webp" },
      ],
    });
    expect(res.map((r) => r.action)).toEqual(["would_attach", "product_not_found"]);
    expect(await images(id)).toEqual([]);
    expect(uploadedFiles()).toEqual([]);
  });

  it("aplicar sube la foto y la deja como principal; repetir no duplica", async () => {
    const id = await product(n("Croissant Natural"));
    const rows = [{ product: n("Croissant Natural"), file: "croissant.webp" }];
    const first = await attachProductPhotos({ db, dir: photos, storage, mode: "apply", rows });
    expect(first[0]).toMatchObject({ action: "attached", productId: id });
    const imgs = await images(id);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({ alt: n("Croissant Natural"), is_primary: true });
    expect(imgs[0]!.url).toMatch(/^http:\/\/admin\.test\/uploads\/products\/[0-9a-f-]{36}\.webp$/);
    expect(uploadedFiles()).toHaveLength(1);

    const again = await attachProductPhotos({ db, dir: photos, storage, mode: "apply", rows });
    expect(again[0]!.action).toBe("already_has_image");
    expect(await images(id)).toHaveLength(1);
    expect(uploadedFiles()).toHaveLength(1);
  });

  it("no toca productos que ya tienen una foto subida desde el admin", async () => {
    const id = await product(n("Crookie"));
    await sql`insert into product_images (product_id, url, is_primary) values (${id}, 'https://x.supabase.co/a.webp', true)`.execute(
      db,
    );
    const res = await attachProductPhotos({
      db,
      dir: photos,
      storage,
      mode: "apply",
      rows: [{ product: n("Crookie"), file: "croissant.webp" }],
    });
    expect(res[0]!.action).toBe("already_has_image");
    expect((await images(id)).map((i) => i.url)).toEqual(["https://x.supabase.co/a.webp"]);
    expect(uploadedFiles()).toEqual([]);
  });

  it("un archivo que no es imagen falla sin registrar ni dejar archivos, y el resto del lote sigue", async () => {
    const bad = await product(n("Chocolatine"));
    const good = await product(n("Croissant Natural"));
    const res = await attachProductPhotos({
      db,
      dir: photos,
      storage,
      mode: "apply",
      rows: [
        { product: n("Chocolatine"), file: "falsa.webp" },
        { product: n("Croissant Natural"), file: "croissant.webp" },
      ],
    });
    expect(res[0]).toMatchObject({ action: "error" });
    expect(res[0]!.error).toMatch(/no es una imagen/i);
    expect(res[1]!.action).toBe("attached");
    expect(await images(bad)).toEqual([]);
    expect(await images(good)).toHaveLength(1);
    expect(uploadedFiles()).toHaveLength(1);
  });

  it("el manifiesto admite comillas, apóstrofos y columnas extra", () => {
    const rows = parseManifest(
      '\uFEFFProducto,Archivo,Original,Alt\r\nGalleta S\'mores,galleta-s-mores.webp,19_Galleta S\'mores.jpg,\r\n"Docena, surtida",docena.webp,x.jpg,"Caja ""regalo"""\n',
    );
    expect(rows).toEqual([
      { product: "Galleta S'mores", file: "galleta-s-mores.webp", alt: "" },
      { product: "Docena, surtida", file: "docena.webp", alt: 'Caja "regalo"' },
    ]);
    expect(() => parseManifest("Nombre,Foto\nA,b.webp")).toThrow(/Producto y Archivo/);
  });
});
