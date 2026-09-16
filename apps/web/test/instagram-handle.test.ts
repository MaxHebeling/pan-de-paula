/**
 * Instagram oficial: @el.pandepaula.
 * El handle vive SOLO en `business_settings.instagram_handle` (se edita en el CRM → Configuración) y la URL
 * se arma en un único lugar (`instagramUrl`). Aquí se verifica: la migración de datos 0016, el armado del
 * enlace (incluido el punto del handle) y que no quede el handle viejo escrito a mano en el código.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, sql, type Database } from "@pdp/db";
import { instagramUrl } from "../lib/site.ts";
import { webTestDatabaseUrl } from "./db-url.ts";

const HANDLE = "el.pandepaula";
let db: Database;
let pool: { end: () => Promise<void> };

beforeAll(() => {
  ({ db, pool } = createDb({ connectionString: webTestDatabaseUrl(), ssl: false, max: 2 }));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("handle de Instagram centralizado", () => {
  it("la base migrada trae el handle oficial en business_settings", async () => {
    const r = await sql<{
      instagram_handle: string | null;
    }>`select instagram_handle from business_settings where id = 1`.execute(db);
    expect(r.rows[0]!.instagram_handle).toBe(HANDLE);
  });

  it("la migración de datos es idempotente y no pisa un handle puesto a mano", async () => {
    await sql`update business_settings set instagram_handle = 'otra.cuenta' where id = 1`.execute(
      db,
    );
    await sql`update business_settings set instagram_handle = ${HANDLE} where id = 1
              and coalesce(instagram_handle, '') in ('', 'elpandepaula', '@elpandepaula')`.execute(
      db,
    );
    let r = await sql<{
      h: string | null;
    }>`select instagram_handle as h from business_settings where id = 1`.execute(db);
    expect(r.rows[0]!.h).toBe("otra.cuenta");

    await sql`update business_settings set instagram_handle = 'elpandepaula' where id = 1`.execute(
      db,
    );
    await sql`update business_settings set instagram_handle = ${HANDLE} where id = 1
              and coalesce(instagram_handle, '') in ('', 'elpandepaula', '@elpandepaula')`.execute(
      db,
    );
    r = await sql<{
      h: string | null;
    }>`select instagram_handle as h from business_settings where id = 1`.execute(db);
    expect(r.rows[0]!.h).toBe(HANDLE);
  });

  it("instagramUrl arma el enlace del perfil respetando el punto del handle", () => {
    expect(instagramUrl(HANDLE)).toBe(`https://www.instagram.com/${HANDLE}/`);
    expect(instagramUrl(`@${HANDLE}`)).toBe(`https://www.instagram.com/${HANDLE}/`);
    expect(instagramUrl(`  ${HANDLE}  `)).toBe(`https://www.instagram.com/${HANDLE}/`);
    expect(instagramUrl(null)).toBeNull();
    expect(instagramUrl("")).toBeNull();
    expect(instagramUrl("   ")).toBeNull();
  });

  it("nadie arma la URL de Instagram fuera de instagramUrl ni escribe el handle a mano", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const skipDirs = new Set(["node_modules", ".next", ".git", "dist", ".turbo", "coverage"]);
    const exts = [".ts", ".tsx", ".sql", ".mjs", ".js"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        if (skipDirs.has(e)) continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (exts.some((x) => e.endsWith(x))) files.push(p);
      }
    };
    for (const d of ["apps", "packages", "scripts"]) walk(join(root, d));

    // Handle viejo escrito a mano ("elpandepaula" sin punto, entre comillas o tras @). El dominio
    // elpandepaula.mx y el correo admin@elpandepaula.local quedan fuera por el lookahead.
    // La migración 0016 y esta prueba sí lo nombran: es justo el valor que corrigen/vigilan.
    const staleAllowed = [
      join("packages", "db", "migrations", "0016_instagram_handle.sql"),
      "instagram-handle.test.ts",
    ];
    const stale = files.filter(
      (f) =>
        /['"`@]elpandepaula(?![.\w])/.test(readFileSync(f, "utf8")) &&
        !staleAllowed.some((a) => f.endsWith(a)),
    );
    expect(stale.map((f) => f.slice(root.length + 1))).toEqual([]);

    // La URL del perfil solo se arma en lib/site.ts (y se comprueba en este test).
    const allowed = [join("apps", "web", "lib", "site.ts"), "instagram-handle.test.ts"];
    const builders = files.filter(
      (f) =>
        /instagram\.com\/\$\{/.test(readFileSync(f, "utf8")) && !allowed.some((a) => f.endsWith(a)),
    );
    expect(builders.map((f) => f.slice(root.length + 1))).toEqual([]);
  });
});
