import { BADGE_CLASS, type Badge } from "@/lib/availability";

export function Badges({ badges, className = "" }: { badges: Badge[]; className?: string }) {
  if (badges.length === 0) return null;
  return (
    <ul className={`flex flex-wrap gap-1.5 ${className}`} aria-label="Etiquetas">
      {badges.map((b) => (
        <li key={b.key} className={`badge ${BADGE_CLASS[b.key]}`}>
          {b.label}
        </li>
      ))}
    </ul>
  );
}
