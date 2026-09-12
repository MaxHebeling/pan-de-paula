/** Genera pedidos.xlsx (formato ancho) para los tests. Correr: pnpm --filter @pdp/db exec tsx test/fixtures/build-pedidos-xlsx.ts */
import ExcelJS from "exceljs";
import { resolve } from "node:path";

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Pedidos");
ws.addRow([
  "Cliente",
  "Teléfono",
  "Fecha",
  "Croissant de mantequilla",
  "Croissant de chocolate",
  "Galleta de chispas",
  "Total",
  "Punto de entrega",
  "Pagado",
  "Método",
  "Notas",
]);
ws.addRow([
  "Ana López",
  "664 123 45 67",
  new Date(Date.UTC(2026, 2, 12)),
  2,
  1,
  0,
  145,
  "Mostrador",
  "sí",
  "Efectivo",
  "",
]);
ws.addRow([
  "Luis Pérez",
  "",
  "15/03/2026",
  0,
  2,
  3,
  "$200.00",
  "Casa",
  "no",
  "Transferencia",
  "paga el viernes",
]);
ws.addRow([
  "Nuevo Cliente",
  "6647778888",
  "2026-04-01",
  1,
  null,
  null,
  null,
  "",
  "",
  "Mercado Pago",
  "",
]);
ws.addRow(["Sin Items", "", "05/04/2026", null, null, null, null, "", "", "", ""]);
ws.addRow(["Ana López", "6641234567", "20/04/2026", 1, 1, 1, 300, "", "sí", "", ""]);
const ws2 = wb.addWorksheet("Resumen");
ws2.addRow(["Esta hoja no se importa"]);
const out = resolve(import.meta.dirname, "pedidos.xlsx");
await wb.xlsx.writeFile(out);
console.info(`Escrito ${out}`);
