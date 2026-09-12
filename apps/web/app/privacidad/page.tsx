import type { Metadata } from "next";
import { getBusiness } from "@/lib/site";

export const metadata: Metadata = {
  title: "Aviso de privacidad",
  alternates: { canonical: "/privacidad" },
};

export default async function PrivacyPage() {
  const b = await getBusiness();
  const custom = b.policies.privacy;
  const responsible = b.legalName ?? b.name;
  const contact = b.email ?? b.whatsapp ?? b.phone ?? "nuestros canales de atención";
  return (
    <div className="container-x max-w-3xl py-10 sm:py-14">
      <p className="eyebrow mb-2">Legal</p>
      <h1 className="display text-4xl">Aviso de privacidad</h1>
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
            <h2 className="font-display text-2xl text-ink">Responsable</h2>
            <p>
              {responsible} es responsable del tratamiento de los datos personales que nos
              proporcionas a través de este sitio, en la panadería y por nuestros canales de
              mensajería.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Datos que recabamos</h2>
            <p>
              Nombre, teléfono, correo electrónico (opcional), fecha de cumpleaños (opcional),
              dirección de entrega cuando aplica, historial de pedidos y puntos del club.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Para qué los usamos</h2>
            <p>
              Para preparar y entregar tus pedidos, avisarte cuando estén listos, administrar tu
              tarjeta del club (puntos, niveles y recompensas) y, solo si lo aceptas expresamente,
              enviarte novedades y promociones.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Pagos</h2>
            <p>
              Los pagos en línea se procesan en las plataformas de los proveedores de pago. No
              almacenamos datos de tarjetas.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Tus derechos</h2>
            <p>
              Puedes acceder, rectificar, cancelar u oponerte al uso de tus datos (derechos ARCO) y
              retirar tu consentimiento para comunicaciones en cualquier momento escribiendo a{" "}
              {contact}.
            </p>
          </section>
          <section>
            <h2 className="font-display text-2xl text-ink">Cambios</h2>
            <p>Cualquier cambio a este aviso se publicará en esta página.</p>
          </section>
        </div>
      )}
    </div>
  );
}
