/**
 * Almacenamiento de imágenes de productos y categorías.
 * Drivers (STORAGE_DRIVER):
 *  - local:    escribe en apps/admin/public/uploads/<folder>/<uuid>.<ext> y devuelve la URL absoluta del admin
 *              (NEXT_PUBLIC_ADMIN_URL) para que el sitio público también la vea en desarrollo.
 *  - supabase: Supabase Storage REST (bucket público). Requiere SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fetchWithResilience } from "./http.ts";

export type UploadInput = {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  folder?: string;
};
export type UploadResult = { url: string; key: string };

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXT: Record<(typeof ALLOWED_IMAGE_TYPES)[number], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

/** Tipo real según los primeros bytes (el content-type del navegador se puede falsificar renombrando el archivo). */
export function sniffImageType(bytes: Uint8Array): (typeof ALLOWED_IMAGE_TYPES)[number] | null {
  const b = bytes;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return "image/png";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  // ISO-BMFF: [size:4]['ftyp'][brand:4] con marca avif/avis
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12)))
    return "image/avif";
  return null;
}

export function validateImage(input: Pick<UploadInput, "bytes" | "contentType">): void {
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(input.contentType))
    throw new Error("Formato de imagen no permitido (usa JPG, PNG, WebP o AVIF)");
  if (input.bytes.byteLength === 0) throw new Error("La imagen está vacía");
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("La imagen supera 5 MB");
  const real = sniffImageType(input.bytes);
  if (real === null) throw new Error("El archivo no es una imagen válida (JPG, PNG, WebP o AVIF)");
  if (real !== input.contentType)
    throw new Error(
      `El archivo dice ser ${input.contentType} pero su contenido es ${real}; súbelo con su extensión real`,
    );
}

export type StorageDriver = "local" | "supabase";

export type StorageConfig = {
  driver: StorageDriver;
  /** local: carpeta raíz pública (…/apps/admin/public). */
  localRoot: string;
  /** local: base pública de la URL devuelta (NEXT_PUBLIC_ADMIN_URL). */
  publicBaseUrl: string;
  /** supabase */
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  bucket: string;
};

/** Carpeta `public` del admin resuelta desde el cwd (Next corre con cwd = apps/admin) o desde la raíz del monorepo. */
export function defaultLocalRoot(cwd = process.cwd()): string {
  const base = cwd.replace(/[\\/]+$/, "");
  if (/[\\/]apps[\\/]admin$/.test(base)) return join(base, "public");
  return join(base, "apps", "admin", "public");
}

export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const driver = (env.STORAGE_DRIVER ?? "local") as StorageDriver;
  if (driver !== "local" && driver !== "supabase")
    throw new Error(`STORAGE_DRIVER inválido: "${env.STORAGE_DRIVER}" (usa local | supabase)`);
  return {
    driver,
    localRoot: env.STORAGE_LOCAL_ROOT ?? defaultLocalRoot(),
    publicBaseUrl: (env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3001").replace(/\/+$/, ""),
    supabaseUrl: env.SUPABASE_URL?.replace(/\/+$/, ""),
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.SUPABASE_STORAGE_BUCKET ?? "product-images",
  };
}

function safeFolder(folder: string | undefined): string {
  const f = (folder ?? "products").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9/_-]{0,60}$/.test(f) || f.includes("..") || f.endsWith("/"))
    throw new Error(`Carpeta de almacenamiento inválida: "${folder}"`);
  return f;
}

function buildKey(input: UploadInput): string {
  const ext = EXT[input.contentType as keyof typeof EXT];
  return `${safeFolder(input.folder)}/${randomUUID()}.${ext}`;
}

/** Valida que una clave (devuelta por uploadImage) sea segura para borrar. */
function assertKey(key: string): void {
  if (!/^[a-z0-9][a-z0-9/_-]*\/[0-9a-f-]{36}\.(jpg|png|webp|avif)$/.test(key) || key.includes(".."))
    throw new Error(`Clave de imagen inválida: "${key}"`);
}

