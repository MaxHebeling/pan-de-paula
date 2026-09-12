import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { PageHeader, Card, Badge, Alert } from "@/components/ui";
import { LinkTabs } from "@/components/catalog/tabs";
import { ActionForm, ConfirmButton, SubmitButton } from "@/components/catalog/action-form";
import { Checkbox, FormGrid, Select, TextArea, TextInput } from "@/components/catalog/fields";
import {
  deleteException,
  deletePickup,
  deleteWindow,
  saveBusiness,
  saveException,
  saveHours,
  savePickup,
  saveWindow,
  toggleFlag,
} from "./actions";

export const metadata = { title: "Configuración" };
export const dynamic = "force-dynamic";

const TABS = [
  ["negocio", "Negocio"],
  ["horarios", "Horarios"],
  ["pedidos", "Pedidos"],
  ["calendario", "Calendario"],
  ["retiro", "Puntos de retiro"],
  ["funciones", "Funciones"],
] as const;
type Tab = (typeof TABS)[number][0];

const DAY = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const DAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const FULFILLMENT: Record<string, string> = {
  pickup: "Recoger en mostrador",
  scheduled_pickup: "Recoger con cita",
  delivery: "Entrega a domicilio",
  preorder: "Pedido anticipado",
};
const PAYMENT_FLAGS = new Set([
  "mercadopago_online",
  "mercadopago_point",
  "mercadopago_qr",
  "web_checkout",
]);

const t = (v: string | null) => (v ? v.slice(0, 5) : "");

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireSession("settings.write");
  const sp = await searchParams;
  const tab: Tab = (TABS.find(([k]) => k === sp.tab)?.[0] ?? "negocio") as Tab;

  return (
    <>
      <PageHeader
        title="Configuración"
        subtitle="Datos del negocio, horarios, reglas de pedido y funciones del sistema."
      />
      <LinkTabs
        items={TABS.map(([k, label]) => ({
          href: `/configuracion?tab=${k}`,
          label,
          active: tab === k,
        }))}
      />
      {tab === "negocio" && <BusinessTab />}
      {tab === "horarios" && <HoursTab />}
      {tab === "pedidos" && <WindowsTab />}
      {tab === "calendario" && <CalendarTab />}
      {tab === "retiro" && <PickupTab />}
      {tab === "funciones" && <FlagsTab />}
    </>
  );
}

