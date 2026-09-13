import Image from "next/image";
import type { CSSProperties } from "react";
import { SplitWords } from "@/lib/motion/textReveal";
import { ProcessArt, type ProcessStepKey } from "./ProcessArt";
import { ProcessSteps } from "./ProcessSteps";
import { Reveal } from "./Reveal";

export type StoryPhoto = { src: string; alt: string; width: number; height: number };

export const PROCESS_STEPS: Array<{
  key: ProcessStepKey;
  number: string;
  title: string;
  body: string;
}> = [
  {
    key: "preparamos",
    number: "01",
    title: "Preparamos",
    body: "Amasamos y laminamos a mano, en tandas cortas, con mantequilla de verdad. Sin mezclas listas ni atajos.",
  },
  {
    key: "horneamos",
    number: "02",
    title: "Horneamos",
    body: "Horneamos el mismo día que lo recoges: solo lo que ya está pedido. Así cada pieza llega recién salida del horno.",
  },
  {
    key: "empacamos",
    number: "03",
    title: "Empacamos",
    body: "Empacamos tu pedido con tu nombre y te avisamos cuando está listo para recoger.",
  },
  {
    key: "disfrutas",
    number: "04",
    title: "Tú disfrutas",
    body: "Pasas por él en tu fecha y lo compartes en tu mesa. Nosotros ya estamos amasando el siguiente.",
  },
];

/**
 * "Del horno a tu mesa": storytelling con imagen fija a un lado (desktop) y textos que cambian con el scroll;
 * en móvil, lista vertical simple con su ilustración. `photos` sustituye el arte SVG por fotografías reales
 * cuando existen en public/story (ver lib/storyPhotos.ts y docs/WEB_MOTION.md).
 */
export function Process({ photos }: { photos: Partial<Record<ProcessStepKey, StoryPhoto>> }) {
  return (
    <section
      id="proceso"
      className="container-x story py-12 sm:py-16"
      aria-labelledby="proceso-title"
    >
      <Reveal className="mb-8 max-w-2xl lg:mb-12">
        <p className="eyebrow mb-2">Así trabajamos</p>
        <h2 id="proceso-title" className="display text-3xl sm:text-4xl">
          <SplitWords text="Del horno a tu mesa" />
        </h2>
      </Reveal>

      <ProcessSteps>
        <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
          {/* Imagen fija (desktop) */}
          <Reveal
            variant="scale"
            className="relative hidden lg:block"
            aria-hidden="true"
            data-testid="story-art"
          >
            <div className="story-art card sticky top-28 aspect-[4/5] overflow-hidden">
              {PROCESS_STEPS.map((s, i) => (
                <div key={s.key} className="story-art-layer" data-step={i}>
                  <StepVisual step={s.key} title={s.title} photo={photos[s.key]} priority={false} />
                </div>
              ))}
              <span className="absolute bottom-5 left-5 rounded-pill bg-paper/85 px-3 py-1 text-xs font-semibold tracking-[0.18em] text-ink uppercase backdrop-blur">
                Boulangerie · Made with love
              </span>
            </div>
          </Reveal>

          {/* Pasos */}
          <ol className="grid gap-6 lg:gap-0">
            {PROCESS_STEPS.map((s, i) => (
              <li
                key={s.key}
                className="story-step flex gap-5 lg:min-h-[62vh] lg:items-center"
                data-step={i}
                data-testid="story-step"
              >
                <span className="relative block h-20 w-20 shrink-0 overflow-hidden rounded-[18px] lg:hidden">
                  <StepVisual step={s.key} title={s.title} photo={photos[s.key]} priority={false} />
                </span>
                <Reveal
                  as="div"
                  variant="up"
                  delay={i * 40}
                  className="max-w-md"
                  style={{ "--i": i } as CSSProperties}
                >
                  <p className="font-display text-sm tracking-[0.2em] text-sage">
                    {s.number} <span className="text-ink-2/70 uppercase">·</span>{" "}
                    <span className="uppercase">{s.title}</span>
                  </p>
                  <h3 className="display mt-2 text-2xl sm:text-3xl">{s.title}</h3>
                  <p className="mt-3 text-base text-ink-2 sm:text-lg">{s.body}</p>
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </ProcessSteps>
    </section>
  );
}

function StepVisual({
  step,
  title,
  photo,
  priority,
}: {
  step: ProcessStepKey;
  title: string;
  photo?: StoryPhoto;
  priority: boolean;
}) {
  if (photo)
    return (
      <Image
        src={photo.src}
        alt={photo.alt}
        width={photo.width}
        height={photo.height}
        sizes="(min-width: 1024px) 460px, 80px"
        priority={priority}
        className="h-full w-full object-cover"
      />
    );
  return <ProcessArt step={step} title={title} decorative className="h-full w-full" />;
}
