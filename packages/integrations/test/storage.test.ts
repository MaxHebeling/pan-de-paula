import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteImage,
  defaultLocalRoot,
  keyFromUrl,
  publicUrlForKey,
  storageConfigFromEnv,
  uploadImage,
  validateImage,
  type StorageConfig,
} from "../src/storage.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("validateImage", () => {
  it("acepta formatos permitidos y rechaza el resto", () => {
    expect(() => validateImage({ bytes: PNG, contentType: "image/png" })).not.toThrow();
    expect(() => validateImage({ bytes: PNG, contentType: "image/gif" })).toThrow(/no permitido/);
    expect(() => validateImage({ bytes: PNG, contentType: "application/pdf" })).toThrow();
  });
  it("rechaza vacías y mayores a 5 MB", () => {
    expect(() => validateImage({ bytes: new Uint8Array(0), contentType: "image/png" })).toThrow(
      /vacía/,
    );
    expect(() =>
      validateImage({ bytes: new Uint8Array(5 * 1024 * 1024 + 1), contentType: "image/jpeg" }),
    ).toThrow(/5 MB/);
  });
});

describe("storageConfigFromEnv", () => {
  it("usa local por defecto y normaliza la URL pública", () => {
    const cfg = storageConfigFromEnv({ NEXT_PUBLIC_ADMIN_URL: "http://localhost:3101/" });
    expect(cfg.driver).toBe("local");
    expect(cfg.publicBaseUrl).toBe("http://localhost:3101");
    expect(cfg.bucket).toBe("product-images");
  });
  it("rechaza drivers desconocidos", () => {
    expect(() => storageConfigFromEnv({ STORAGE_DRIVER: "s3" })).toThrow(/STORAGE_DRIVER/);
  });
  it("resuelve la carpeta public del admin desde apps/admin o desde la raíz", () => {
    expect(defaultLocalRoot("/repo/apps/admin")).toBe("/repo/apps/admin/public");
    expect(defaultLocalRoot("/repo")).toBe("/repo/apps/admin/public");
  });
});

describe("driver local", () => {
  let root: string;
  let cfg: StorageConfig;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pdp-storage-"));
    cfg = {
      driver: "local",
      localRoot: root,
      publicBaseUrl: "http://localhost:3101",
      bucket: "product-images",
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("escribe el archivo en public/uploads/<folder>/<uuid>.<ext> y devuelve URL absoluta", async () => {
    const r = await uploadImage(
      { bytes: PNG, contentType: "image/png", fileName: "foto.png", folder: "products" },
      cfg,
    );
    expect(r.key).toMatch(/^products\/[0-9a-f-]{36}\.png$/);
    expect(r.url).toBe(`http://localhost:3101/uploads/${r.key}`);
    const written = await readFile(join(root, "uploads", r.key));
    expect(new Uint8Array(written)).toEqual(PNG);
  });

  it("usa la carpeta products por defecto y mapea jpeg → .jpg", async () => {
    const r = await uploadImage({ bytes: PNG, contentType: "image/jpeg", fileName: "x" }, cfg);
    expect(r.key).toMatch(/^products\/.+\.jpg$/);
  });

  it("rechaza carpetas con traversal o caracteres inválidos", async () => {
    await expect(
      uploadImage({ bytes: PNG, contentType: "image/png", fileName: "x", folder: "../etc" }, cfg),
    ).rejects.toThrow(/Carpeta/);
    await expect(
      uploadImage(
        { bytes: PNG, contentType: "image/png", fileName: "x", folder: "Con Espacios" },
        cfg,
      ),
    ).rejects.toThrow(/Carpeta/);
  });

  it("valida la imagen antes de escribir", async () => {
    await expect(
      uploadImage({ bytes: PNG, contentType: "text/plain", fileName: "x" }, cfg),
    ).rejects.toThrow(/no permitido/);
  });

  it("borra el archivo y es idempotente si ya no existe", async () => {
    const r = await uploadImage({ bytes: PNG, contentType: "image/webp", fileName: "x" }, cfg);
    await deleteImage(r.key, cfg);
    await expect(stat(join(root, "uploads", r.key))).rejects.toThrow();
    await expect(deleteImage(r.key, cfg)).resolves.toBeUndefined();
  });

  it("no borra claves fuera del formato esperado", async () => {
    await expect(deleteImage("../../.env", cfg)).rejects.toThrow(/inválida/);
    await expect(deleteImage("products/../x.png", cfg)).rejects.toThrow(/inválida/);
  });

  it("keyFromUrl recupera la clave desde la URL pública", async () => {
    const r = await uploadImage({ bytes: PNG, contentType: "image/png", fileName: "x" }, cfg);
    expect(keyFromUrl(r.url, cfg)).toBe(r.key);
    expect(keyFromUrl(`/uploads/${r.key}`, cfg)).toBe(r.key);
    expect(keyFromUrl("https://otro.sitio/img.png", cfg)).toBeNull();
  });
});

describe("driver supabase", () => {
  const cfg: StorageConfig = {
    driver: "supabase",
    localRoot: "/unused",
    publicBaseUrl: "http://localhost:3101",
    supabaseUrl: "https://abc.supabase.co",
    supabaseServiceRoleKey: "service-role-secret",
    bucket: "product-images",
  };
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hace POST al endpoint de Storage con el service role y devuelve la URL pública", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ Key: "ok" }), { status: 200 }));
    const r = await uploadImage(
      { bytes: PNG, contentType: "image/png", fileName: "x", folder: "categories" },
      cfg,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://abc.supabase.co/storage/v1/object/product-images/${r.key}`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer service-role-secret");
    expect(headers["Content-Type"]).toBe("image/png");
    expect(r.url).toBe(`https://abc.supabase.co/storage/v1/object/public/product-images/${r.key}`);
    expect(publicUrlForKey(r.key, cfg)).toBe(r.url);
  });

  it("propaga el error cuando Storage responde 4xx", async () => {
    fetchMock.mockResolvedValue(new Response("Bucket not found", { status: 404 }));
    await expect(
      uploadImage({ bytes: PNG, contentType: "image/png", fileName: "x" }, cfg),
    ).rejects.toThrow(/404/);
  });

  it("borra con DELETE y tolera 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await deleteImage("products/0f0e6c2a-1c1e-4a7e-9d1b-3a2b1c0d9e8f.png", cfg);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://abc.supabase.co/storage/v1/object/product-images/products/0f0e6c2a-1c1e-4a7e-9d1b-3a2b1c0d9e8f.png",
    );
    expect(init.method).toBe("DELETE");
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(
      deleteImage("products/0f0e6c2a-1c1e-4a7e-9d1b-3a2b1c0d9e8f.png", cfg),
    ).resolves.toBeUndefined();
  });

  it("falla claro si faltan credenciales", async () => {
    await expect(
      uploadImage(
        { bytes: PNG, contentType: "image/png", fileName: "x" },
        { ...cfg, supabaseServiceRoleKey: undefined },
      ),
    ).rejects.toThrow(/no configurado/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
