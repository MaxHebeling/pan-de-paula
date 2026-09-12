-- 0060_webhook_events_retry.sql — Reintentos de webhooks con backoff: marca de último intento.
-- Aditiva: la app anterior ignora la columna.

alter table webhook_events add column if not exists last_attempt_at timestamptz;

-- Reemplaza el índice de pendientes para incluir el proveedor y el último intento (consulta del cron).
drop index if exists webhook_events_pending_idx;
create index webhook_events_pending_idx on webhook_events(provider, received_at) where status in ('received','failed');
