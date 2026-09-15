/**
 * Asigna fotografías a productos existentes por nombre exacto: sube el archivo con el mismo almacenamiento que el
 * admin (uploadImage) y lo registra como imagen principal en product_images.
 *
 * Idempotente y conservador: un producto que ya tiene alguna imagen no se toca (la foto que alguien subió desde el
 * admin manda). Nunca crea productos ni borra imágenes existentes. Si el registro en la base falla después de
 * subir, el archivo recién subido se borra para no dejar huérfanos.
 */
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { sql, type Database } from "@pdp/db";
import {
  deleteImage,
  storageConfigFromEnv,
  uploadImage,
  validateImage,
  type StorageConfig,
  type UploadInput,
} from "./storage.ts";

export type ProductPhotoRow = { product: string; file: string; alt?: string | null };

export type ProductPhotoAction =
  | "attached"
  | "would_attach"
  | "already_has_image"
  | "product_not_found"
  | "ambiguous_product"
  | "error";

export type ProductPhotoResult = {
  product: string;
  file: string;
  action: ProductPhotoAction;
  productId?: string;
  url?: string;
  error?: string;
};

const CONTENT_TYPES: Record<string, UploadInput["contentType"]> = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".avif": "image/avif",
};

export async function attachProductPhotos(o: {
  db: Database;
  dir: string;
  rows: ProductPhotoRow[];
  mode: "dry-run" | "apply";
  storage?: StorageConfig;
}): Promise<ProductPhotoResult[]> {
  const storage = o.storage ?? storageConfigFromEnv();
  const results: ProductPhotoResult[] = [];
  for (const row of o.rows) {
    const base = { product: row.product, file: row.file };
    try {
      const contentType = CONTENT_TYPES[extname(row.file).toLowerCase()];
      if (!contentType) throw new Error(`Extensión no admitida: ${row.file}`);
      const found = await sql<{ id: string; images: number }>`
        select p.id, (select count(*)::int from product_images i where i.product_id = p.id) as images
          from products p
         where p.deleted_at is null and lower(btrim(p.name)) = lower(btrim(${row.product}))`.execute(
        o.db,
      );
      if (found.rows.length === 0) {
        results.push({ ...base, action: "product_not_found" });
        continue;
      }
      if (found.rows.length > 1) {
        results.push({ ...base, action: "ambiguous_product" });
        continue;
      }
      const p = found.rows[0]!;
      if (p.images > 0) {
        results.push({ ...base, productId: p.id, action: "already_has_image" });
        continue;
      }
      const bytes = new Uint8Array(await readFile(join(o.dir, row.file)));
      if (o.mode === "dry-run") {
        // Valida el archivo igual que la subida real, sin escribir nada.
        validateImage({ bytes, contentType });
        results.push({ ...base, productId: p.id, action: "would_attach" });
        continue;
      }
      const up = await uploadImage(
        { bytes, contentType, fileName: row.file, folder: "products" },
        storage,
      );
      try {
        const inserted = await o.db.transaction().execute(async (trx) => {
          // Bloquea el producto: dos corridas simultáneas no pueden dejarle dos imágenes principales.
          await sql`select id from products where id = ${p.id} for update`.execute(trx);
          const again = await sql<{
            n: number;
          }>`select count(*)::int as n from product_images where product_id = ${p.id}`.execute(trx);
          if (again.rows[0]!.n > 0) return false;
          await sql`insert into product_images (product_id, url, alt, sort_order, is_primary)
                    values (${p.id}, ${up.url}, ${row.alt?.trim() || row.product}, 0, true)`.execute(
            trx,
          );
          return true;
        });
        if (!inserted) {
          await deleteImage(up.key, storage);
          results.push({ ...base, productId: p.id, action: "already_has_image" });
          continue;
        }
      } catch (e) {
        await deleteImage(up.key, storage).catch(() => {});
        throw e;
      }
      results.push({ ...base, productId: p.id, action: "attached", url: up.url });
    } catch (e) {
      results.push({ ...base, action: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/** CSV simple con comillas dobles opcionales (el manifiesto lo genera el equipo, no el público). */
export function parseManifest(text: string): ProductPhotoRow[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const head = cells(lines[0] ?? "");
  const iP = head.indexOf("Producto");
  const iF = head.indexOf("Archivo");
  const iA = head.indexOf("Alt");
  if (iP < 0 || iF < 0) throw new Error("El manifiesto necesita las columnas Producto y Archivo");
  return lines.slice(1).map((l) => {
    const c = cells(l);
    return { product: c[iP] ?? "", file: c[iF] ?? "", alt: iA >= 0 ? (c[iA] ?? null) : null };
  });
}
