/** Oculta la navegación del CRM al imprimir (la barra lateral y el encabezado del shell). */
export function PrintStyles() {
  return (
    <style>{`@media print {
  aside, header, nav, .no-print { display: none !important; }
  main { padding: 0 !important; }
  .card { box-shadow: none !important; border-color: #ccc !important; break-inside: avoid; }
  body { background: #fff !important; }
  @page { margin: 12mm; }
}`}</style>
  );
}
