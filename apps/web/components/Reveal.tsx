import { createElement, type CSSProperties, type ReactNode } from "react";

export type RevealVariant = "up" | "fade" | "scale" | "card" | "left" | "none";

/**
 * Envoltorio de revelado al hacer scroll (server component, sin JS propio).
 * Solo marca `data-reveal`; lib/motion/scrollReveal.ts decide cuándo ocultar y mostrar.
 * Sin JS o con reduced motion el elemento se ve siempre. `delay` escalona (ms).
 */
export function Reveal({
  as = "div",
  variant = "up",
  delay = 0,
  className,
  style,
  children,
  ...rest
}: {
  as?: "div" | "li" | "section" | "article" | "footer" | "span" | "aside" | "ul" | "ol";
  variant?: RevealVariant;
  delay?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  id?: string;
  "aria-labelledby"?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  role?: string;
}) {
  const merged: CSSProperties | undefined = delay
    ? ({ ...style, "--reveal-delay": `${delay}ms` } as CSSProperties)
    : style;
  return createElement(as, { "data-reveal": variant, className, style: merged, ...rest }, children);
}
