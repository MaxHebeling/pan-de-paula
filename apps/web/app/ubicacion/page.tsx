import type { Metadata } from "next";
import { fullAddress, getBusiness, whatsappLink } from "@/lib/site";

export const metadata: Metadata = {
  title: "Ubicación",
  description: "Dónde recoger tu pedido de El Pan de Paula y cómo contactarnos.",
  alternates: { canonical: "/ubicacion" },
};

export default async function LocationPage() {
  const business = await getBusiness();
  const address = fullAddress(business);
  const wa = whatsappLink(business, "Hola, ¿me comparten la ubicación de la panadería?");
  const points = business.pickupPoints;
  const mapEmbed = business.policies.map_embed_url;
  return (
    <div className="container-x max-w-4xl py-10 sm:py-14">
      <p className="eyebrow mb-2">Ubicación</p>
      <h1 className="display text-4xl sm:text-5xl">Dónde recoger tu pan</h1>
      {address ? (
        <p className="mt-3 text-lg text-ink-2">{address}</p>
      ) : (
        <p className="mt-3 text-lg text-ink-2">
          Te compartimos la dirección exacta al confirmar tu pedido o por mensaje.
        </p>
      )}

      <div className="mt-8 grid gap-5 md:grid-cols-2">
        {points.map((p) => (
          <section key={p.id} className="card p-6">
            <h2 className="font-display text-2xl text-ink">{p.name}</h2>
            {p.address && p.address !== "Dirección por configurar" && (
              <p className="mt-2 text-ink-2">
                {p.address}
                {p.city ? `, ${p.city}` : ""}
              </p>
            )}
            {p.notes && <p className="mt-2 text-sm text-ink-2">{p.notes}</p>}
            {p.mapUrl && (
              <a
                href={p.mapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary mt-4"
              >
                Abrir en el mapa
              </a>
            )}
          </section>
        ))}
        <section className="card p-6">
          <h2 className="font-display text-2xl text-ink">Contacto</h2>
          <ul className="mt-3 space-y-2 text-ink-2">
            {business.phone && (
              <li>
                Teléfono:{" "}
                <a
                  href={`tel:${business.phone.replace(/[^0-9+]/g, "")}`}
                  className="text-sage underline"
                >
                  {business.phone}
                </a>
              </li>
            )}
            {wa && (
              <li>
                <a
                  href={wa}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sage underline"
                >
                  Escríbenos por WhatsApp
                </a>
              </li>
            )}
            {business.instagramHandle && (
              <li>
                Instagram:{" "}
                <a
                  href={`https://www.instagram.com/${business.instagramHandle}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sage underline"
                >
                  @{business.instagramHandle}
                </a>
              </li>
            )}
            {business.email && (
              <li>
                Correo:{" "}
                <a href={`mailto:${business.email}`} className="text-sage underline">
                  {business.email}
                </a>
              </li>
            )}
          </ul>
        </section>
      </div>

      {mapEmbed && (
        <div className="card mt-8 overflow-hidden">
          <iframe
            src={mapEmbed}
            title="Mapa de la panadería"
            className="h-80 w-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
          />
        </div>
      )}
    </div>
  );
}
