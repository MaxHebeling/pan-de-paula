"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/** Último recurso: error en el layout raíz del CRM. Reporta a Sentry (si está activo) y ofrece reintentar. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="es-MX">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, sans-serif",
          background: "#f5f5f7",
          color: "#111827",
        }}
      >
        <main
          style={{ maxWidth: 560, margin: "0 auto", padding: "64px 20px", textAlign: "center" }}
        >
          <h1 style={{ fontSize: 26, fontWeight: 600 }}>Algo salió mal</h1>
          <p style={{ color: "#4b5563" }}>
            Ocurrió un error inesperado. Tu trabajo en la base de datos está a salvo; intenta de
            nuevo.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 12, color: "#6b7280" }}>Referencia: {error.digest}</p>
          ) : null}
          <button
            onClick={() => reset()}
            style={{
              marginTop: 16,
              minHeight: 44,
              padding: "12px 22px",
              borderRadius: 10,
              border: 0,
              background: "#0f766e",
              color: "#fff",
              fontSize: 15,
              cursor: "pointer",
            }}
          >
            Reintentar
          </button>
        </main>
      </body>
    </html>
  );
}
