import Link from "next/link";
import { WEEKDAY_LABELS } from "@pdp/domain";
import { hourRange } from "@/lib/format";
import { fullAddress, instagramUrl, whatsappLink, type Business } from "@/lib/site";
import { Logo } from "./Logo";
import { Reveal } from "./Reveal";

/**
 * Crédito de autoría. El pincelazo es un SVG, no un `border-bottom`: un subrayado recto se lee como
 * un enlace cualquiera, y lo que se quiere aquí es una firma. El trazo tiene el grosor desigual
 * —entra apoyado, engorda en el centro y se levanta afilado— y se descubre de izquierda a derecha,
 * así que parece una pasada de pincel y no una barra que aparece.
 *
 * `preserveAspectRatio="none"` deja que el trazo se estire al ancho exacto de la palabra, sea el que
 * sea. Solo cubre «iKingdom», no la frase entera: una firma se pone sobre el nombre.
 */
function CreditoIkingdom() {
  return (
    <a
      href="https://www.ikingdom.org"
      target="_blank"
      rel="noopener noreferrer"
      className="group/ik inline-flex items-baseline gap-1 text-ink-2 transition-colors duration-200 hover:text-ink"
    >
      <span>Desarrollado por</span>
      <span className="pincelazo font-medium">
        iKingdom
        <svg
          className="pincelazo-trazo"
          viewBox="0 0 200 12"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {/* El perfil cuenta el gesto: apoya a la izquierda (grosor 1.6 sobre 12), engorda al
              cruzar (2.1) y se levanta afilado a la derecha (0.6), con la espina subiendo un poco.
              Con grosor constante sería un subrayado; es el adelgazamiento final lo que lo vuelve
              una pasada. Y con la diferencia muy marcada deja de parecer un pincel y parece una cuña:
              el rango va de 1.6 a 0.6, no de 2.6 a 0.8. */}
          <path
            d="M3 6.5C22 5 50 4.2 80 4.2c40 0 80 .4 117 .7l.3.6c-37.3.1-77.3.7-117.3.8-30 .1-56 .7-76.7 1.8Z"
            fill="currentColor"
          />
        </svg>
      </span>
    </a>
  );
}

/** Pie de página. Entrada progresiva sutil por columnas (jerarquía D: casi estático). */
export function Footer({ business }: { business: Business }) {
  const address = fullAddress(business);
  const wa = whatsappLink(business, "Hola, El Pan de Paula 👋");
  const ig = instagramUrl(business.instagramHandle);
  const openDays = business.hours.filter((h) => h.isOpen && h.opensAt && h.closesAt);
  return (
    <footer className="mt-20 border-t border-line/70 bg-cream-2/60">
      <div className="container-x grid gap-10 py-12 md:grid-cols-4" data-reveal-group="80">
        <Reveal variant="fade" className="md:col-span-1">
          <Logo size={72} />
          <p className="mt-4 font-display text-xl text-ink">{business.name}</p>
          {business.tagline && <p className="text-sm text-ink-2">{business.tagline}</p>}
        </Reveal>
        <Reveal variant="fade">
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
        </Reveal>
        <Reveal variant="fade">
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
            {ig && (
              <a
                href={ig}
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
        </Reveal>
        <Reveal variant="fade">
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
              <Link href="/portal/entrar" className="hover:text-sage">
                Mi cuenta
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
        </Reveal>
      </div>
      <div className="border-t border-line/60">
        <div className="container-x flex flex-col gap-2 py-5 text-xs text-ink-2 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {business.legalName ?? business.name}. Hecho con amor.
          </p>
          <p>Panadería artesanal · Pedidos en línea con recolección programada.</p>
          <p>
            <CreditoIkingdom />
          </p>
        </div>
      </div>
    </footer>
  );
}