export function publicUrlForKey(key: string, cfg: StorageConfig = storageConfigFromEnv()): string {
  if (cfg.driver === "supabase") {
    return `${cfg.supabaseUrl}/storage/v1/object/public/${cfg.bucket}/${key}`;
  }
  return `${cfg.publicBaseUrl}/uploads/${key}`;
}

// ── Driver local ─────────────────────────────────────────────────────────────
async function localUpload(input: UploadInput, cfg: StorageConfig): Promise<UploadResult> {
  const key = buildKey(input);
  const root = resolve(cfg.localRoot, "uploads");
  const path = resolve(root, key);
  if (!path.startsWith(root + sep))
    throw new Error("Ruta de almacenamiento fuera de la carpeta permitida");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.bytes, { flag: "wx" });
  return { key, url: publicUrlForKey(key, cfg) };
}

async function localDelete(key: string, cfg: StorageConfig): Promise<void> {
  assertKey(key);
  const root = resolve(cfg.localRoot, "uploads");
  const path = resolve(root, key);
  if (!path.startsWith(root + sep))
    throw new Error("Ruta de almacenamiento fuera de la carpeta permitida");
  try {
    await unlink(path);
  } catch (e) {
    // Si ya no existe, el estado deseado (ausente) se cumple; cualquier otro error sí se propaga.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

// ── Driver Supabase Storage ──────────────────────────────────────────────────
function requireSupabase(cfg: StorageConfig): { url: string; key: string } {
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey)
    throw new Error(
      "Storage Supabase no configurado: faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY",
    );
  return { url: cfg.supabaseUrl, key: cfg.supabaseServiceRoleKey };
}

async function supabaseUpload(input: UploadInput, cfg: StorageConfig): Promise<UploadResult> {
  const sb = requireSupabase(cfg);
  const key = buildKey(input);
  const res = await fetchWithResilience(`${sb.url}/storage/v1/object/${cfg.bucket}/${key}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sb.key}`,
      "Content-Type": input.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "x-upsert": "false",
    },
    body: input.bytes as unknown as BodyInit,
    idempotent: true,
    timeoutMs: 20_000,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase Storage rechazó la subida (${res.status}): ${body.slice(0, 300)}`);
  }
  return { key, url: publicUrlForKey(key, cfg) };
}

async function supabaseDelete(key: string, cfg: StorageConfig): Promise<void> {
  assertKey(key);
  const sb = requireSupabase(cfg);
  const res = await fetchWithResilience(`${sb.url}/storage/v1/object/${cfg.bucket}/${key}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sb.key}` },
    idempotent: true,
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase Storage no pudo borrar (${res.status}): ${body.slice(0, 300)}`);
  }
}

// ── API pública ──────────────────────────────────────────────────────────────
export async function uploadImage(
  input: UploadInput,
  cfg: StorageConfig = storageConfigFromEnv(),
): Promise<UploadResult> {
  validateImage(input);
  return cfg.driver === "supabase" ? supabaseUpload(input, cfg) : localUpload(input, cfg);
}

export async function deleteImage(
  key: string,
  cfg: StorageConfig = storageConfigFromEnv(),
): Promise<void> {
  return cfg.driver === "supabase" ? supabaseDelete(key, cfg) : localDelete(key, cfg);
}

/** Extrae la clave de almacenamiento a partir de una URL devuelta por uploadImage (o null si no es nuestra). */
export function keyFromUrl(
  url: string,
  cfg: StorageConfig = storageConfigFromEnv(),
): string | null {
  const prefixes = [
    `${cfg.publicBaseUrl}/uploads/`,
    cfg.supabaseUrl ? `${cfg.supabaseUrl}/storage/v1/object/public/${cfg.bucket}/` : null,
  ].filter((p): p is string => Boolean(p));
  for (const p of prefixes) {
    if (url.startsWith(p)) {
      const key = url.slice(p.length).split("?")[0] ?? "";
      try {
        assertKey(key);
        return key;
      } catch {
        return null;
      }
    }
  }
  // URL relativa /uploads/... (por si se guardó sin host)
  if (url.startsWith("/uploads/")) {
    const key = url.slice("/uploads/".length).split("?")[0] ?? "";
    try {
      assertKey(key);
      return key;
    } catch {
      return null;
    }
  }
  return null;
}
