/**
 * Insignia del nivel con SU color real (`loyalty_tiers.color`: gray, blue, amber, green), traducido a
 * tonos que conviven con la paleta del sitio. Un color desconocido cae en el neutro en vez de romper.
 */
const PALETTE: Record<string, { ink: string; tint: string; border: string }> = {
  gray: { ink: "#4b5563", tint: "rgba(75, 85, 99, 0.12)", border: "rgba(75, 85, 99, 0.3)" },
  blue: { ink: "#2f5f7a", tint: "rgba(47, 95, 122, 0.12)", border: "rgba(47, 95, 122, 0.3)" },
  amber: { ink: "#a06a1f", tint: "rgba(201, 138, 62, 0.16)", border: "rgba(201, 138, 62, 0.38)" },
  green: { ink: "#2f6b5f", tint: "rgba(47, 107, 95, 0.14)", border: "rgba(47, 107, 95, 0.32)" },
};

export function tierPalette(color: string | null | undefined) {
  return PALETTE[color ?? ""] ?? PALETTE.gray!;
}

export function TierBadge({
  name,
  color,
  className = "",
}: {
  name: string;
  color: string | null;
  className?: string;
}) {
  const p = tierPalette(color);
  return (
    <span
      className={`badge border ${className}`}
      style={{ color: p.ink, backgroundColor: p.tint, borderColor: p.border }}
      data-testid="portal-tier"
      data-tier-color={color ?? "gray"}
    >
      {name}
    </span>
  );
}
