/**
 * Icono de navegación: emoji a color renderizado por el sistema (sin fuentes ni SVG externos).
 * Se marca como decorativo; el texto del enlace da el nombre accesible.
 */
export function Icon({
  name,
  size = 18,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`inline-flex w-6 shrink-0 select-none items-center justify-center leading-none ${className}`}
      style={{
        fontSize: size,
        fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
      }}
    >
      {name}
    </span>
  );
}
