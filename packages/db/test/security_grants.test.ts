import { afterAll, describe, expect, it } from "vitest";
import { testDb, sql } from "./helpers.ts";

const { db, pool } = testDb();
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("superficie expuesta a anon/authenticated (PostgREST)", () => {
  it("ninguna función de negocio de public es ejecutable por anon ni authenticated", async () => {
    const r = await sql<{ name: string }>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`.execute(
      db,
    );
    expect(r.rows.map((x) => x.name)).toEqual([]);
  });
  it("ninguna tabla de public es legible por anon ni authenticated y todas tienen RLS", async () => {
    const t = await sql<{ name: string }>`
      select tablename as name from pg_tables where schemaname = 'public'
        and (has_table_privilege('anon', format('%I.%I', schemaname, tablename), 'select') or has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'select'))`.execute(
      db,
    );
    expect(t.rows.map((x) => x.name)).toEqual([]);
    const rls = await sql<{ name: string }>`
      select t.tablename as name from pg_tables t where schemaname = 'public'
        and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = t.tablename and c.relrowsecurity)`.execute(
      db,
    );
    expect(rls.rows.map((x) => x.name)).toEqual([]);
  });
  it("pdp_app conserva acceso a todas las tablas y funciones", async () => {
    const t = await sql<{
      n: number;
    }>`select count(*)::int as n from pg_tables where schemaname='public' and not has_table_privilege('pdp_app', format('%I.%I', schemaname, tablename), 'select')`.execute(
      db,
    );
    expect(t.rows[0]!.n).toBe(0);
    const f = await sql<{
      n: number;
    }>`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not has_function_privilege('pdp_app', p.oid, 'execute')`.execute(
      db,
    );
    expect(f.rows[0]!.n).toBe(0);
  });
});
