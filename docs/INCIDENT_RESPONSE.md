# Respuesta a incidentes

## Severidades

| Sev  | Definición                                                           | Respuesta           | Ejemplos                                                                                |
| ---- | -------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| SEV1 | No se puede vender ni cobrar, o hay riesgo de perder/corromper datos | Inmediata (15 min)  | `/api/ready` 503 en admin, POS no cierra ventas, base inaccesible, fuga de credenciales |
| SEV2 | Un canal caído pero el mostrador opera                               | 1 hora              | Pedidos web no se pagan (MP), webhooks fallando, sitio público caído                    |
| SEV3 | Degradación sin impacto en ventas                                    | Siguiente día hábil | Reportes lentos, Instagram bot apagado, emails de comprobante no salen                  |

## Roles

- **Quien detecta** (caja, cocina, dueño): avisa por el canal del equipo con hora, pantalla y mensaje exacto.
  En SEV1 anota ventas en papel (hora, productos, método) para capturarlas después.
- **Responsable del incidente** (operador técnico): diagnostica, decide contención (flag, rollback, restauración),
  comunica cada 30 min en SEV1.
- **Dueño**: decide sobre pérdidas de datos (restaurar a un punto anterior) y comunicación a clientes.

## Primeros 5 minutos (cualquier severidad)

```bash
curl -s https://admin.elpandepaula.mx/api/health ; curl -s https://admin.elpandepaula.mx/api/ready
curl -s https://elpandepaula.mx/api/ready
git tag --list 'deploy-production-*' | tail -2        # ¿hubo deploy reciente? → sospechar de él
```

1. ¿Responde `/api/health` pero `/api/ready` da 503? → problema de base/pooler (Supabase status, límites de conexiones).
2. ¿Ninguno responde? → Vercel status / dominio / deployment roto → `ROLLBACK.md`.
3. ¿Ambos 200 pero la operación falla? → error de lógica: Sentry/logs → runbook correspondiente.
4. ¿Se puede contener apagando un flag? (`update feature_flags set enabled=false where key=…`). Hazlo primero, arregla después.

## Runbooks

### R1 · Mercado Pago aprueba pero el pedido sigue "pago pendiente"

Síntoma: el cliente muestra el comprobante de MP; en `/pedidos` el pedido está `payment_pending`/`new`.

1. Localiza el pedido y sus pagos:
   ```sql
   select o.id, o.folio, o.status, o.payment_status, o.total_cents, o.paid_cents,
          p.id as payment_id, p.status as pay_status, p.external_id, p.external_status
   from orders o left join payments p on p.order_id = o.id
   where o.folio = 'PDP-2026-000123';
   ```
2. ¿Llegó el webhook?
   ```sql
   select external_id, event_type, status, attempts, last_error, received_at, processed_at
   from webhook_events where provider = 'mercadopago' and payload::text like '%<order_id o payment_id>%'
   order by received_at desc;
   ```
   - **No hay fila** → MP no entregó la notificación (URL/secret mal, o caída). Verifica en el panel de MP →
     Webhooks → historial y reintenta desde ahí; revisa `MERCADOPAGO_WEBHOOK_SECRET` y que la ruta esté publicada.
   - **`failed`** → lee `last_error`. Causas típicas: firma inválida (secret cambiado), API de MP sin responder
     (circuit breaker), pedido inexistente (`external_reference` distinto).
   - **`processed`** pero el pedido sigue pendiente → el estado consultado a la API no era `approved` en ese momento
     (p. ej. `in_process`). Sigue al paso 3.
3. Consulta el estado real en la API de MP (nunca confíes en la captura del cliente):
   `GET https://api.mercadopago.com/v1/payments/{payment_id}` con el `MERCADOPAGO_ACCESS_TOKEN`. Toma
   `status`, `transaction_amount`, `external_reference`.
4. Aplica el resultado con la función idempotente (misma que usa el webhook). Como staff, en una transacción:
   ```sql
   begin;
   select set_config('app.staff_id', '<tu staff uuid>', true);
   select apply_mercadopago_payment(jsonb_build_object(
     'order_id', '<order uuid>', 'external_id', '<payment_id de MP>', 'mp_status', 'approved',
     'amount_cents', <transaction_amount * 100>, 'method', 'mercadopago',
     'raw', jsonb_build_object('manual', true, 'by', '<tu email>')));
   commit;
   ```
   Si el pago ya existía como `pending` pasa a `paid` y se llama `finalize_sale` (venta, inventario, puntos).
   Si se llama dos veces devuelve `duplicate: true` sin efectos.
5. Verifica: pedido `paid`, fila en `sales`, movimiento `SALE`, notificación `new_order`. Avisa al cliente.
6. Si el webhook estaba `failed`, márcalo `processed` con nota en `last_error` ("aplicado manualmente por …")
   para que no vuelva a reintentarse.
7. Postmortem si fue un fallo sistemático (secret, ruta, breaker abierto por caída de MP).

### R2 · El stock no cuadra

Síntoma: el sistema dice 14 croissants y en la vitrina hay 9 (o al revés).

1. Deriva interna (nivel vs movimientos): consulta "Deriva de inventario" de `MONITORING.md`. Si hay filas,
   `select rebuild_inventory_levels();` y abre postmortem (alguien escribió fuera de las funciones).
