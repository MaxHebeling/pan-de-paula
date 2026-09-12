import Link from "next/link";
import { WEEKDAY_LABELS } from "@pdp/domain";
import { hourRange } from "@/lib/format";
import { fullAddress, whatsappLink, type Business } from "@/lib/site";
import { Logo } from "./Logo";

export function Footer({ business }: { business: Business }) {
  const address = fullAddress(business);
  const wa = whatsappLink(business, "Hola, El Pan de Paula 👋");
  const openDays = business.hours.filter((h) => h.isOpen && h.opensAt && h.closesAt);
  return (
    <footer className="mt-20 border-t border-line/70 bg-cream-2/60">
      <div className="container-x grid gap-10 py-12 md:grid-cols-4">
        <div className="md:col-span-1">
          <Logo size={72} />
          <p className="mt-4 font-display text-xl text-ink">{business.name}</p>
          {business.tagline && <p className="text-sm text-ink-2">{business.tagline}</p>}
        </div>
        <div>
          <h2 className="eyebrow mb-3">Horarios</h2>
          {openDays.length > 0 ? (
            <ul className="space-y-1 text-sm text-ink-2">
              {openDays.map((h) => (
                <li key={h.weekday} className="flex justify-between gap-4">
                  <span>{WEEKDAY_LABELS[h.weekday]}</span>
                  <span className="tabular-nums">{hourRange(h.opensAt, h.closesAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-2">Consulta nuestros horarios en Instagram.</p>
          )}
          <Link
            href="/horarios"
            className="mt-3 inline-block text-sm font-medium text-sage hover:underline"
          >
            Ver horarios y fechas de entrega
          </Link>
        </div>
        <div>
          <h2 className="eyebrow mb-3">Encuéntranos</h2>
          <address className="text-sm text-ink-2 not-italic">
            {address ? <p>{address}</p> : <p>Dirección disponible en Instagram y WhatsApp.</p>}
            {business.phone && (
              <p className="mt-1">
                <a
                  href={`tel:${business.phone.replace(/[^0-9+]/g, "")}`}
                  className="hover:text-sage"
                >
                  {business.phone}
                </a>
              </p>
            )}
            {business.email && (
              <p className="mt-1">
                <a href={`mailto:${business.email}`} className="hover:text-sage">
                  {business.email}
                </a>
              </p>
            )}
          </address>
          <div className="mt-3 flex flex-wrap gap-3 text-sm font-medium">
            {business.instagramHandle && (
              <a
                href={`https://www.instagram.com/${business.instagramHandle}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sage hover:underline"
              >
                Instagram @{business.instagramHandle}
              </a>
            )}
            {wa && (
              <a
                href={wa}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sage hover:underline"
              >
                WhatsApp
              </a>
            )}
          </div>
        </div>
        <div>
          <h2 className="eyebrow mb-3">Explora</h2>
          <ul className="space-y-1.5 text-sm text-ink-2">
            <li>
              <Link href="/menu" className="hover:text-sage">
                Menú
              </Link>
            </li>
            <li>
              <Link href="/club" className="hover:text-sage">
                Club de clientes
              </Link>
            </li>
            <li>
              <Link href="/unete" className="hover:text-sage">
                Únete al club
              </Link>
            </li>
            <li>
              <Link href="/nosotros" className="hover:text-sage">
                Nosotros
              </Link>
            </li>
            <li>
              <Link href="/privacidad" className="hover:text-sage">
                Aviso de privacidad
              </Link>
            </li>
            <li>
              <Link href="/terminos" className="hover:text-sage">
                Términos y condiciones
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-line/60">
        <div className="container-x flex flex-col gap-2 py-5 text-xs text-ink-2 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {business.legalName ?? business.name}. Hecho con amor.
          </p>
          <p>Panadería artesanal · Pedidos en línea con recolección programada.</p>
        </div>
      </div>
    </footer>
  );
}
