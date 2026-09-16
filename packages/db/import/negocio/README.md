# Datos del negocio

Cambios de configuración comercial que el dueño pidió y que conviene dejar escritos y reproducibles
(el CRM permite editarlos a mano en Configuración; estos archivos documentan el estado esperado).

| Archivo                          | Qué deja configurado                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `2026-09-16-horario-viernes.sql` | Atención y entrega solo viernes 18:00–22:00; pedidos cualquier día con cierre el miércoles 18:00. |

Aplicar (idempotente):

```bash
bash scripts/datos-negocio.sh staging packages/db/import/negocio/2026-09-16-horario-viernes.sql
bash scripts/datos-negocio.sh production packages/db/import/negocio/2026-09-16-horario-viernes.sql --apply
```

Sin `--apply` solo muestra el estado actual y el que quedaría (simulación dentro de una transacción que se revierte).
