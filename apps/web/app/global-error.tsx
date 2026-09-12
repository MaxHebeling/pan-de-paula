"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/** Último recurso: error en el layout raíz. Reporta a Sentry (si está activo) y ofrece reintentar. */
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
          fontFamily: "Inter, system-ui, sans-serif",
          background: "#f7f3ec",
          color: "#2b2622",
        }}
      >
        <main
          style={{ maxWidth: 560, margin: "0 auto", padding: "64px 20px", textAlign: "center" }}
        >
          <h1
            style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 32,
            }}
          >
            Algo salió mal
          </h1>
          <p style={{ color: "#6b625a" }}>
            Tuvimos un problema al cargar la página. Puedes intentar de nuevo o volver más tarde.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 12, color: "#9a9088" }}>Referencia: {error.digest}</p>
          ) : null}
          <button
            onClick={() => reset()}
            style={{
              marginTop: 16,
              padding: "12px 22px",
              borderRadius: 8,
              border: 0,
              background: "#6e2f3a",
              color: "#fff",
              fontSize: 15,
              cursor: "pointer",
            }}
          >
            Intentar de nuevo
          </button>
        </main>
      </body>
    </html>
  );
}
