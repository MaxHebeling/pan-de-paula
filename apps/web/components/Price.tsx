import { money } from "@/lib/format";

export function Price({
  cents,
  regularCents,
  className = "",
  size = "md",
}: {
  cents: number | null;
  regularCents?: number | null;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  if (cents === null) return <span className={`text-ink-2 ${className}`}>Consultar precio</span>;
  const promo = regularCents !== null && regularCents !== undefined && cents < regularCents;
  const sz = size === "lg" ? "text-2xl" : size === "sm" ? "text-sm" : "text-base";
  return (
    <span className={`inline-flex items-baseline gap-2 ${className}`}>
      <span className={`font-semibold text-ink ${sz}`}>{money(cents, true)}</span>
      {promo && (
        <span className="text-sm text-ink-2 line-through" aria-label="Precio regular">
          {money(regularCents!, true)}
        </span>
      )}
    </span>
  );
}