2. Reconstruye la historia del producto en el periodo:
   ```sql
   select * from inventory_reconciliation(now() - interval '1 day', now()) where product_id = '<id>';
   select type, qty, ref_type, ref_id, reason, staff_id, occurred_at from inventory_movements
   where product_id = '<id>' and occurred_at > now() - interval '1 day' order by occurred_at;
   ```
   Busca: producción no registrada (entró pan sin lote), mermas no capturadas, ventas anuladas sin `VOID`,
   ventas "por fuera" del POS, ventas históricas importadas (no mueven stock: correcto).
3. Corrige la **causa** con el registro que faltó (producción con fecha real, merma con motivo) — no con una
   corrección genérica — para que el reporte de rentabilidad sea real.
4. Si no se puede explicar: conteo físico en `/inventario` → aplicar (`apply_stock_count`) → movimientos
   `CORRECTION` con motivo `difference`. Queda el rastro.
5. Si se repite en el mismo producto/turno: revisar proceso (quién hornea sin registrar, cortesías sin merma).

### R3 · No se puede vender en POS

1. `/api/ready` del admin: 503 → base. Revisa Supabase (status, conexiones del pooler, disco). Si es el pooler
   saturado: hay `max: 3` conexiones por función en Vercel; busca funciones colgadas o loops; reinicia el pooler.
   Mientras tanto **ventas en papel**.
2. `/api/ready` 200 pero el cobro falla con mensaje:
   | Mensaje                                  | Causa                                     | Acción                                                                                                |
   | ---------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
   | "La caja no está abierta"                | Sin `register_sessions` `open`            | Abrir caja en `/caja`                                                                                 |
   | "Stock insuficiente para …"              | `allow_negative_stock=false` y sin piezas | Registrar producción; o activar stock negativo temporalmente en `/configuracion`                      |
   | "Producto … no tiene precio configurado" | `current_price_cents` null                | Asignar precio regular en `/precios`                                                                  |
   | "Producto … no está disponible"          | `is_active=false`                         | Activar en `/productos`                                                                               |
   | "Cupón inválido: …"                      | Regla del cupón                           | No se fuerza; explicar al cliente                                                                     |
   | "El pago excede el total"                | Monto capturado mal                       | Corregir monto                                                                                        |
   | "La operación tardó demasiado" (57014)   | `statement_timeout` 20 s                  | Revisar bloqueo: `select * from pg_stat_activity where state <> 'idle' and wait_event_type = 'Lock';` |
3. La pantalla no carga o redirige a login: sesión expirada (14 días) o `SESSION_SECRET` rotado en el último
   deploy (cierra todas las sesiones): volver a entrar. Si `/403`: falta permiso `pos.sell` en su rol.
4. Deploy reciente y todo lo anterior descartado → `ROLLBACK.md`.
5. Al recuperar: capturar las ventas en papel en el POS (misma fecha; el cliente puede asignarse para puntos)
   y hacer conteo físico al cierre.

### R4 · Problemas de login

| Síntoma                                        | Diagnóstico / acción                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| "Cuenta bloqueada"                             | 5 fallos → `locked_until` 15 min. Desbloquear ya: `update staff_users set failed_logins = 0, locked_until = null where email = '…';`      |
| "Demasiados intentos"                          | 30 fallos desde la misma IP en 15 min (`login_attempts`). Esperar o revisar si es un ataque (consulta en `MONITORING.md`).                |
| Contraseña olvidada                            | `/recuperar` → token de un uso (`password_reset_tokens`, requiere email configurado). Sin email: un `owner` la restablece en `/usuarios`. |
| Usuario correcto pero "credenciales inválidas" | `is_active=false` o `deleted_at` no nulo → reactivar en `/usuarios`. Verifica mayúsculas del email (citext: no importa) y espacios.       |
| Todos fueron expulsados a la vez               | Se rotó `SESSION_SECRET` o se limpiaron `staff_sessions`. Esperado tras rotación; comunicar.                                              |
| Login funciona en local pero no en prod        | Cookie `Secure` requiere HTTPS; dominio del admin distinto al de la cookie; revisar `NEXT_PUBLIC_ADMIN_URL`.                              |

Auditoría de accesos: `select email, ip, success, created_at from login_attempts order by created_at desc limit 50;`

### R5 · Deploy dejó producción rota

`ROLLBACK.md` (app en minutos; base hacia adelante).

### R6 · Sospecha de fuga de credenciales

1. Rota la credencial afectada en su origen (MP, Meta, Resend, Supabase `pdp_app`, `SESSION_SECRET`) y en Vercel; redeploy.
2. Revisa `audit_logs` y `login_attempts` del periodo; desactiva usuarios sospechosos.
3. `pnpm check:secrets` en el repo; revisa el historial de git si algo se subió (rota igual aunque se borre).

## Plantilla de postmortem (sin culpas)

```
# Postmortem — <título corto> — <fecha>
Severidad: SEV_   Duración: hh:mm (detección → mitigación → resolución)
Impacto: ventas afectadas / pedidos / clientes / datos

## Línea de tiempo (hora local)
- 10:32 primer síntoma (quién lo vio, cómo)
- 10:40 detección por …
- 10:55 mitigación: …
- 11:30 resolución: …

## Causa raíz
Qué falló exactamente y por qué el sistema lo permitió.

## Qué funcionó / qué no
Detección, runbook, comunicación, respaldos.

## Acciones (con dueño y fecha)
- [ ] Corrección permanente (PR #…)
- [ ] Test que lo habría atrapado
- [ ] Alerta/monitor nuevo
- [ ] Actualizar runbook/doc
```

Guarda los postmortems en `docs/postmortems/AAAA-MM-DD-titulo.md`.
