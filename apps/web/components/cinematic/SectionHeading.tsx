import type { ReactNode } from "react";
import { SplitWords } from "@/lib/motion/textReveal";
import { Reveal } from "../Reveal";

/** Cabecera editorial de sección: índice numerado, título por palabras y (opcional) intro + acción. */
export function SectionHeading({
  id,
  index,
  eyebrow,
  title,
  intro,
  children,
}: {
  id: string;
  index: string;
  eyebrow: string;
  title: string;
  intro?: string;
  children?: ReactNode;
}) {
  return (
    <Reveal className="cin-head">
      <div className="cin-head-main">
        <p className="cin-index">
          <span className="cin-index-num">{index}</span> {eyebrow}
        </p>
        <h2 id={id} className="cin-h2">
          <SplitWords text={title} />
        </h2>
      </div>
      {(intro || children) && (
        <div className="cin-head-aside">
          {intro && <p className="cin-lead">{intro}</p>}
          {children}
        </div>
      )}
    </Reveal>
  );
}
