import type { CSSProperties } from "react";

/**
 * Tipografía animada del home. Todo se parte en el servidor (sin medir ni pintar con JS) y el texto sigue
 * siendo texto normal para lectores de pantalla y buscadores.
 *
 * - <Lines>: titular por líneas; cada línea sube escalonada, siempre pintada (app/motion.css → .line-in).
 * - <ScrollWords>: párrafo cuyas palabras se "encienden" con el scroll (`--p` = posición 0…1 en el párrafo).
 * - Para títulos de sección por palabras se reutiliza <SplitWords/> (lib/motion/textReveal.tsx).
 */
export function Lines({ lines }: { lines: Array<{ text: string; accent?: boolean }> }) {
  return (
    <>
      {lines.map((l, i) => (
        <span key={l.text}>
          <span className={`line${l.accent ? " accent" : ""}`}>
            <span className="line-in" style={{ "--l": i } as CSSProperties}>
              {l.text}
            </span>
          </span>
          {i < lines.length - 1 ? " " : null}
        </span>
      ))}
    </>
  );
}

export function ScrollWords({ text, accent = [] }: { text: string; accent?: string[] }) {
  const words = text.split(/\s+/).filter(Boolean);
  const last = Math.max(1, words.length - 1);
  return (
    <>
      {words.map((w, i) => (
        <span key={`${i}-${w}`}>
          <span
            className={`cin-word${accent.includes(w) ? " cin-accent" : ""}`}
            style={{ "--p": (i / last).toFixed(3) } as CSSProperties}
          >
            {w}
          </span>
          {i < words.length - 1 ? " " : null}
        </span>
      ))}
    </>
  );
}
