/**
 * Invita al portal a clientes que YA existen (típicamente los registrados antes de que el portal
 * existiera). No crea clientes, no duplica y no pisa datos.
 *
 *   bash scripts/invitar-portal.sh production PDP-000002=karla@correo.com --apply
 *   bash scripts/invitar-portal.sh production PDP-000001                       (simulación)
 *
 * Cada argumento identifica a UN cliente por su código público (`PDP-000123`) o por su correo, y
 * opcionalmente `=correo` para capturarle el correo si todavía no tiene. Reglas:
 *
 *  - Si el cliente NO existe → se reporta y no se hace nada. Nunca se da de alta a nadie desde aquí.
 *  - Si ya tiene un correo DISTINTO al indicado → se rehúsa y lo dice. Cambiar el correo de alguien
 *    es cambiar su llave de acceso: eso se hace en el CRM, donde además se revocan sus sesiones.
 *  - El enlace es el mismo de siempre (`createCustomerAccessToken`): un solo uso, caduca pronto y en
 *    la base solo vive su sha256. Aquí nunca se imprime el enlace ni el token.
 *  - Sin `--apply` no escribe nada: dice exactamente qué haría.
 *
 * El correo se manda con el remitente configurado (Resend). Si no hay proveedor de correo, se avisa:
 * el enlace se entrega desde la ficha del cliente en el CRM.
 */
import { createDb, sql } from "@pdp/db";
import { createCustomerAccessToken } from "@pdp/auth/customer";
import { isEmailConfigured, sendPortalAccessEmail } from "@pdp/integrations";

type Destino = { clave: string; correoNuevo: string | null };

function parseArgs(argv: string[]): { destinos: Destino[]; apply: boolean } {
  const apply = argv.includes("--apply");
  const destinos = argv
    .filter((a) => a !== "--apply")
    .map((a) => {
      const [clave, correo] = a.split("=");
      return { clave: (clave ?? "").trim(), correoNuevo: correo?.trim().toLowerCase() || null };
    })
    .filter((d) => d.clave);
  if (!destinos.length)
    throw new Error("Uso: invitar-portal.sh <entorno> <PDP-000123[=correo]>… [--apply]");
  return { destinos, apply };
}

type Cliente = {
  id: string;
  public_code: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  birthday: string | null;
};

