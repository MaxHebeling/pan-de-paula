import Image from "next/image";
import Link from "next/link";
import { Reveal } from "./Reveal";

const pieces = [
  {
    src: "/editorial/almond-original.webp",
    number: "01",
    eyebrow: "Suave · Almendras",
    title: "Un final delicado",
    alt: "Croissant artesanal con glaseado blanco y almendras",
  },
  {
    src: "/editorial/pistachio-original.webp",
    number: "02",
    eyebrow: "Intenso · Pistache",
    title: "Capas que sorprenden",
    alt: "Croissant artesanal cubierto con chocolate y pistache",
  },
  {
    src: "/editorial/smores-original.webp",
    number: "03",
    eyebrow: "Irresistible · Chocolate",
    title: "Hecho para antojar",
    alt: "Croissant artesanal con chocolate, galleta y malvavisco",
  },
];

export function EditorialShowcase() {
  return (
    <section className="editorial" aria-labelledby="editorial-title">
      <div className="editorial-marquee" aria-hidden="true">
        <div>
          <span>HORNEADO PARA TI</span>
          <i>✦</i>
          <span>HECHO A MANO</span>
          <i>✦</i>
          <span>HORNEADO PARA TI</span>
          <i>✦</i>
          <span>HECHO A MANO</span>
          <i>✦</i>
        </div>
      </div>
      <div className="container-x editorial-heading">
        <Reveal variant="left">
          <p className="eyebrow">Tres maneras de enamorarte</p>
          <h2 id="editorial-title" className="editorial-title">
            La tentación
            <br />
            también se hornea.
          </h2>
        </Reveal>
        <Reveal variant="fade" delay={100} className="editorial-intro">
          <p>
            Productos reales. Preparados en pequeñas cantidades. Cada pieza tiene su propio
            carácter.
          </p>
          <Link href="/menu">Ver todas las creaciones →</Link>
        </Reveal>
      </div>
      <div className="container-x editorial-grid">
        {pieces.map((piece, index) => (
          <Reveal
            key={piece.src}
            variant="card"
            delay={index * 90}
            className={`editorial-card editorial-card-${index + 1}`}
          >
            <div className="editorial-photo-wrap" data-parallax={index === 1 ? "-18" : "14"}>
              <Image
                src={piece.src}
                alt={piece.alt}
                fill
                sizes="(max-width: 767px) 92vw, 34vw"
                className="editorial-photo"
              />
            </div>
            <div className="editorial-meta">
              <span>{piece.number}</span>
              <div>
                <p>{piece.eyebrow}</p>
                <h3>{piece.title}</h3>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
