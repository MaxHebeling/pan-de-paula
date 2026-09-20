import Link from "next/link";

export const metadata = { title: "Sin conexión", robots: { index: false, follow: false } };

/**
 * Lo que se ve al abrir la aplicación sin internet. A propósito no muestra ningún dato guardado: el
 * estado de un pedido cambia solo, y enseñar una copia vieja como si fuera la de ahora sería peor
 * que no enseñar nada.
 */
export default function OfflinePage() {
  return (
    <div className="container-x max-w-lg py-16 text-center">
      <p className="eyebrow">Sin conexión</p>
      <h1 className="mt-2 font-display text-3xl text-ink">No pudimos conectarnos</h1>
      <p className="mt-3 text-ink-2">
        El estado de tus pedidos se actualizará en cuanto recuperes internet. No te mostramos datos
        guardados para no enseñarte algo que ya cambió.
      </p>
      <Link href="/portal" className="btn btn-sage mt-6">
        Reintentar
      </Link>
    </div>
  );
}