async function BusinessTab() {
  const b = await db()
    .selectFrom("business_settings")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirstOrThrow();
  const policies = (b.policies ?? {}) as Record<string, string>;
  const zones = Intl.supportedValuesOf("timeZone").filter((z) => z.startsWith("America/"));
  if (!zones.includes(b.timezone)) zones.unshift(b.timezone);
  return (
    <ActionForm action={saveBusiness} className="grid gap-4 xl:grid-cols-2">
      <Card title="Identidad">
        <div className="flex flex-col gap-3">
          <FormGrid>
            <TextInput
              label="Nombre comercial"
              name="name"
              required
              maxLength={80}
              defaultValue={b.name}
            />
            <TextInput
              label="Razón social"
              name="legal_name"
              maxLength={160}
              defaultValue={b.legal_name ?? ""}
            />
          </FormGrid>
          <TextInput label="Lema" name="tagline" maxLength={120} defaultValue={b.tagline ?? ""} />
          <FormGrid>
            <TextInput
              label={b.logo_url ? "Reemplazar logo" : "Logo"}
              name="logo"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
            />
            {b.logo_url && (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={b.logo_url}
                  alt="Logo actual"
                  className="size-14 rounded-lg object-cover"
                />
                <Checkbox label="Quitar logo" name="remove_logo" />
              </div>
            )}
          </FormGrid>
        </div>
      </Card>
      <Card title="Contacto y ubicación">
        <div className="flex flex-col gap-3">
          <TextInput
            label="Dirección"
            name="address"
            maxLength={300}
            defaultValue={b.address ?? ""}
          />
          <FormGrid cols={3}>
            <TextInput label="Ciudad" name="city" maxLength={80} defaultValue={b.city ?? ""} />
            <TextInput label="Estado" name="state" maxLength={80} defaultValue={b.state ?? ""} />
            <TextInput label="País (ISO-2)" name="country" maxLength={2} defaultValue={b.country} />
          </FormGrid>
          <FormGrid>
            <TextInput
              label="Teléfono"
              name="phone"
              inputMode="tel"
              maxLength={30}
              defaultValue={b.phone ?? ""}
            />
            <TextInput
              label="WhatsApp"
              name="whatsapp"
              inputMode="tel"
              maxLength={30}
              defaultValue={b.whatsapp ?? ""}
              hint="Con lada, ej. 6641234567"
            />
            <TextInput label="Email" name="email" type="email" defaultValue={b.email ?? ""} />
            <TextInput
              label="Instagram"
              name="instagram_handle"
              maxLength={40}
              defaultValue={b.instagram_handle ?? ""}
              hint="Sin @"
            />
          </FormGrid>
          <Select label="Zona horaria" name="timezone" defaultValue={b.timezone}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </div>
      </Card>
      <Card title="Impuestos e inventario">
        <div className="flex flex-col gap-3">
          <FormGrid cols={3}>
            <TextInput
              label="IVA (%)"
              name="tax_rate_pct"
              type="number"
              step="0.01"
              min={0}
              max={100}
              defaultValue={(b.tax_rate_bps / 100).toString()}
              hint="16 = 16%. 0 si no desglosas."
            />
            <TextInput
              label="Umbral de stock bajo"
              name="low_stock_threshold"
              type="number"
              step="any"
              min={0}
              defaultValue={String(b.low_stock_threshold)}
              hint="Unidades por producto"
            />
            <TextInput
              label="Anticipación de pedidos (h)"
              name="order_lead_hours"
              type="number"
              min={0}
              max={720}
              defaultValue={b.order_lead_hours}
            />
          </FormGrid>
          <Checkbox
            label="Los precios ya incluyen IVA"
            name="prices_include_tax"
            defaultChecked={b.prices_include_tax}
          />
          <Checkbox
            label="Permitir vender sin existencias"
            name="allow_negative_stock"
            defaultChecked={b.allow_negative_stock}
            hint="Si lo apagas, el POS y la tienda bloquean productos agotados."
          />
        </div>
      </Card>
      <Card title="Políticas (se muestran en la tienda)">
        <div className="flex flex-col gap-3">
          <TextArea
            label="Pedidos"
            name="policy_orders"
            rows={2}
            maxLength={4000}
            defaultValue={policies.orders ?? ""}
          />
          <TextArea
            label="Cancelaciones y cambios"
            name="policy_cancellations"
            rows={2}
            maxLength={4000}
            defaultValue={policies.cancellations ?? ""}
          />
          <TextArea
            label="Entregas"
            name="policy_delivery"
            rows={2}
            maxLength={4000}
            defaultValue={policies.delivery ?? ""}
          />
          <TextArea
            label="Aviso de alérgenos"
            name="policy_allergens"
            rows={2}
            maxLength={4000}
            defaultValue={policies.allergens ?? ""}
          />
        </div>
      </Card>
      <div className="xl:col-span-2">
        <SubmitButton>Guardar negocio</SubmitButton>
      </div>
    </ActionForm>
  );
}

