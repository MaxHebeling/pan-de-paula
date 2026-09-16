import { notFound } from "next/navigation";
import { isEmailConfigured } from "@pdp/integrations";
import { requireSession, hasPermission } from "@/lib/auth";
import { PageHeader, Card, Badge, LinkButton, Alert, EmptyState } from "@/components/ui";
import { ActionForm } from "@/components/customers/action-form";
import { BirthdayCard } from "@/components/customers/birthday-card";
import { PrintButton } from "@/components/reports/print-button";
import { getCustomer, tierTone } from "@/lib/customers";
import {
  birthdayContext,
  greetingTextFor,
  greetingState,
  GREETING_STATE_TONE,
  CHANNEL_LABELS,
  formatBirthday,
} from "@/lib/birthdays";
import { whatsappNumber } from "@/lib/ops";
import { fmtDate } from "@/lib/format";
import { prepareGreetingAction, sendGreetingAction } from "./actions";
import "@/components/reports/print.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCustomer(id);
  return { title: c ? `Cumpleaños de ${c.full_name}` : "Cumpleaños" };
}

const STATE_LABEL = { pendiente: "Pendiente", preparado: "Preparado", enviado: "Enviado" } as const;

export default async function BirthdayGreetingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession("customers.read");
  const canWrite = hasPermission(session, "customers.write");
  const { id } = await params;
  const c = await getCustomer(id);
  if (!c || c.deleted_at) notFound();

  if (!c.birthday) {
    return (
      <>
        <PageHeader
          title="Saludo de cumpleaños"
          subtitle={c.full_name}
          actions={
            <LinkButton href={`/clientes/${c.id}`} variant="secondary">
              Volver al cliente
            </LinkButton>
          }
        />
        <EmptyState
          title="Este cliente no tiene fecha de nacimiento"
          body="Sin fecha de nacimiento no hay saludo que preparar. Regístrala en la ficha del cliente y vuelve aquí."
          action={
            canWrite ? (
              <LinkButton href={`/clientes/${c.id}/editar`}>Editar cliente</LinkButton>
            ) : undefined
          }
        />
      </>
    );
  }

  const ctx = (await birthdayContext(id))!;
  const message = greetingTextFor(ctx);
  const state = greetingState({
    greeting_generated_at: ctx.greeting?.generated_at ?? null,
    greeting_sent_at: ctx.greeting?.sent_at ?? null,
  });
  const sent = Boolean(ctx.greeting?.sent_at);
  const wa = whatsappNumber(ctx.customer.phone);
  const waHref = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(message)}` : null;
  const emailReady = isEmailConfigured() && Boolean(ctx.customer.email);
  const when =
    ctx.days_left === 0
      ? "Hoy cumple años"
      : ctx.days_left === 1
        ? "Cumple años mañana"
        : ctx.days_left > 1
          ? `Cumple años en ${ctx.days_left} días`
          : ctx.days_left === -1
            ? "Cumplió años ayer"
            : `Cumplió años hace ${Math.abs(ctx.days_left)} días`;

  return (
    <>
      <PageHeader
        title="Saludo de cumpleaños"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{ctx.customer.full_name}</span>
            <span className="font-mono">{ctx.customer.public_code}</span>
            <Badge tone={GREETING_STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
            <span>
              · {when} · {formatBirthday(ctx.celebrates_on)}
              {ctx.age !== null && ` · cumple ${ctx.age}`}
            </span>
          </span>
        }
        actions={
          <>
            <LinkButton href={`/clientes/${ctx.customer.id}`} variant="secondary">
              Volver al cliente
            </LinkButton>
            <PrintButton label="Imprimir tarjeta" />
          </>
        }
      />

      {ctx.customer.birthday.slice(5) === "02-29" && (
        <div className="no-print mb-4">
          <Alert tone="amber">
            Nació un <strong>29 de febrero</strong>. En los años bisiestos se le felicita el 29; en
            los demás, el <strong>28 de febrero</strong>. Este año le toca el{" "}
            {formatBirthday(ctx.celebrates_on)}.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="print-area">
          <BirthdayCard
            fullName={ctx.customer.full_name}
            publicCode={ctx.customer.public_code}
            celebratesOn={ctx.celebrates_on}
            tierName={ctx.customer.tier_name}
            tierColor={ctx.customer.tier_color}
            businessName={ctx.business.name}
            tagline={ctx.business.tagline}
            instagramHandle={ctx.business.instagram_handle}
            message={message}
          />
        </div>

        <div className="no-print flex flex-col gap-4">
          <Card title="Mensaje">
            <p className="mb-2 text-xs text-muted">
              Texto que se copia a WhatsApp o se envía por correo. Se guarda tal cual al preparar el
              saludo.
            </p>
            <pre className="whitespace-pre-wrap rounded-[var(--r-btn)] bg-bg p-3 text-sm">
              {message}
            </pre>
            <ul className="mt-3 flex flex-col gap-1 text-xs text-muted">
              <li>
                Nivel:{" "}
                {ctx.customer.tier_name ? (
                  <Badge tone={tierTone(ctx.customer.tier_color)}>{ctx.customer.tier_name}</Badge>
                ) : (
                  "sin nivel"
                )}
              </li>
              <li>
                {ctx.loyalty.active && ctx.loyalty.birthday_multiplier > 1
                  ? `Programa de puntos activo: hoy acumula ×${ctx.loyalty.birthday_multiplier} (se menciona en el mensaje).`
                  : "Programa de puntos pausado: el mensaje no promete ningún beneficio."}
              </li>
            </ul>
          </Card>

          <Card title="Enviar y registrar">
            {sent ? (
              <Alert tone="green">
                Enviado el {fmtDate(ctx.greeting!.sent_at, "datetime")} por{" "}
                {CHANNEL_LABELS[ctx.greeting!.channel ?? ""] ?? ctx.greeting!.channel}
                {ctx.greeting!.sent_by_name && ` · ${ctx.greeting!.sent_by_name}`}. Un cliente solo
                recibe un saludo por año.
              </Alert>
            ) : !canWrite ? (
              <p className="text-sm text-muted">
                Tu rol puede ver el saludo pero no registrarlo. Pide a un encargado que lo envíe.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {waHref ? (
                  <a
                    href={waHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-wa w-full"
                  >
                    Abrir WhatsApp con el mensaje
                  </a>
                ) : (
                  <p className="st-gray rounded-[var(--r-btn)] px-3 py-2 text-sm">
                    El cliente no tiene teléfono: no se puede abrir WhatsApp.
                  </p>
                )}
                {!ctx.greeting && (
                  <ActionForm
                    action={prepareGreetingAction}
                    submitLabel="Preparar saludo"
                    variant="secondary"
                  >
                    <input type="hidden" name="id" value={ctx.customer.id} />
                  </ActionForm>
                )}
                {wa && (
                  <ActionForm
                    action={sendGreetingAction}
                    submitLabel="Marcar como enviado por WhatsApp"
                    pendingLabel="Registrando…"
                  >
                    <input type="hidden" name="id" value={ctx.customer.id} />
                    <input type="hidden" name="channel" value="whatsapp" />
                  </ActionForm>
                )}
                {emailReady && (
                  <ActionForm
                    action={sendGreetingAction}
                    submitLabel={`Enviar por correo a ${ctx.customer.email}`}
                    pendingLabel="Enviando…"
                    variant="secondary"
                  >
                    <input type="hidden" name="id" value={ctx.customer.id} />
                    <input type="hidden" name="channel" value="email" />
                  </ActionForm>
                )}
                <ActionForm
                  action={sendGreetingAction}
                  submitLabel="Marcar como entregado en persona"
                  pendingLabel="Registrando…"
                  variant="secondary"
                >
                  <input type="hidden" name="id" value={ctx.customer.id} />
                  <input type="hidden" name="channel" value="manual" />
                </ActionForm>
                {!isEmailConfigured() && (
                  <p className="text-xs text-muted">
                    El envío por correo aparece cuando Resend esté configurado (RESEND_API_KEY y
                    EMAIL_FROM). Mientras tanto se saluda por WhatsApp o en mostrador.
                  </p>
                )}
              </div>
            )}
            {ctx.greeting && (
              <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
                Preparado el {fmtDate(ctx.greeting.generated_at, "datetime")}
                {ctx.greeting.generated_by_name && ` por ${ctx.greeting.generated_by_name}`}.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
