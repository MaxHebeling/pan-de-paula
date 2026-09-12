/** Ilustración de respaldo cuando un producto aún no tiene fotografía: paleta de la marca, motivo por categoría. */
const PALETTES = [
  { bg: "#f3e9d8", main: "#c98a3e", soft: "#e0a95e" }, // corteza
  { bg: "#e7efe9", main: "#2f6b5f", soft: "#3f8474" }, // salvia
  { bg: "#f1e3e4", main: "#7a3b4a", soft: "#93505f" }, // vino
  { bg: "#e8eaf0", main: "#1f2a3a", soft: "#3a4658" }, // tinta
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

export function ProductArt({
  name,
  seed,
  className = "",
  large = false,
}: {
  name: string;
  seed: string;
  className?: string;
  large?: boolean;
}) {
  const h = hash(seed);
  const p = PALETTES[h % PALETTES.length]!;
  const motif = h % 3;
  const initial = name.trim().charAt(0).toUpperCase() || "P";
  return (
    <svg
      viewBox="0 0 400 400"
      role="img"
      aria-label={`${name} (ilustración)`}
      className={className}
      preserveAspectRatio="xMidYMid slice"
    >
      <rect width="400" height="400" fill={p.bg} />
      <circle cx="200" cy="212" r="138" fill={p.soft} opacity="0.16" />
      <circle cx="200" cy="200" r="112" fill={p.main} opacity="0.14" />
      {motif === 0 && (
        <path
          d="M118 236c-12-46 26-92 82-104 58-12 108 16 118 62-30-8-58-2-84 16-26 18-40 44-42 76-32-4-64-20-74-50Z"
          fill={p.main}
          opacity="0.22"
        />
      )}
      {motif === 1 && (
        <g fill={p.main} opacity="0.22">
          <circle cx="150" cy="180" r="10" />
          <circle cx="250" cy="170" r="8" />
          <circle cx="210" cy="250" r="11" />
          <circle cx="160" cy="255" r="7" />
          <circle cx="255" cy="235" r="6" />
        </g>
      )}
      {motif === 2 && (
        <g stroke={p.main} strokeWidth="6" strokeLinecap="round" opacity="0.22" fill="none">
          <path d="M130 250c30-70 110-70 140 0" />
          <path d="M150 215c22-40 78-40 100 0" />
        </g>
      )}
      <text
        x="200"
        y={large ? 232 : 236}
        textAnchor="middle"
        fontSize={large ? 132 : 124}
        fill={p.main}
        style={{ fontFamily: "var(--font-display), Georgia, serif", fontWeight: 600 }}
      >
        {initial}
      </text>
      <circle cx="96" cy="300" r="4" fill="#7a3b4a" opacity="0.55" />
      <circle cx="304" cy="300" r="4" fill="#7a3b4a" opacity="0.55" />
    </svg>
  );
}