async function HoursTab() {
  const rows = await db().selectFrom("business_hours").selectAll().orderBy("weekday").execute();
  const byDay = new Map(rows.map((r) => [r.weekday, r]));
  return (
    <Card title="Horario de atención">
      <ActionForm action={saveHours} className="flex flex-col gap-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-muted">
            <thead>
              <tr>
                <th>Día</th>
                <th>Abierto</th>
                <th>Abre</th>
                <th>Cierra</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const r = byDay.get(d);
                return (
                  <tr key={d} className="border-t border-line">
                    <td className="font-medium">{DAY[d]}</td>
                    <td>
                      <input
                        type="checkbox"
                        name={`open_${d}`}
                        id={`open_${d}`}
                        defaultChecked={r?.is_open ?? false}
                        className="size-4 accent-[var(--teal)]"
                        aria-label={`${DAY[d]} abierto`}
                      />
                    </td>
                    <td>
                      <input
                        type="time"
                        name={`opens_${d}`}
                        id={`opens_${d}`}
                        defaultValue={t(r?.opens_at ?? null)}
                        className="input !w-36 !py-1.5"
                        aria-label={`${DAY[d]} abre`}
                      />
                    </td>
                    <td>
                      <input
                        type="time"
                        name={`closes_${d}`}
                        id={`closes_${d}`}
                        defaultValue={t(r?.closes_at ?? null)}
                        className="input !w-36 !py-1.5"
                        aria-label={`${DAY[d]} cierra`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div>
          <SubmitButton>Guardar horarios</SubmitButton>
        </div>
      </ActionForm>
    </Card>
  );
}

function WindowForm({
  w,
  id,
}: {
  w?: Awaited<ReturnType<typeof loadWindows>>[number];
  id: string | null;
}) {
  const p = id ? `w-${id}-` : "w-new-";
  return (
    <ActionForm
      action={saveWindow.bind(null, id)}
      resetOnSuccess={!id}
      className="flex flex-col gap-3"
    >
      <FormGrid>
        <TextInput
          label="Nombre"
          name="name"
          id={`${p}name`}
          required
          maxLength={80}
          defaultValue={w?.name ?? ""}
          placeholder="Pedidos de la semana"
        />
        <Select
          label="Tipo de entrega"
          name="fulfillment_type"
          id={`${p}type`}
          defaultValue={w?.fulfillment_type ?? "scheduled_pickup"}
        >
          {Object.entries(FULFILLMENT).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </FormGrid>
      <fieldset>
        <legend className="label">Días en que se reciben pedidos</legend>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <label
              key={d}
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                name="order_weekdays"
                value={d}
                defaultChecked={w?.order_weekdays.includes(d) ?? false}
                className="accent-[var(--teal)]"
              />
              {DAY_SHORT[d]}
            </label>
          ))}
        </div>
      </fieldset>
      <FormGrid cols={4}>
        <TextInput
          label="Hora límite"
          name="cutoff_time"
          id={`${p}cutoff`}
          type="time"
          required
          defaultValue={t(w?.cutoff_time ?? "18:00")}
        />
        <Select
          label="Día de entrega"
          name="fulfillment_weekday"
          id={`${p}fday`}
          defaultValue={String(w?.fulfillment_weekday ?? 5)}
        >
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <option key={d} value={d}>
              {DAY[d]}
            </option>
          ))}
        </Select>
        <TextInput
          label="Entrega desde"
          name="fulfillment_from"
          id={`${p}ffrom`}
          type="time"
          defaultValue={t(w?.fulfillment_from ?? null)}
        />
        <TextInput
          label="Entrega hasta"
          name="fulfillment_to"
          id={`${p}fto`}
          type="time"
          defaultValue={t(w?.fulfillment_to ?? null)}
        />
        <TextInput
          label="Días mínimos de anticipación"
          name="lead_days_min"
          id={`${p}lead`}
          type="number"
          min={0}
          max={60}
          defaultValue={w?.lead_days_min ?? 1}
        />
        <TextInput
          label="Cupo máximo (opcional)"
          name="max_orders"
          id={`${p}max`}
          type="number"
          min={1}
          defaultValue={w?.max_orders ?? ""}
        />
        <TextInput
          label="Orden"
          name="sort_order"
          id={`${p}sort`}
          type="number"
          min={0}
          defaultValue={w?.sort_order ?? 0}
        />
        <div className="flex items-end pb-2">
          <Checkbox
            label="Activa"
            name="is_active"
            id={`${p}active`}
            defaultChecked={w?.is_active ?? true}
          />
        </div>
      </FormGrid>
      <div>
        <SubmitButton size="sm">{id ? "Guardar" : "Crear ventana"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

async function loadWindows() {
  return db()
    .selectFrom("ordering_windows")
    .selectAll()
    .orderBy("sort_order")
    .orderBy("name")
    .execute();
}

async function WindowsTab() {
  const rows = await loadWindows();
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_440px]">
      <div className="flex min-w-0 flex-col gap-3">
        <Alert tone="blue">
          Una ventana define cuándo se aceptan pedidos y cuándo se entregan. Ej.: “recibimos
          lunes–miércoles hasta las 18:00; se entrega el viernes”.
        </Alert>
        {rows.length === 0 && (
          <p className="text-sm text-muted">
            Sin ventanas de pedido. La tienda solo permitirá pedidos inmediatos.
          </p>
        )}
        {rows.map((w) => (
          <details key={w.id} className="card group p-4">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-medium">{w.name}</span>
                <span className="ml-2 text-xs text-muted">
                  {FULFILLMENT[w.fulfillment_type]} · pedidos{" "}
                  {w.order_weekdays.map((d) => DAY_SHORT[d]).join(", ")} hasta {t(w.cutoff_time)} ·
                  entrega {DAY[w.fulfillment_weekday]}
                  {w.fulfillment_from ? ` ${t(w.fulfillment_from)}–${t(w.fulfillment_to)}` : ""}
                </span>
              </span>
              <Badge tone={w.is_active ? "green" : "gray"}>
                {w.is_active ? "Activa" : "Inactiva"}
              </Badge>
            </summary>
            <div className="mt-4 border-t border-line pt-4">
              <WindowForm w={w} id={w.id} />
              <form action={deleteWindow.bind(null, w.id)} className="mt-3">
                <ConfirmButton
                  variant="danger"
                  confirm={`¿Eliminar la ventana "${w.name}"? Si ya tiene pedidos, solo se desactiva.`}
                >
                  Eliminar
                </ConfirmButton>
              </form>
            </div>
          </details>
        ))}
      </div>
      <Card title="Nueva ventana">
        <WindowForm id={null} />
      </Card>
    </div>
  );
}