async function main() {
  const { destinos, apply } = parseArgs(process.argv.slice(2));
  /*
   * Sin `ssl`: `createDb` lo resuelve con el entorno (DATABASE_SSL + DATABASE_CA_CERT). Pasarle
   * `ssl: true` a mano descartaba la CA de Supabase y la conexión moría con "self-signed certificate
   * in certificate chain".
   */
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    /*
     * Quién queda como autor en la auditoría: alguien del equipo que PODRÍA hacer esto desde el CRM,
     * es decir con permiso sobre clientes. Se prefiere SEED_ADMIN_EMAIL si está definido y, si no, el
     * rol de mayor rango. Antes se exigía el rol `owner` y en producción no existe (es `super_admin`),
     * así que el script no arrancaba.
     */
    const staff = await sql<{ id: string; email: string }>`
      select u.id, u.email::text as email
        from staff_users u
        join roles r on r.key = u.role_key
       where u.is_active and u.deleted_at is null
         and exists (select 1 from role_permissions rp
                      where rp.role_key = u.role_key and rp.permission_key = 'customers.write')
       order by (u.email = ${process.env.SEED_ADMIN_EMAIL ?? ""}) desc, r.rank desc, u.created_at
       limit 1`.execute(db);
    const staffId = staff.rows[0]?.id ?? null;
    if (!staffId) throw new Error("No hay ningún usuario del equipo para registrar la operación");

    console.log(
      `▶ ${apply ? "APLICANDO" : "Simulación"} en ${process.env.APP_ENV ?? "local"} · operación a nombre de ${staff.rows[0]!.email}`,
    );
    if (!isEmailConfigured())
      console.log(
        "· Sin proveedor de correo configurado: el enlace no se podrá enviar desde aquí.",
      );

    for (const d of destinos) {
      const esCodigo = /^PDP-\d+$/i.test(d.clave);
      const r = await sql<Cliente>`
        select id, public_code, full_name, email::text as email, phone::text as phone,
               to_char(birthday, 'YYYY-MM-DD') as birthday
          from customers
         where deleted_at is null and merged_into_id is null
           and (${esCodigo} and upper(public_code) = upper(${d.clave})
                or not ${esCodigo} and email = ${d.clave.toLowerCase()})
         limit 1`.execute(db);
      const c = r.rows[0];
      if (!c) {
        console.log(`✗ ${d.clave}: no existe ningún cliente con esa clave. No se crea nada.`);
        continue;
      }
      console.log(`\n· ${c.public_code} — ${c.full_name}`);

      // 1) Correo: solo se RELLENA si está vacío. Nunca se reemplaza uno existente.
      let correo = c.email;
      if (d.correoNuevo && c.email && c.email !== d.correoNuevo) {
        console.log(
          `  ✗ ya tiene el correo ${c.email}, distinto de ${d.correoNuevo}. Cambiarlo es cambiar su acceso: hazlo en el CRM.`,
        );
        continue;
      }
      if (d.correoNuevo && !c.email) {
        console.log(`  · correo a capturar: ${d.correoNuevo}`);
        if (apply) {
          await db.transaction().execute(async (trx) => {
            await sql`select set_config('app.staff_id', ${staffId}, true)`.execute(trx);
            await sql`update customers set email = ${d.correoNuevo} where id = ${c.id}`.execute(
              trx,
            );
          });
          correo = d.correoNuevo;
          console.log(
            "  ✔ correo capturado (queda en audit_logs; su historial y su QR no se tocan)",
          );
        } else {
          correo = d.correoNuevo;
        }
      }
      if (!correo) {
        console.log("  ✗ sin correo: no se le puede mandar el enlace. Captúraselo primero.");
        continue;
      }

      // 2) Lo que le falta, para pedírselo (no se inventa nada).
      const faltan = await sql<{ f: string[] }>`select customer_missing_fields(${c.id}::uuid) as f`
        .execute(db)
        .then((x) => x.rows[0]!.f.filter((k) => k !== "email"));
      if (faltan.length)
        console.log(`  · datos pendientes: ${faltan.join(", ")} (los completa él en su portal)`);

      // 3) Enlace de acceso + correo.
      if (!apply) {
        console.log(`  · se le enviaría su enlace de acceso a ${correo}`);
        continue;
      }
      const token = await db.transaction().execute(async (trx) => {
        await sql`select set_config('app.staff_id', ${staffId}, true)`.execute(trx);
        return createCustomerAccessToken(trx, {
          customerId: c.id,
          requestedBy: "staff",
          staffId,
          ip: null,
        });
      });
      const minutos = Math.max(1, Math.round((token.expiresAt.getTime() - Date.now()) / 60_000));
      const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.pandepaula.com";
      const biz = await sql<{
        name: string;
      }>`select name from business_settings where id = 1`.execute(db);
      const res = await sendPortalAccessEmail(correo, {
        businessName: biz.rows[0]?.name ?? "El Pan de Paula",
        firstName: c.full_name.split(/\s+/)[0] ?? c.full_name,
        link: `${base}/portal/acceso?t=${encodeURIComponent(token.token)}`,
        minutes: minutos,
        siteUrl: base,
      });
      console.log(
        res.sent
          ? `  ✔ enlace enviado a ${correo} (vence en ${minutos} min, un solo uso)`
          : `  ✗ el enlace quedó creado pero el correo no salió: ${res.error ?? res.skipped}`,
      );
    }
    if (!apply)
      console.log("\n· Simulación: no se escribió nada. Para aplicar, repite con --apply");
  } finally {
    await db.destroy();
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
