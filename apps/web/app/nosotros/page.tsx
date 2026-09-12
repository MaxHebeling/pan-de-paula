import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { getBusiness } from "@/lib/site";

export const metadata: Metadata = {
  title: "Nosotros",
  description:
    "La historia de El Pan de Paula: una boulangerie artesanal hecha con manos, tiempo y mantequilla de verdad.",
  alternates: { canonical: "/nosotros" },
};

const FALLBACK = [
  "El Pan de Paula nació en 2023 como una boulangerie pequeña y artesanal. Amasamos, laminamos y horneamos nosotros mismos, en tandas cortas, para que cada pieza salga del horno el día que la recoges.",
  "Trabajamos con ingredientes sencillos y de verdad: harina, mantequilla, huevo, azúcar y tiempo. Nada de mezclas listas ni atajos. Por eso pedimos con anticipación: horneamos lo que ya está pedido y así evitamos desperdicio.",
  "Somos un negocio familiar. Cuando pides, sabemos tu nombre y para cuándo lo quieres. Gracias por acompañarnos.",
];

export default async function AboutPage() {
  const business = await getBusiness();
  const about = business.policies.about;
  const paragraphs = about
    ? about
        .split(/\n{2,}|\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : FALLBACK;
  return (
    <div className="container-x max-w-3xl py-10 sm:py-14">
      <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
        <Logo size={120} />
        <div>
          <p className="eyebrow mb-2">Nosotros</p>
          <h1 className="display text-4xl sm:text-5xl">Hecho con manos, tiempo y mantequilla</h1>
        </div>
      </div>
      <div className="prose-warm mt-8 text-lg text-ink-2">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      <div className="mt-10 flex flex-wrap gap-3">
        <Link href="/menu" className="btn btn-primary btn-lg">
          Ver menú
        </Link>
        <Link href="/unete" className="btn btn-secondary btn-lg">
          Únete al club
        </Link>
      </div>
    </div>
  );
}
