import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { tierProgress } from "@pdp/domain";
import { requireSession, hasPermission } from "@/lib/auth";
import { PageHeader, Card, Stat, Badge, Money, LinkButton, Alert } from "@/components/ui";
import { fmtDate, qty } from "@/lib/format";
import {
  getCustomer,
  customer360,
  loyaltyTiers,
  tierTone,
  EVENT_LABELS,
  TX_LABELS,
  CHANNEL_LABELS,
  ORDER_STATUS_LABELS,
} from "@/lib/customers";
import { ActionForm } from "@/components/customers/action-form";
import { methodLabel, NO_REFERENCE } from "@/components/ops/payment-lines";
import { PortalLinkButton } from "@/components/customers/portal-link";
import {
  adjustPointsAction,
  redeemRewardAction,
  mergeCustomersAction,
  addAddressAction,
  deleteAddressAction,
  setMarketingConsentAction,
  markEventHandledAction,
  generatePortalLinkAction,
} from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCustomer(id);
  return { title: c ? `${c.full_name} · Clientes` : "Cliente" };
}

const REASON_LABEL: Record<string, string> = {
  phone: "mismo teléfono",
  email: "mismo email",
  name: "nombre similar",
};

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession("customers.read");
  const { id } = await params;
  const sp = await searchParams;
  const c = await getCustomer(id);
  if (!c || c.deleted_at) notFound();
  const canWrite = hasPermission(session, "customers.write");
  const [tiers, x] = await Promise.all([loyaltyTiers(), customer360(id)]);
  const domainTiers = tiers.map((t) => ({
    key: t.key,
    name: t.name,
    rank: t.rank,
    minOrders: t.min_orders,
    minSpentCents: t.min_spent_cents,
    minLifetimePoints: t.min_lifetime_points,
  }));
  const current = domainTiers.find((t) => t.key === c.tier_key) ?? null;
  const tierRow = tiers.find((t) => t.key === c.tier_key);
  const stats = {
    totalOrders: c.total_orders,
    totalSpentCents: c.total_spent_cents,
    lifetimePoints: c.lifetime_points,
  };
  const progress = tierProgress(domainTiers, current, stats);
  const pctOrders = progress
    ? Math.min(100, Math.round((c.total_orders / Math.max(1, progress.next.minOrders)) * 100))
    : 100;
  const pctSpend = progress
    ? Math.min(
        100,
        Math.round((c.total_spent_cents / Math.max(1, progress.next.minSpentCents)) * 100),
      )
    : 100;
  const flash = sp.creado
    ? sp.invitado
      ? "Cliente registrado. Le enviamos por correo su enlace para entrar al portal."
      : "Cliente registrado. Para que entre a su portal, mándale su enlace desde esta ficha."
    : sp.existente
      ? "Ya existía un cliente con ese teléfono/email: se muestra el registro existente."
      : sp.actualizado
        ? sp.acceso === "reiniciado"
          ? "Cambios guardados. Al cambiar el correo se cerró su sesión del portal y se anularon sus enlaces anteriores: mándale uno nuevo."
          : "Cambios guardados."
        : sp.fusionado
          ? "Clientes fusionados correctamente."
          : null;
  // Datos que el alta exige hoy y a este cliente le faltan (registro anterior a la regla, o alta de
  // mostrador). No se inventan: se señalan para que alguien los pida y los capture.
  const pendientes = [
    !c.email ? "correo" : null,
    !c.phone ? "celular" : null,
    !c.birthday ? "fecha de nacimiento" : null,
  ].filter(Boolean) as string[];
  const openEvents = x.events.filter((e) => !e.handled_at);
  return (
    <>
      <PageHeader
        title={c.full_name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{c.public_code}</span>
            {tierRow && <Badge tone={tierTone(tierRow.color)}>{tierRow.name}</Badge>}
            <span>· cliente desde {fmtDate(c.created_at, "short")}</span>
            <span>· origen {c.source}</span>
            {c.tags.map((t) => (
              <span key={t} className="st-gray pill px-2 text-xs">
                #{t}
              </span>
            ))}
          </span>
        }
        actions={
          <>
            <LinkButton href={`/clientes/${c.id}/tarjeta`} variant="secondary">
              Tarjeta QR
            </LinkButton>
            {c.birthday && (
              <LinkButton href={`/clientes/${c.id}/cumpleanos`} variant="secondary">
                🎂 Saludo de cumpleaños
              </LinkButton>
            )}
            {canWrite && <LinkButton href={`/clientes/${c.id}/editar`}>Editar</LinkButton>}
          </>
        }
      />
      {flash && (
        <div className="mb-4">
          <Alert tone="green">{flash}</Alert>
        </div>
      )}
      {c.merged_into_id && (
        <div className="mb-4">
          <Alert tone="amber">
            Este registro fue fusionado en{" "}
            <Link href={`/clientes/${c.merged_into_id}`} className="font-semibold underline">
              {c.merged_into_code}
            </Link>
            . Sus compras y puntos viven ahí.
          </Alert>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Puntos"
          value={c.points_balance}
          hint={`${c.lifetime_points} acumulados históricamente`}
        />
        <Stat
          label="Compras"
          value={c.total_orders}
          hint={c.first_purchase_at ? `primera ${fmtDate(c.first_purchase_at)}` : "sin compras"}
        />
        <Stat
          label="Gasto total"
          value={<Money cents={c.total_spent_cents} compact />}
          hint={
            c.total_orders
              ? `ticket promedio ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(c.total_spent_cents / c.total_orders / 100)}`
              : undefined
          }
        />
        <Stat
          label="Última compra"
          value={c.last_purchase_at ? fmtDate(c.last_purchase_at) : "—"}
          hint={c.days_since_purchase !== null ? `hace ${c.days_since_purchase} días` : undefined}
          tone={c.days_since_purchase !== null && c.days_since_purchase > 30 ? "amber" : undefined}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Columna 1: datos, consentimientos, nivel, direcciones */}
        <div className="flex flex-col gap-4">
          <Card title="Datos de contacto">
            {/* Nota fija de la ficha, no un aviso en vivo: sin `role="status"` para no competir con
                los mensajes de las acciones (ajuste de puntos, guardado…). */}
            {pendientes.length > 0 && (
              <p className="st-amber mb-3 rounded-[var(--r-btn)] px-3 py-2 text-xs">
                Datos pendientes: {pendientes.join(", ")}. Pídeselos y captúralos en “Editar”; el
                cliente también puede completarlos desde su portal.
              </p>
            )}
            <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-sm">
              <dt className="text-muted">Celular</dt>
              <dd className="tabular-nums">{c.phone ?? "—"}</dd>
              <dt className="text-muted">Email</dt>
              <dd className="break-all">{c.email ?? "—"}</dd>
              <dt className="text-muted">Nacimiento</dt>
              <dd>
                {c.birthday
                  ? new Intl.DateTimeFormat("es-MX", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                      timeZone: "UTC",
                    }).format(new Date(c.birthday + "T00:00:00Z"))
                  : "—"}
              </dd>
              <dt className="text-muted">Notas</dt>
              <dd className="whitespace-pre-wrap">{c.notes ?? "—"}</dd>
            </dl>
            <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>
                  Marketing:{" "}
                  <Badge tone={c.marketing_consent ? "green" : "gray"}>
                    {c.marketing_consent ? "acepta" : "no acepta"}
                  </Badge>
                  {!c.marketing_consent && c.marketing_opt_out_at && (
                    <span className="ml-1 text-xs text-muted">
                      baja {fmtDate(c.marketing_opt_out_at)}
                    </span>
                  )}
                </span>
                {canWrite && (
                  <ActionForm
                    action={setMarketingConsentAction}
                    inline
                    submitLabel={c.marketing_consent ? "Dar de baja" : "Activar"}
                    variant="secondary"
                    size="sm"
                  >
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="value" value={c.marketing_consent ? "off" : "on"} />
                  </ActionForm>
                )}
              </div>
              <div>
                Avisos operativos:{" "}
                <Badge tone={c.operational_consent ? "green" : "gray"}>
                  {c.operational_consent ? "sí" : "no"}
                </Badge>
              </div>
            </div>
          </Card>

          <Card title="Acceso a su cuenta en el sitio">
            {canWrite ? (
              <PortalLinkButton
                action={generatePortalLinkAction}
                customerId={c.id}
                hasEmail={Boolean(c.email)}
              />
            ) : (
              <p className="text-sm text-muted">
                Solo quien pueda editar clientes genera enlaces de acceso.
              </p>
            )}
          </Card>

          <Card title="Nivel y progreso">
            <p className="text-sm">
              Nivel actual: <strong>{tierRow?.name ?? "Sin nivel"}</strong>
              {tierRow?.perks && <span className="text-muted"> · {tierRow.perks}</span>}
            </p>
            {progress ? (
              <div className="mt-3 flex flex-col gap-3 text-sm">
                <p>
                  Siguiente: <strong>{progress.next.name}</strong>
                  {progress.ordersLeft > 0 && ` · faltan ${progress.ordersLeft} compra(s)`}
                  {progress.spendLeftCents > 0 && (
                    <>
                      {" "}
                      · faltan <Money cents={progress.spendLeftCents} compact />
                    </>
                  )}
                </p>
                <ProgressBar
                  label={`Compras ${c.total_orders}/${progress.next.minOrders}`}
                  pct={pctOrders}
                />
                <ProgressBar
                  label={`Gasto ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(c.total_spent_cents / 100)} / ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(progress.next.minSpentCents / 100)}`}
                  pct={pctSpend}
                />
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">Nivel máximo alcanzado.</p>
            )}
          </Card>

          <Card title="Direcciones">
            {x.addresses.length === 0 ? (
              <p className="text-sm text-muted">Sin direcciones registradas.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {x.addresses.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-2 py-2">
                    <div>
                      <div className="font-medium">
                        {a.label ?? "Dirección"}{" "}
                        {a.is_default && <Badge tone="blue">principal</Badge>}
                      </div>
                      <div>{a.street}</div>
                      <div className="text-muted">
                        {[a.neighborhood, a.city, a.state, a.postal_code]
                          .filter(Boolean)
                          .join(", ")}
                      </div>
                      {a.references_note && (
                        <div className="text-xs text-muted">Ref: {a.references_note}</div>
                      )}
                    </div>
                    {canWrite && (
                      <ActionForm
                        action={deleteAddressAction}
                        inline
                        submitLabel="Quitar"
                        variant="danger"
                        size="sm"
                        confirm="¿Eliminar esta dirección?"
                      >
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="address_id" value={a.id} />
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-teal-d">
                  Agregar dirección
                </summary>
                <ActionForm
                  action={addAddressAction}
                  submitLabel="Guardar dirección"
                  resetOnOk
                  className="mt-2"
                >
                  <input type="hidden" name="id" value={c.id} />
                  <input name="label" className="input" placeholder="Etiqueta (Casa, Oficina)" />
                  <input name="street" className="input" placeholder="Calle y número *" required />
                  <div className="grid grid-cols-2 gap-2">
                    <input name="neighborhood" className="input" placeholder="Colonia" />
                    <input name="postal_code" className="input" placeholder="C.P." />
                    <input
                      name="city"
                      className="input"
                      placeholder="Ciudad"
                      defaultValue="Tijuana"
                    />
                    <input
                      name="state"
                      className="input"
                      placeholder="Estado"
                      defaultValue="Baja California"
                    />
                  </div>
                  <input name="references_note" className="input" placeholder="Referencias" />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="is_default" className="h-4 w-4" /> Principal
                  </label>
                </ActionForm>
              </details>
            )}
          </Card>
        </div>

        {/* Columna 2: puntos, canjes, favoritos */}
        <div className="flex flex-col gap-4">
          {canWrite && !c.merged_into_id && (
            <Card title="Ajustar puntos">
              <ActionForm action={adjustPointsAction} submitLabel="Aplicar ajuste" resetOnOk>
                <input type="hidden" name="id" value={c.id} />
                {/* Idempotencia: un doble envío con la misma clave no suma dos veces */}
                <input type="hidden" name="idempotency_key" value={randomUUID()} />
                <div className="grid grid-cols-[120px_1fr] gap-2">
                  <div>
                    <label className="label" htmlFor="points">
                      Puntos (±)
                    </label>
                    <input
                      id="points"
                      name="points"
                      type="number"
                      step={1}
                      className="input"
                      placeholder="-10 / 25"
                      required
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="reason">
                      Motivo *
                    </label>
                    <input
                      id="reason"
                      name="reason"
                      className="input"
                      placeholder="Cortesía por espera, corrección…"
                      required
                      minLength={3}
                    />
                  </div>
                </div>
              </ActionForm>
            </Card>
          )}
          {canWrite && !c.merged_into_id && (
            <Card title="Canjear recompensa">
              {x.rewards.length === 0 ? (
                <p className="text-sm text-muted">
                  No hay recompensas activas. Configúralas en Fidelización.
                </p>
              ) : (
                <ActionForm
                  action={redeemRewardAction}
                  submitLabel="Canjear"
                  confirm="¿Descontar los puntos y emitir la recompensa?"
                >
                  <input type="hidden" name="id" value={c.id} />
                  <select name="reward_id" className="input" defaultValue="" required>
                    <option value="" disabled>
                      Selecciona…
                    </option>
                    {x.rewards.map((r) => {
                      const locked =
                        r.points_cost > c.points_balance ||
                        (r.min_rank !== null && (tierRow?.rank ?? 0) < r.min_rank);
                      return (
                        <option key={r.id} value={r.id} disabled={locked}>
                          {r.name} · {r.points_cost} pts
                          {locked
                            ? r.points_cost > c.points_balance
                              ? " (puntos insuficientes)"
                              : " (requiere nivel)"
                            : ""}
                        </option>
                      );
                    })}
                  </select>
                </ActionForm>
              )}
            </Card>
          )}
          <Card title="Historial de puntos">
            {x.ledger.length === 0 ? (
              <p className="text-sm text-muted">Aún no hay movimientos.</p>
            ) : (
              <ul className="max-h-[420px] divide-y divide-line overflow-y-auto text-sm">
                {x.ledger.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-2 py-2">
                    <div>
                      <div className="font-medium">
                        {TX_LABELS[l.kind] ?? l.kind}
                        {l.folio && (
                          <span className="ml-1 font-mono text-xs text-muted">{l.folio}</span>
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        {fmtDate(l.created_at, "datetime")}
                        {l.staff_name && ` · ${l.staff_name}`}
                        {l.note && ` · ${l.note}`}
                      </div>
                    </div>
                    <div className="text-right tabular-nums">
                      <div
                        className={
                          l.points >= 0 ? "font-semibold text-green-d" : "font-semibold text-red-d"
                        }
                      >
                        {l.points > 0 ? "+" : ""}
                        {l.points}
                      </div>
                      <div className="text-xs text-muted">saldo {l.balance_after}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Favoritos">
            {x.favorites.length === 0 ? (
              <p className="text-sm text-muted">Sin compras registradas.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {x.favorites.map((f) => (
                  <li key={f.name} className="flex items-center justify-between py-1.5">
                    <span>{f.name}</span>
                    <span className="tabular-nums text-muted">
                      {qty(f.units)} uds · <Money cents={f.revenue} compact />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Canjes y cupones">
            {x.redemptions.length === 0 && x.coupons.length === 0 ? (
              <p className="text-sm text-muted">Sin canjes ni cupones usados.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {x.redemptions.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span>
                      {r.reward_name} <span className="font-mono text-xs text-muted">{r.code}</span>
                      {r.folio && (
                        <span className="ml-1 font-mono text-xs text-muted">{r.folio}</span>
                      )}
                    </span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className="tabular-nums text-muted">−{r.points_spent} pts</span>
                      <Badge
                        tone={
                          r.status === "applied" ? "green" : r.status === "issued" ? "blue" : "gray"
                        }
                      >
                        {r.status === "applied"
                          ? "aplicado"
                          : r.status === "issued"
                            ? "emitido"
                            : r.status === "cancelled"
                              ? "cancelado"
                              : "vencido"}
                      </Badge>
                    </span>
                  </li>
                ))}
                {x.coupons.map((cp, i) => (
                  <li
                    key={`${cp.code}-${i}`}
                    className="flex items-center justify-between gap-2 py-1.5"
                  >
                    <span>
                      Cupón <span className="font-mono">{cp.code}</span>
                      {cp.folio && (
                        <span className="ml-1 font-mono text-xs text-muted">{cp.folio}</span>
                      )}
                    </span>
                    <span className="text-xs text-muted">
                      −<Money cents={cp.discount_cents} compact /> · {fmtDate(cp.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Columna 3: pedidos, eventos, duplicados */}
        <div className="flex flex-col gap-4">
          <Card title="Pedidos y ventas">
            {x.orders.length === 0 ? (
              <p className="text-sm text-muted">Este cliente aún no tiene pedidos.</p>
            ) : (
              <ul className="max-h-[520px] divide-y divide-line overflow-y-auto text-sm">
                {x.orders.map((o) => (
                  <li key={o.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs">{o.folio}</span>
                      <span className="flex items-center gap-1.5">
                        <Badge tone="blue">{CHANNEL_LABELS[o.channel] ?? o.channel}</Badge>
                        <Badge
                          tone={
                            o.voided_at
                              ? "red"
                              : o.status === "completed" || o.status === "delivered"
                                ? "green"
                                : o.status === "cancelled" || o.status === "refunded"
                                  ? "red"
                                  : "amber"
                          }
                        >
                          {o.voided_at ? "Anulada" : (ORDER_STATUS_LABELS[o.status] ?? o.status)}
                        </Badge>
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="truncate text-muted" title={o.summary ?? ""}>
                        {o.summary ?? `${qty(o.items)} artículos`}
                      </span>
                      <span className="whitespace-nowrap tabular-nums">
                        <Money cents={o.total_cents} />
                        {o.points > 0 && (
                          <span className="ml-1 text-xs text-green-d">+{o.points} pts</span>
                        )}
                      </span>
                    </div>
                    <div className="text-xs text-muted">{fmtDate(o.placed_at, "datetime")}</div>
                    {(o.payments ?? []).length > 0 && (
                      <ul className="text-xs text-muted" data-testid="payment-lines">
                        {(o.payments ?? []).map((p) => (
                          <li key={p.id}>
                            {methodLabel(p.method)} <Money cents={p.amountCents} compact /> · ref.{" "}
                            <span className={p.reference ? "font-mono text-ink" : ""}>
                              {p.reference ?? NO_REFERENCE}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Eventos${openEvents.length ? ` · ${openEvents.length} pendientes` : ""}`}>
            {x.events.length === 0 ? (
              <p className="text-sm text-muted">Sin eventos (cumpleaños, hitos, inactividad).</p>
            ) : (
              <ul className="max-h-[300px] divide-y divide-line overflow-y-auto text-sm">
                {x.events.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 py-1.5">
                    <div>
                      <div className={e.handled_at ? "text-muted" : "font-medium"}>
                        {EVENT_LABELS[e.kind] ?? e.kind}
                      </div>
                      <div className="text-xs text-muted">
                        {fmtDate(e.created_at)}
                        {typeof e.payload.days === "number" && ` · ${e.payload.days} días`}
                        {typeof e.payload.from === "string" && ` · ${e.payload.from}`}
                        {typeof e.payload.to === "string" && ` → ${e.payload.to}`}
                      </div>
                    </div>
                    {!e.handled_at && canWrite && (
                      <ActionForm
                        action={markEventHandledAction}
                        inline
                        submitLabel="Atendido"
                        variant="secondary"
                        size="sm"
                      >
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="event_id" value={e.id} />
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {!c.merged_into_id && (
            <Card title="Posibles duplicados">
              {x.duplicates.length === 0 ? (
                <p className="text-sm text-muted">
                  No se detectaron duplicados por teléfono, email o nombre.
                </p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {x.duplicates.map((d) => (
                    <li key={d.id} className="py-2">
                      <div className="flex items-center justify-between gap-2">
                        <Link href={`/clientes/${d.id}`} className="font-medium hover:underline">
                          {d.full_name}{" "}
                          <span className="font-mono text-xs text-muted">{d.public_code}</span>
                        </Link>
                        <span className="text-xs text-muted">
                          {d.total_orders} compras · {d.points_balance} pts
                        </span>
                      </div>
                      <div className="text-xs text-muted">
                        {d.phone ?? ""} {d.email ?? ""} ·{" "}
                        {d.reasons.map((r) => REASON_LABEL[r] ?? r).join(", ")}
                      </div>
                      {canWrite && (
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          <ActionForm
                            action={mergeCustomersAction}
                            inline
                            submitLabel={`Fusionar aquí (conservar ${c.public_code})`}
                            variant="secondary"
                            size="sm"
                            confirm={`Se moverán pedidos, puntos y datos de ${d.public_code} a ${c.public_code}. Esta acción no se puede deshacer. ¿Continuar?`}
                          >
                            <input type="hidden" name="keep_id" value={c.id} />
                            <input type="hidden" name="merge_id" value={d.id} />
                          </ActionForm>
                          <ActionForm
                            action={mergeCustomersAction}
                            inline
                            submitLabel={`Conservar ${d.public_code}`}
                            variant="secondary"
                            size="sm"
                            confirm={`Se moverán pedidos, puntos y datos de ${c.public_code} a ${d.public_code}. Esta acción no se puede deshacer. ¿Continuar?`}
                          >
                            <input type="hidden" name="keep_id" value={d.id} />
                            <input type="hidden" name="merge_id" value={c.id} />
                          </ActionForm>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {x.mergedFrom.length > 0 && (
                <p className="mt-3 border-t border-line pt-2 text-xs text-muted">
                  Registros fusionados en este cliente:{" "}
                  {x.mergedFrom.map((m) => `${m.public_code} (${m.full_name})`).join(", ")}
                </p>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function ProgressBar({ label, pct }: { label: string; pct: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-black/[0.06]"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-teal" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
