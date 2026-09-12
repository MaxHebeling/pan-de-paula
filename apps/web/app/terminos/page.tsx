import type { Metadata } from "next";
import { getBusiness } from "@/lib/site";

export const metadata: Metadata = {
  title: "Términos y condiciones",
  alternates: { canonical: "/terminos" },
};

export default async function TermsPage() {
  const b = await getBusiness();
  const custom = b.policies.terms;
  return (
    <div className="container-x max-w-3xl py-10 sm:py-14">
      <p className="eyebrow mb-2">Legal</p>
      <h1 className="display text-4xl">Términos y condiciones</h1>
      {custom ? (
        <div className="prose-warm mt-8 text-ink-2">
          {custom.split(/\n{2,}/).map((p, i) => (
            <p key={i} className="whitespace-pre-line">
              {p}
            </p>
          ))}
        </div>
      ) : (
        <div className="prose-warm mt-8 space-y-6 text-ink-2">
          <section>
            <h2 className="font-display text-2xl text-ink">Pedidos</h2>
            <p>
              Los pedidos en línea se preparan para la fecha de recolección que eliges al finalizar
              tu compra. Recibimos pedidos hasta la hora límite indicada para cada fecha. El pedido
              queda confirmado cuando ves tu folio en pantalla.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Precios y pago</h2>
            <p>
              Los precios se muestran en pesos mexicanos e incluyen impuestos cuando aplica. Puedes
              pagar al recoger o, cuando esté disponible, en línea o por transferencia. Un pedido
              por transferencia se considera pagado cuando confirmamos la recepción.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Recolección</h2>
            <p>
              Recoge tu pedido en el punto y horario indicados. Si no puedes pasar, avísanos por
              WhatsApp antes de la fecha para reprogramar. Por tratarse de producto fresco, los
              pedidos no recogidos el día programado no se conservan.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Cambios y cancelaciones</h2>
            <p>
              Puedes modificar o cancelar tu pedido escribiéndonos antes de la hora límite de
              pedidos de esa fecha. Después de ese momento el pan ya está en producción y no es
              posible cancelar.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Alérgenos</h2>
            <p>
              Nuestros productos se elaboran en un mismo espacio donde se usan trigo, huevo, lácteos
              y frutos secos. Si tienes una alergia, consúltanos antes de pedir.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Club de clientes</h2>
            <p>
              Los puntos y recompensas del club son personales e intransferibles, no tienen valor en
              efectivo y pueden ajustarse o terminar con aviso previo en este sitio.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
