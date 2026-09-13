import type { CSSProperties } from "react";

/**
 * Revelado de texto por palabras, solo para títulos clave. Se parte en el servidor (sin medir nada):
 * cada palabra es un `span.word` con su índice `--w`; el CSS (app/motion.css) las escalona cuando el
 * contenedor `[data-reveal]` entra en pantalla. Para lectores de pantalla el texto sigue siendo normal
 * (spans inline con espacios reales entre ellos).
 */
export function SplitWords({ text, className = "" }: { text: string; className?: string }) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <span className={className}>
      {words.map((w, i) => (
        <span key={`${i}-${w}`}>
          <span className="word" style={{ "--w": i } as CSSProperties}>
            {w}
          </span>
          {i < words.length - 1 ? " " : null}
        </span>
      ))}
    </span>
  );
}
