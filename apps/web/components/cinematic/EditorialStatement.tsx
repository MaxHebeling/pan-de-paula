import Image from "next/image";
import { Reveal } from "../Reveal";
import { ScrollWords } from "./TextReveal";
import { CATEGORY_PHOTOS, SMORES } from "./photos";

const FACTS = [
  {
    title: "A mano, en tandas cortas",
    body: "Amasamos y laminamos nosotros. Sin mezclas listas ni atajos.",
  },
  {
    title: "Mantequilla de verdad",
    body: "Es lo que le da al hojaldre sus capas y su olor.",
  },
  {
    title: "Horneado para tu fecha",
    body: "Solo metemos al horno lo que ya está pedido para ese día.",
  },
];

/**
 * Manifiesto editorial: una sola idea en tipografía grande. Las palabras se encienden con el scroll
 * (app/motion.css → .cin-word); sin soporte, sin JS o con reduced motion se lee completo desde el inicio.
 */
export function EditorialStatement() {
  const almond = CATEGORY_PHOTOS.croissants!;
  return (
    <section className="cin-section" aria-labelledby="manifiesto-title">
      <div className="cin-wrap cin-manifesto-grid">
        <div className="cin-manifesto-label">
          <h2 id="manifiesto-title" className="cin-index">
            <span className="cin-index-num">01</span> Nuestra forma de hornear
          </h2>
        </div>
        <p className="cin-statement">
          <ScrollWords
            text="Horneamos poco y todos los días. Laminamos la masa a mano, usamos mantequilla de verdad y solo metemos al horno lo que ya está pedido. Por eso tu pan llega como tiene que llegar: recién hecho."
            accent={["recién", "hecho."]}
          />
        </p>

        <div className="cin-figs">
          <Reveal variant="fade" className="cin-fig cin-fig-a">
            <span className="absolute inset-x-0 -inset-y-7 block" data-parallax="0.06">
              <span className="cin-reveal-media absolute inset-0 block">
                <Image
                  src={SMORES.src}
                  alt={SMORES.alt}
                  fill
                  sizes="(min-width: 1024px) 34vw, 75vw"
                  className="cin-fig-img"
                />
              </span>
            </span>
          </Reveal>
          <Reveal variant="fade" delay={120} className="cin-fig cin-fig-b">
            <span className="cin-reveal-media absolute inset-0 block">
              <Image
                src={almond.src}
                alt={almond.alt}
                fill
                sizes="(min-width: 1024px) 26vw, 58vw"
                className="cin-fig-img"
              />
            </span>
          </Reveal>
        </div>

        <ol className="cin-facts" data-reveal-group="90">
          {FACTS.map((f, i) => (
            <Reveal as="li" key={f.title} className="cin-fact">
              <span className="cin-fact-num" aria-hidden="true">
                0{i + 1}
              </span>
              <div>
                <h3 className="cin-fact-title">{f.title}</h3>
                <p className="cin-fact-body">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
