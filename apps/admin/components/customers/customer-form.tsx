import type { ActionState } from "@/lib/action-state";
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
  // El correo es obligatorio en el alta y en cualquier cliente que ya lo tenga (es su acceso al portal).
  // A un cliente histórico sin correo se le puede guardar el resto sin quedar bloqueado.
  const emailRequired = !editing || Boolean(values.email);
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
        <div>
          <label className="label" htmlFor="phone">
            Teléfono (10 dígitos)
          </label>
          <input
            id="phone"
            name="phone"
            className="input"
            inputMode="tel"
            defaultValue={values.phone ?? ""}
            placeholder="6641234567"
          />
        </div>
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
            Cumpleaños
          </label>
          <input
            id="birthday"
            name="birthday"
            type="date"
            className="input"
            defaultValue={values.birthday ?? ""}
          />
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
