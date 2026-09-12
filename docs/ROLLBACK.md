# Rollback

Regla: **la aplicación se revierte; la base de datos se corrige hacia adelante.** Las migraciones son aditivas
y compatibles con la versión anterior de la app, por eso volver al deployment previo en Vercel es seguro e
instantáneo sin tocar la base.

## 1. Detectar

- `scripts/smoke.sh` falló después del deploy, o `/api/ready` devuelve 503, o Sentry/soporte reportan errores
  nuevos justo después del tag `deploy-production-…`.
- Confirma la versión en producción: `curl -s https://admin.elpandepaula.mx/api/health | jq .version` y compárala
  con el sha del último tag (`git tag --list 'deploy-production-*' | tail -2`) y con `.deploys-production.log`.

## 2. Revertir la aplicación (minutos)

```bash
pnpm rollback                 # = bash scripts/rollback.sh all  → web y admin al deployment anterior
bash scripts/rollback.sh admin                 # solo el CRM
bash scripts/rollback.sh web <deployment-url>  # a un deployment específico (vercel ls --prod para verlo)
```

`scripts/rollback.sh` ejecuta `vercel rollback` en `apps/web` y/o `apps/admin` (promueve el deployment
anterior; no hay rebuild). Después:

```bash
bash scripts/smoke.sh https://elpandepaula.mx https://admin.elpandepaula.mx
curl -s https://admin.elpandepaula.mx/api/health | jq .version   # debe ser el sha del LAST KNOWN GOOD
```

Si `vercel rollback` no está disponible en el plan, en el dashboard: Deployments → deployment anterior →
"Promote to Production". Equivalente.

## 3. La base de datos

**No se hace `DROP` ni se edita una migración aplicada.** Opciones, de menor a mayor impacto:

| Situación                                                     | Acción                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La migración nueva es correcta pero la app nueva falla        | Solo rollback de app. La app vieja ignora las columnas/tablas nuevas.                                                                                                                                                                                                         |
| La migración tiene un bug (constraint mal, función con error) | **Migración correctiva** con el siguiente número del rango del módulo (`create or replace function…`, `alter table … drop constraint…`). PR → CI → `deploy.sh`.                                                                                                               |
| La migración corrompió datos (update masivo equivocado)       | Corrección por SQL en una migración o script auditado; si es irreversible, restaurar desde el respaldo `pre-deploy-<sha>` o PITR al minuto anterior al deploy (ver `BACKUP_RESTORE.md`). La restauración pierde lo escrito después; coordínalo con el negocio (POS detenido). |
| Falló `pnpm db:migrate` a la mitad                            | Cada archivo va en su transacción: la base quedó en el último archivo aplicado. Corrige el archivo **solo si nunca se aplicó en ningún ambiente publicado** (no está en `RELEASED`); si ya se aplicó en staging, crea uno nuevo.                                              |

Registrar en `schema_migrations` una migración "como aplicada" a mano solo en emergencias documentadas en el postmortem.

## 4. Feature flags primero

Antes de revertir código, revisa si el problema se apaga con un flag en `feature_flags`
(`web_checkout`, `mercadopago_online`, `mercadopago_point`, `mercadopago_qr`, `instagram_bot`,
`instagram_ai_replies`, `ingredient_consumption`, `email_receipts`, `loyalty`, `pos_offline_queue`):

```sql
update feature_flags set enabled = false where key = 'mercadopago_online';
```

Efecto inmediato, sin deploy, auditado en `audit_logs`.

## 5. Después del rollback

1. Anota en `.deploys-production.log` y en el canal del equipo: qué se revirtió, a qué sha, hora.
2. Abre el postmortem (`INCIDENT_RESPONSE.md`).
3. El fix vuelve por el flujo normal: rama → PR → CI → `deploy:staging` → `deploy:prod`. Nunca un hotfix directo en Vercel.
