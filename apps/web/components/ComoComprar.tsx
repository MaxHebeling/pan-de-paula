/**
 * Las dos formas de comprar, con el texto que indicó el negocio (2026-11-07). Se usa en la portada y en
 * /horarios.
 *
 * El día y la hora de cierre están escritos aquí a propósito, tal cual los redactó el negocio. Si cambia
 * la ventana de pedidos en CRM → Configuración, este texto hay que cambiarlo a mano también.
 *
 * `pedidosAbiertos` es falso cuando no hay fechas abiertas: entonces no se promete recibir pedidos, y la
 * venta presencial sigue visible.
 */
export function ComoComprar({
  pedidosAbiertos,
  className,
}: {
  pedidosAbiertos: boolean;
  className?: string;
}) {
  return (
    <div className={`space-y-3 text-ink-2 ${className ?? ""}`} data-testid="como-comprar">
      {pedidosAbiertos && (
        <p>
          <strong className="font-semibold text-ink">Pedidos anticipados:</strong> Recibimos pedidos
          a través de nuestra página web de lunes a jueves, hasta el jueves a las 10 PM, para
          recoger el viernes.
        </p>
      )}
      <p>
        <strong className="font-semibold text-ink">Venta presencial:</strong> Todos los viernes
        abrimos nuestra vitrina a las 6 PM en París 410, Costa Azul, con pan recién horneado y
        variedad disponible hasta agotar existencias.
      </p>
      <p className="text-sm">
        No es necesario hacer un pedido anticipado para visitarnos el viernes. Siempre preparamos
        producto para tener nuestra vitrina disponible para quienes deciden venir directamente,
        incluso si no ordenaron durante la semana.
      </p>
    </div>
  );
}
