import type { CSSProperties } from "react";
import Image from "next/image";
import { formatBirthday } from "@/lib/birthdays";
import "./birthday-card.css";

/**
 * Tarjeta de cumpleaños: la pieza visual que el staff previsualiza (e imprime) antes de saludar.
 * Identidad de El Pan de Paula (logo + tipografía serif de los correos) sobre el sistema del CRM;
 * el color del NIVEL del cliente se usa solo en acentos (barra, filete, badge, firma, esquina).
 *
 * Los hex salen de app/globals.css (--green/--amber/--blue/--red y sus variantes -d, y --gray-st /
 * --muted para "sin nivel"): no se inventa paleta.
 */
const TIER_ACCENT: Record<string, { base: string; deep: string }> = {
  green: { base: "#34c759", deep: "#248a3d" }, // --green / --green-d
  amber: { base: "#ff9f0a", deep: "#9a6b00" }, // --amber / --amber-d
  blue: { base: "#0a84ff", deep: "#0a6fd8" }, // --blue / --blue-d
  red: { base: "#ff3b30", deep: "#c4271f" }, // --red / --red-d
  gray: { base: "#9ca3af", deep: "#6e6e73" }, // --gray-st / tinte .st-gray
};

/** `#rrggbb` + alpha → `rgba(...)`, para los velos tenues del acento. */
function alpha(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export type BirthdayCardProps = {
  fullName: string;
  publicCode: string;
  /** Fecha observada del cumpleaños (YYYY-MM-DD). */
  celebratesOn: string;
  tierName?: string | null;
  /** `loyalty_tiers.color`: gray | blue | amber | green. */
  tierColor?: string | null;
  businessName: string;
  tagline?: string | null;
  instagramHandle?: string | null;
  /** Texto del saludo (salida de `birthdayGreetingMessage`), una idea por línea. */
  message: string;
};

export function BirthdayCard({
  fullName,
  publicCode,
  celebratesOn,
  tierName,
  tierColor,
  businessName,
  tagline,
  instagramHandle,
  message,
}: BirthdayCardProps) {
  const accent = TIER_ACCENT[tierColor ?? "gray"] ?? TIER_ACCENT.gray!;
  const style = {
    "--accent": accent.base,
    "--accent-deep": accent.deep,
    "--accent-14": alpha(accent.base, 0.14),
    "--accent-30": alpha(accent.base, 0.3),
    "--accent-40": alpha(accent.base, 0.4),
  } as CSSProperties;

  const lines = message.split("\n").filter((l) => l.trim());
  // Primera línea = encabezado (el 🎂 se pinta aparte, en el filete), última = firma.
  const headline = (lines[0] ?? "").replace(/\s*🎂\s*$/, "").trim();
  const sign = lines.length > 1 ? lines[lines.length - 1]! : null;
  const body = lines.slice(1, lines.length > 1 ? -1 : undefined);
  // "¡Feliz cumpleaños, Ana!" → antecedente + nombre destacado
  const split = headline.match(/^(.*?,\s*)(.+)$/);

  return (
    <article className="bd-card" style={style} aria-label={`Tarjeta de cumpleaños de ${fullName}`}>
      <Image
        src="/logo.png"
        alt={businessName}
        width={68}
        height={68}
        className="bd-logo mx-auto"
        priority
      />
      <div className="bd-biz">{businessName}</div>
      {tagline && <div className="bd-tagline">{tagline}</div>}

      <div className="bd-rule" aria-hidden>
        <span className="bd-rule-line" />
        <span className="bd-rule-emoji">🎂</span>
        <span className="bd-rule-line" />
      </div>

      {split ? (
        <>
          <div className="bd-kicker">{split[1]!.replace(/,\s*$/, "")}</div>
          <h2 className="bd-name">{split[2]}</h2>
        </>
      ) : (
        <h2 className="bd-name">{headline}</h2>
      )}

      <div className="bd-meta">
        {tierName && <span className="bd-tier">{tierName}</span>}
        <span className="bd-date">{formatBirthday(celebratesOn)}</span>
      </div>

      <div className="bd-body">
        {body.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>

      {sign && <div className="bd-sign">{sign}</div>}

      <div className="bd-foot">
        <span className="font-mono">{publicCode}</span>
        {instagramHandle && <span>@{instagramHandle}</span>}
      </div>
    </article>
  );
}