async function CalendarTab() {
  const rows = await db()
    .selectFrom("calendar_exceptions")
    .selectAll()
    .where("date", ">=", sql<Date>`current_date - 30`)
    .orderBy("date")
    .execute();
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
      <Card title="Excepciones (últimos 30 días y futuras)">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            Sin feriados, cierres ni días especiales registrados.
          </p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {rows.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{fmtDate(e.date, "long")}</span>
                  <span className="ml-2 text-muted">{e.note ?? ""}</span>
                </span>
                <span className="flex items-center gap-2">
                  {e.is_closed ? (
                    <Badge tone="red">Cerrado</Badge>
                  ) : (
                    <Badge tone="green">
                      Abierto {t(e.opens_at)}–{t(e.closes_at)}
                    </Badge>
                  )}
                  {e.no_orders && <Badge tone="amber">Sin pedidos</Badge>}
                  <form action={deleteException.bind(null, e.id)}>
                    <ConfirmButton variant="danger" confirm="¿Quitar esta excepción?">
                      ✕
                    </ConfirmButton>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Agregar día especial">
        <ActionForm action={saveException} resetOnSuccess className="flex flex-col gap-3">
          <TextInput label="Fecha" name="date" type="date" required />
          <Checkbox
            label="Cerrado todo el día"
            name="is_closed"
            defaultChecked
            hint="Desmárcalo para un horario especial."
          />
          <FormGrid>
            <TextInput label="Abre" name="opens_at" type="time" />
            <TextInput label="Cierra" name="closes_at" type="time" />
          </FormGrid>
          <Checkbox
            label="No se aceptan ni entregan pedidos ese día"
            name="no_orders"
            defaultChecked
          />
          <TextInput
            label="Nota"
            name="note"
            maxLength={200}
            placeholder="Feriado, vacaciones, inventario…"
          />
          <div>
            <SubmitButton>Guardar</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}

function PickupForm({
  p,
  id,
}: {
  p?: {
    name: string;
    address: string | null;
    city: string | null;
    notes: string | null;
    map_url: string | null;
    is_default: boolean;
    is_active: boolean;
    sort_order: number;
  };
  id: string | null;
}) {
  const k = id ? `pp-${id}-` : "pp-new-";
  return (
    <ActionForm
      action={savePickup.bind(null, id)}
      resetOnSuccess={!id}
      className="flex flex-col gap-3"
    >
      <TextInput
        label="Nombre"
        name="name"
        id={`${k}name`}
        required
        maxLength={80}
        defaultValue={p?.name ?? ""}
        placeholder="Panadería (mostrador)"
      />
      <TextInput
        label="Dirección"
        name="address"
        id={`${k}address`}
        maxLength={300}
        defaultValue={p?.address ?? ""}
      />
      <FormGrid>
        <TextInput
          label="Ciudad"
          name="city"
          id={`${k}city`}
          maxLength={80}
          defaultValue={p?.city ?? ""}
        />
        <TextInput
          label="Orden"
          name="sort_order"
          id={`${k}sort`}
          type="number"
          min={0}
          defaultValue={p?.sort_order ?? 0}
        />
      </FormGrid>
      <TextInput
        label="Enlace de mapa"
        name="map_url"
        id={`${k}map`}
        type="url"
        defaultValue={p?.map_url ?? ""}
        placeholder="https://maps.google.com/…"
      />
      <TextInput
        label="Indicaciones"
        name="notes"
        id={`${k}notes`}
        maxLength={300}
        defaultValue={p?.notes ?? ""}
      />
      <div className="flex flex-wrap gap-4">
        <Checkbox
          label="Predeterminado"
          name="is_default"
          id={`${k}default`}
          defaultChecked={p?.is_default ?? false}
        />
        <Checkbox
          label="Activo"
          name="is_active"
          id={`${k}active`}
          defaultChecked={p?.is_active ?? true}
        />
      </div>
      <div>
        <SubmitButton size="sm">{id ? "Guardar" : "Crear punto"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

async function PickupTab() {
  const rows = await db()
    .selectFrom("pickup_points")
    .selectAll()
    .orderBy("sort_order")
    .orderBy("name")
    .execute();
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
      <div className="flex min-w-0 flex-col gap-3">
        {rows.length === 0 && (
          <p className="text-sm text-muted">
            Sin puntos de retiro. La tienda necesita al menos uno para pedidos con recolección.
          </p>
        )}
        {rows.map((p) => (
          <details key={p.id} className="card p-4">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-medium">{p.name}</span>
                <span className="ml-2 text-xs text-muted">
                  {[p.address, p.city].filter(Boolean).join(", ")}
                </span>
              </span>
              <span className="flex gap-1">
                {p.is_default && <Badge tone="blue">Predeterminado</Badge>}
                <Badge tone={p.is_active ? "green" : "gray"}>
                  {p.is_active ? "Activo" : "Inactivo"}
                </Badge>
              </span>
            </summary>
            <div className="mt-4 border-t border-line pt-4">
              <PickupForm p={p} id={p.id} />
              <form action={deletePickup.bind(null, p.id)} className="mt-3">
                <ConfirmButton
                  variant="danger"
                  confirm={`¿Eliminar "${p.name}"? Si ya tiene pedidos, solo se desactiva.`}
                >
                  Eliminar
                </ConfirmButton>
              </form>
            </div>
          </details>
        ))}
      </div>
      <Card title="Nuevo punto de retiro">
        <PickupForm id={null} />
      </Card>
    </div>
  );
}

async function FlagsTab() {
  const rows = await db().selectFrom("feature_flags").selectAll().orderBy("key").execute();
  return (
    <Card title="Funciones del sistema">
      <p className="mb-3 text-sm text-muted">
        Activa o desactiva módulos sin desplegar. Los cambios aplican de inmediato en tienda, POS y
        bots.
      </p>
      <ul className="divide-y divide-line">
        {rows.map((f) => (
          <li key={f.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-sm font-semibold">{f.key}</code>
                <Badge tone={f.enabled ? "green" : "gray"}>
                  {f.enabled ? "Activa" : "Inactiva"}
                </Badge>
                {PAYMENT_FLAGS.has(f.key) && <Badge tone="amber">Afecta cobros</Badge>}
              </div>
              <p className="text-sm text-muted">{f.description ?? "—"}</p>
              {PAYMENT_FLAGS.has(f.key) && (
                <p className="mt-1 text-xs text-amber-d">
                  {f.key === "web_checkout"
                    ? "Apagarla impide finalizar pedidos en el sitio público."
                    : "Requiere credenciales de Mercado Pago configuradas y probadas. Al activarla se cobra dinero real."}
                </p>
              )}
              <p className="text-xs text-muted">Actualizada {fmtDate(f.updated_at, "datetime")}</p>
            </div>
            <form action={toggleFlag.bind(null, f.key, !f.enabled)}>
              <ConfirmButton
                variant={f.enabled ? "secondary" : "primary"}
                confirm={
                  PAYMENT_FLAGS.has(f.key)
                    ? `"${f.key}" afecta cobros. ¿${f.enabled ? "Desactivar" : "Activar"} de todos modos?`
                    : undefined
                }
              >
                {f.enabled ? "Desactivar" : "Activar"}
              </ConfirmButton>
            </form>
          </li>
        ))}
      </ul>
    </Card>
  );
}
