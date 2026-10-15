-- 0083_qr_token_url_safe.sql — los qr_token nuevos nacen seguros para una URL.
--
-- La 0004 los genera con `encode(gen_random_bytes(18), 'base64')`, que es base64 ESTÁNDAR: su
-- alfabeto incluye `+` y `/`. `cardUrl` los codifica (`%2B`, `%2F`) y la URL resultante es correcta,
-- pero el QR impreso lo lee una cámara y muchas decodifican antes de navegar. Medido contra
-- producción el 15/10/2026, con el MISMO token:
--
--   /mi-tarjeta/<token con %2F>  → 200
--   /mi-tarjeta/<token con / >   → 404   (el lector decodificó: la ruta de un segmento no coincide)
--   /mi-tarjeta/<token con %20>  → 404   (el lector trató el `+` como espacio)
--
-- Afectaba a 9 de los 14 socios: 4 con `/`, 6 con `+`, uno con ambos. De ahí que fallara "solo a
-- algunos" y pareciera aleatorio.
--
-- Esta migración solo cambia el DEFAULT de la columna: usa base64url (`-` y `_` en lugar de `+` y
-- `/`), que no necesita escaparse en una URL. No toca ni una fila existente a propósito — las
-- tarjetas ya repartidas siguen valiendo, y su caso lo resuelve el código: la ruta pasa a ser
-- comodín (`[...token]`) y vuelve a unir los segmentos, y `decodeToken` restituye el `+` que llegó
-- como espacio. Ningún socio cambia de identidad ni necesita un QR nuevo.
--
-- Reversión: `alter table customers alter column qr_token set default encode(gen_random_bytes(18), 'base64');`
-- Es seguro revertir: los tokens ya generados no se recalculan nunca.

alter table customers
  alter column qr_token
  set default translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_');

comment on column customers.qr_token is
  'Token opaco de la tarjeta. Los nuevos son base64url (seguro en URL); los históricos son base64 estándar y pueden llevar + y /. Ambos alfabetos se aceptan al resolver.';
