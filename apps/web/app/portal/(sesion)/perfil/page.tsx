import { notFound } from "next/navigation";
import { resolveTier } from "@pdp/domain";
import { TierBadge } from "@/components/portal/TierBadge";
import { dateTimeMX } from "@/lib/format";
import { listTiers } from "@/lib/loyalty";
import { getPortalCustomer, SOURCE_LABELS } from "@/lib/portal/data";
import { requireCustomerSession } from "@/lib/portal/session";
import { getBusiness, whatsappLink } from "@/lib/site";

export const metadata = { title: "Mi perfil", robots: { index: false, follow: false } };

export default async function PortalProfilePage() {
  const session = await requireCustomerSession();
  const customer = await getPortalCustomer(session.customer.id);
  if (!customer) notFound();
  const [business, tiers] = await Promise.all([getBusiness(), listTiers()]);
  const resolved = resolveTier(tiers, {
    totalOrders: customer.totalOrders,
    totalSpentCents: customer.totalSpentCents,
    lifetimePoints: customer.lifetimePoints,
  });
  const current = tiers.find((t) => t.key === (customer.tierKey ?? resolved?.key)) ?? null;
  const wa = whatsappLink(business, "Hola, quiero actualizar mis datos del club");

  const birthday = customer.birthday
    ? new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", timeZone: "UTC" }).format(
        new Date(`${customer.birthday}T00:00:00Z`),
      )
    : null;

  return (
    <div className="space-y-6">
      <section className="card p-5 sm:p-6">
        <h1 className="font-display text-2xl text-ink">Mi perfil</h1>
        <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field label="Nombre" value={customer.fullName} testId="perfil-nombre" />
          <Field label="Correo" value={customer.email ?? "—"} testId="perfil-correo" />
          <Field label="Teléfono" value={customer.phone ?? "No registrado"} />
          <Field label="Cumpleaños" value={birthday ?? "No registrado"} />
        </dl>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">Tu tarjeta del club</h2>
        <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field
            label="Código de cliente"
            value={customer.publicCode}
            mono
            testId="perfil-codigo"
          />
          <div>
            <dt className="text-xs tracking-wide text-ink-2 uppercase">Nivel</dt>
            <dd className="mt-1">
              {current ? (
                <TierBadge name={current.name} color={current.color} />
              ) : (
                <span className="text-ink">—</span>
              )}
            </dd>
          </div>
          <Field
            label="Te registraste"
            value={dateTimeMX(customer.createdAt, business.timezone)}
            testId="perfil-alta"
          />
          <Field
            label="Cómo te registraste"
            value={SOURCE_LABELS[customer.source] ?? "Registro del club"}
            testId="perfil-origen"
          />
        </dl>
        {/* El sistema no guarda en qué sucursal se dio de alta un cliente, así que no se muestra
            nada al respecto: preferimos no enseñar un dato antes que inventarlo. */}
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">¿Hay algo que corregir?</h2>
        <p className="mt-2 text-sm text-ink-2">
          Tus datos los cuidamos nosotros. Si cambiaste de correo o de teléfono, dínoslo y lo
          actualizamos en tu misma tarjeta: no pierdes puntos ni historial.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {wa && (
            <a href={wa} target="_blank" rel="noopener noreferrer" className="btn btn-sage">
              Escribirnos por WhatsApp
            </a>
          )}
          {business.email && (
            <a href={`mailto:${business.email}`} className="btn btn-secondary">
              Enviarnos un correo
            </a>
          )}
        </div>
        <p className="mt-4 text-xs text-ink-2">
          Consulta nuestro{" "}
          <a href="/privacidad" className="underline">
            aviso de privacidad
          </a>
          .
        </p>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  testId,
}: {
  label: string;
  value: string;
  mono?: boolean;
  testId?: string;
}) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-ink-2 uppercase">{label}</dt>
      <dd
        className={`mt-1 break-words text-ink ${mono ? "font-mono tracking-widest" : ""}`}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}
