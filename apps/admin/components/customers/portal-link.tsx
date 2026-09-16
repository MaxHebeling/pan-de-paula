"use client";
import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action-state";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/**
 * Genera y muestra el enlace de acceso al portal del cliente.
 *
 * El enlace solo vive en esta respuesta (nunca se guarda en claro): si se pierde, se genera otro y el
 * anterior deja de servir. Por eso el botón dice "Generar" y no hay historial en pantalla.
 */
export function PortalLinkButton({
  action,
  customerId,
  hasEmail,
}: {
  action: Action;
  customerId: string;
  hasEmail: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const [copied, setCopied] = useState(false);
  const link = typeof state.data?.link === "string" ? state.data.link : null;

  return (
    <div className="flex flex-col gap-2">
      <form action={formAction}>
        <input type="hidden" name="id" value={customerId} />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={pending}>
          {pending ? "Generando…" : link ? "Generar otro enlace" : "Generar enlace de acceso"}
        </button>
      </form>
      <p className="text-xs text-muted">
        {hasEmail
          ? "Abre su cuenta en el sitio (puntos, compras y QR). Si el correo está configurado, además se lo enviamos."
          : "Este cliente no tiene correo: no podrá pedirse el enlace solo. Regístraselo para que entre por su cuenta."}
      </p>
      {state.error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="st-green rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.ok}
        </p>
      )}
      {link && (
        <div className="flex flex-col gap-2 rounded-[var(--r-btn)] border border-line p-2">
          <code className="text-xs break-all" data-testid="portal-link">
            {link}
          </code>
          <button
            type="button"
            className="btn btn-secondary btn-sm self-start"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 2500);
              } catch (e) {
                console.error("[clientes] no se pudo copiar el enlace", e);
                window.prompt("Copia este enlace:", link);
              }
            }}
          >
            {copied ? "Copiado ✓" : "Copiar enlace"}
          </button>
        </div>
      )}
    </div>
  );
}
