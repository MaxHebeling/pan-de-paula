import type { ActionState } from "@/lib/action-state";
import { PhoneField } from "@/components/phone-field";
import { ActionForm } from "./action-form";

type Values = {
  id?: string;
  full_name?: string;
  phone?: string | null;
  email?: string | null;
  birthday?: string | null;
  notes?: string | null;
  tags?: string[];
  marketing_consent?: boolean;
  operational_consent?: boolean;
};

export function CustomerForm({
  action,
  values = {},
  submitLabel,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  values?: Values;
  submitLabel: string;
}) {
  const editing = Boolean(values.id);
  // Alta: los cuatro datos son obligatorios (regla 0045). Edición: cada dato se exige solo si el
  // cliente YA lo tiene —no se le puede borrar—, para poder guardar los cambios de un cliente
  // histórico incompleto sin bloquearlo por lo que le falta.
  const emailRequired = !editing || Boolean(values.email);
  const phoneRequired = !editing || Boolean(values.phone);
  const birthdayRequired = !editing || Boolean(values.birthday);
  const hoy = new Date().toISOString().slice(0, 10);
  return (
    <ActionForm action={action} submitLabel={submitLabel} className="max-w-2xl">
      {values.id && <input type="hidden" name="id" value={values.id} />}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="label" htmlFor="full_name">
            Nombre completo *
          </label>
          <input
            id="full_name"
            name="full_name"
            className="input"
            required
            minLength={2}
            maxLength={120}
            defaultValue={values.full_name ?? ""}
            autoComplete="off"
          />
        </div>
        <PhoneField
          name="phone"
          label="Celular"
          required={phoneRequired}
          storedValue={values.phone}
          help={
            phoneRequired
              ? null
              : "Este cliente se registró sin celular. Captúralo cuando lo tengas."
          }
          testId="customer-phone"
        />
        <div>
          <label className="label" htmlFor="email">
            Correo electrónico {emailRequired ? "*" : ""}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className="input"
            required={emailRequired}
            defaultValue={values.email ?? ""}
            placeholder="nombre@correo.com"
            aria-describedby={emailRequired ? undefined : "email-help"}
          />
          {!emailRequired && (
            <p id="email-help" className="help">
              Este cliente se registró sin correo. Al capturarlo podrá entrar a su portal.
            </p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="birthday">
            Fecha de nacimiento {birthdayRequired ? "*" : ""}
          </label>
          <input
            id="birthday"
            name="birthday"
            type="date"
            className="input"
            required={birthdayRequired}
            max={hoy}
            defaultValue={values.birthday ?? ""}
            aria-describedby="birthday-help"
          />
          <p id="birthday-help" className="help">
            {birthdayRequired
              ? "De aquí sale su cumpleaños: se felicita el día y mes de esta fecha."
              : "Este cliente se registró sin fecha de nacimiento. Captúrala cuando la tengas."}
          </p>
        </div>
        <div>
          <label className="label" htmlFor="tags">
            Etiquetas (separadas por coma)
          </label>
          <input
            id="tags"
            name="tags"
            className="input"
            defaultValue={(values.tags ?? []).join(", ")}
            placeholder="mayoreo, vecino, evento"
          />
        </div>
        <div className="md:col-span-2">
          <label className="label" htmlFor="notes">
            Notas internas
          </label>
          <textarea
            id="notes"
            name="notes"
            className="input"
            rows={3}
            maxLength={2000}
            defaultValue={values.notes ?? ""}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="marketing_consent"
            defaultChecked={values.marketing_consent ?? false}
            className="h-4 w-4"
          />
          Acepta recibir promociones (marketing)
        </label>
        {editing && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="operational_consent"
              defaultChecked={values.operational_consent ?? true}
              className="h-4 w-4"
            />
            Acepta avisos operativos (pedidos, puntos)
          </label>
        )}
      </div>
      <p className="text-xs text-muted">
        Se requiere teléfono o email. Si ya existe un cliente con ese teléfono/email, se reutiliza.
      </p>
    </ActionForm>
  );
}
