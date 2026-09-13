import Image from "next/image";
import { ProcessArt, type ProcessStepKey } from "../ProcessArt";
import { ProcessSteps } from "../ProcessSteps";
import { Reveal } from "../Reveal";
import { SectionHeading } from "./SectionHeading";

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
 * "Del horno a tu mesa". Desktop: panel fijo (sticky) cuya capa cambia según el paso que está en la banda
 * central del viewport (ProcessSteps, IntersectionObserver) + barras de progreso 01–04. Móvil: lista vertical
 * con su ilustración, sin sticky. `photos` sustituye el arte por fotografías reales de public/story.
 */
export function StickyStory({ photos }: { photos: Partial<Record<ProcessStepKey, StoryPhoto>> }) {
  return (
    <section id="proceso" className="cin-section story" aria-labelledby="proceso-title">
      <div className="cin-wrap">
        <SectionHeading
          id="proceso-title"
          index="04"
          eyebrow="Así trabajamos"
          title="Del horno a tu mesa"
          intro="Cuatro pasos, siempre los mismos. Por eso sabe igual cada semana."
        />
        <ProcessSteps>
          <div className="cin-story-grid">
            <div className="cin-story-visual" aria-hidden="true" data-testid="story-art">
              <div className="cin-story-frame">
                {PROCESS_STEPS.map((s, i) => (
                  <div key={s.key} className="story-art-layer" data-step={i}>
                    <StepVisual step={s.key} title={s.title} photo={photos[s.key]} large />
                    <span className="cin-story-layer-label">
                      {s.number} / 04 · {s.title}
                    </span>
                  </div>
                ))}
                <span className="cin-story-tag">Boulangerie · Made with love</span>
                <span className="cin-story-bars">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </div>

            <ol className="cin-story-steps">
              {PROCESS_STEPS.map((s, i) => (
                <li
                  key={s.key}
                  className="story-step cin-story-step"
                  data-step={i}
                  data-testid="story-step"
                >
                  <span className="cin-story-thumb" aria-hidden="true">
                    <StepVisual step={s.key} title={s.title} photo={photos[s.key]} />
                  </span>
                  <Reveal delay={i * 40}>
                    <p className="cin-story-num" aria-hidden="true">
                      {s.number}
                    </p>
                    <h3 className="cin-story-title">{s.title}</h3>
                    <p className="cin-story-body">{s.body}</p>
                  </Reveal>
                </li>
              ))}
            </ol>
          </div>
        </ProcessSteps>
      </div>
    </section>
  );
}

function StepVisual({
  step,
  title,
  photo,
  large = false,
}: {
  step: ProcessStepKey;
  title: string;
  photo?: StoryPhoto;
  large?: boolean;
}) {
  if (photo)
    return (
      <Image
        src={photo.src}
        alt=""
        fill
        sizes={large ? "(min-width: 1024px) 45vw, 1px" : "72px"}
        className="object-cover"
      />
    );
  return <ProcessArt step={step} title={title} decorative className="h-full w-full" />;
}
