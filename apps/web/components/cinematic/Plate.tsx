import type { CSSProperties } from "react";

/**
 * "Plato" tipográfico: composición editorial con la paleta de la marca para productos y categorías que aún
 * no tienen fotografía. Es decorativo (el nombre ya está en el texto de la sección) y no simula una foto.
 */
const TONES = [
  { bg: "#efe3cf", ink: "#6b4a22" }, // corteza
  { bg: "#e3ece6", ink: "#23544a" }, // salvia
  { bg: "#f0e1e3", ink: "#6a3240" }, // vino
  { bg: "#e6e8ee", ink: "#1f2a3a" }, // tinta
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

export function Plate({
  name,
  seed,
  tone: toneIndex,
  top,
  foot = "Boulangerie · Made with love",
}: {
  name: string;
  seed: string;
  /** Índice de tono fijo (p. ej. la posición en una lista) para que platos vecinos no repitan color. */
  tone?: number;
  top?: string;
  foot?: string;
}) {
  const tone = TONES[(toneIndex ?? hash(seed)) % TONES.length]!;
  const style = { "--plate-bg": tone.bg, "--plate-ink": tone.ink } as CSSProperties;
  return (
    <span className="cin-plate" style={style} aria-hidden="true">
      <span className="cin-plate-initial" data-initial={name.trim().charAt(0).toUpperCase()} />
      <span className="cin-plate-rule" />
      <span className="cin-plate-top">
        <span>El Pan de Paula</span>
        {top && <span>{top}</span>}
      </span>
      <span className="cin-plate-name">{name}</span>
      <span className="cin-plate-foot">
        <span>{foot}</span>
      </span>
    </span>
  );
}
