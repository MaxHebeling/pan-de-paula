/**
 * Arte SVG de la sección "Del horno a tu mesa" (paleta de la marca, mismo lenguaje que ProductArt).
 * Son ilustraciones de respaldo mientras no hay fotografías reales: ver docs/WEB_MOTION.md → "Fotos reales".
 */
export type ProcessStepKey = "preparamos" | "horneamos" | "empacamos" | "disfrutas";

const INK = "#1f2a3a";
const SAGE = "#2f6b5f";
const WINE = "#7a3b4a";
const CRUST = "#c98a3e";
const CRUST_2 = "#e0a95e";

const BG: Record<ProcessStepKey, string> = {
  preparamos: "#f3e9d8",
  horneamos: "#f1e3e4",
  empacamos: "#e7efe9",
  disfrutas: "#e8eaf0",
};

export function ProcessArt({
  step,
  className = "",
  decorative = false,
  title,
}: {
  step: ProcessStepKey;
  className?: string;
  /** true cuando la ilustración acompaña un texto que ya describe el paso. */
  decorative?: boolean;
  title?: string;
}) {
  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": title ?? step };
  return (
    <svg viewBox="0 0 400 500" className={className} preserveAspectRatio="xMidYMid slice" {...a11y}>
      <rect width="400" height="500" fill={BG[step]} />
      <circle cx="200" cy="260" r="150" fill="#fffdf9" opacity="0.55" />
      {step === "preparamos" && (
        <g>
          {/* Bol con masa */}
          <path d="M96 250h208c0 66-46 112-104 112S96 316 96 250Z" fill={CRUST} opacity="0.85" />
          <path d="M96 250h208" stroke={INK} strokeWidth="6" strokeLinecap="round" />
          <ellipse cx="200" cy="250" rx="86" ry="20" fill="#fffdf9" opacity="0.9" />
          {/* Batidor */}
          <path
            d="M262 98l-42 118M262 98c22 6 34 28 26 52s-28 38-50 32M262 98c-22-6-44 6-52 30s2 46 24 52"
            stroke={INK}
            strokeWidth="6"
            strokeLinecap="round"
            fill="none"
          />
          {/* Harina */}
          <g fill="#fffdf9" opacity="0.95">
            <circle cx="120" cy="176" r="5" />
            <circle cx="146" cy="150" r="3.5" />
            <circle cx="102" cy="206" r="3" />
            <circle cx="164" cy="190" r="4" />
          </g>
          <circle cx="76" cy="420" r="4" fill={WINE} opacity="0.55" />
          <circle cx="324" cy="420" r="4" fill={WINE} opacity="0.55" />
        </g>
      )}
      {step === "horneamos" && (
        <g>
          {/* Horno */}
          <rect x="90" y="150" width="220" height="220" rx="22" fill={INK} />
          <rect x="112" y="196" width="176" height="130" rx="14" fill={WINE} opacity="0.9" />
          <rect x="112" y="196" width="176" height="130" rx="14" fill={CRUST_2} opacity="0.35" />
          <path
            d="M112 172h176"
            stroke="#fffdf9"
            strokeWidth="5"
            strokeLinecap="round"
            opacity="0.5"
          />
          <circle cx="128" cy="172" r="5" fill={CRUST_2} />
          <circle cx="150" cy="172" r="5" fill={SAGE} />
          {/* Croissant dentro */}
          <path
            d="M146 282c6-30 34-48 54-48s48 18 54 48c-12-10-26-14-54-14s-42 4-54 14Z"
            fill={CRUST}
          />
          <path
            d="M170 270c8-14 20-20 30-20s22 6 30 20"
            stroke="#fffdf9"
            strokeWidth="4"
            strokeLinecap="round"
            fill="none"
            opacity="0.7"
          />
          {/* Calor */}
          <g stroke={CRUST} strokeWidth="6" strokeLinecap="round" fill="none" opacity="0.8">
            <path d="M170 128c-10-14 10-22 0-38" />
            <path d="M200 120c-10-14 10-22 0-38" />
            <path d="M230 128c-10-14 10-22 0-38" />
          </g>
        </g>
      )}
      {step === "empacamos" && (
        <g>
          {/* Caja */}
          <path d="M92 236h216v128a18 18 0 0 1-18 18H110a18 18 0 0 1-18-18V236Z" fill={CRUST} />
          <path d="M80 206h240v34H80z" fill={CRUST_2} />
          <path d="M80 206h240" stroke={INK} strokeWidth="6" strokeLinecap="round" />
          {/* Listón */}
          <path d="M200 206v176" stroke={WINE} strokeWidth="14" />
          <path d="M92 300h216" stroke={WINE} strokeWidth="14" />
          <path
            d="M200 200c-20-40-60-30-46-4s46 4 46 4Zm0 0c20-40 60-30 46-4s-46 4-46 4Z"
            fill="none"
            stroke={WINE}
            strokeWidth="8"
            strokeLinejoin="round"
          />
          {/* Etiqueta con sello */}
          <rect x="222" y="318" width="64" height="40" rx="8" fill="#fffdf9" />
          <circle cx="254" cy="338" r="10" fill={SAGE} />
          <circle cx="76" cy="430" r="4" fill={WINE} opacity="0.55" />
          <circle cx="324" cy="430" r="4" fill={WINE} opacity="0.55" />
        </g>
      )}
      {step === "disfrutas" && (
        <g>
          {/* Plato */}
          <ellipse cx="170" cy="330" rx="118" ry="30" fill="#fffdf9" />
          <ellipse cx="170" cy="330" rx="118" ry="30" fill="none" stroke={INK} strokeWidth="5" />
          {/* Rol de canela */}
          <ellipse cx="170" cy="300" rx="64" ry="40" fill={CRUST} />
          <path
            d="M120 300c0-22 22-32 50-32s50 10 50 32M138 300c0-12 14-18 32-18s32 6 32 18M156 300c0-6 6-8 14-8s14 2 14 8"
            stroke={INK}
            strokeWidth="5"
            strokeLinecap="round"
            fill="none"
            opacity="0.8"
          />
          <path
            d="M150 272c10 8 30 8 40 0"
            stroke="#fffdf9"
            strokeWidth="6"
            strokeLinecap="round"
            fill="none"
            opacity="0.9"
          />
          {/* Taza */}
          <path d="M262 254h74v54a26 26 0 0 1-26 26h-22a26 26 0 0 1-26-26v-54Z" fill={SAGE} />
          <path
            d="M336 268h14a16 16 0 0 1 0 32h-14"
            fill="none"
            stroke={SAGE}
            strokeWidth="9"
            strokeLinecap="round"
          />
          <g stroke={INK} strokeWidth="5" strokeLinecap="round" fill="none" opacity="0.55">
            <path d="M284 232c-8-12 8-18 0-32" />
            <path d="M310 232c-8-12 8-18 0-32" />
          </g>
        </g>
      )}
    </svg>
  );
}
