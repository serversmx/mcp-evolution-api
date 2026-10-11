# Changelog

## 0.4.0 — Unreleased

Modo remoto para usar el servidor desde ChatGPT y las apps de Claude, y anotaciones MCP en todas las
herramientas. Guía completa en [docs/remote-deployment.md](docs/remote-deployment.md).

### Añadido

- Modo HTTP opcional (`MCP_TRANSPORT=http`): Streamable HTTP sin estado (un Server y un transporte
  nuevos por petición) para conectores remotos de Claude, Claude Code y ChatGPT. stdio sigue siendo el
  modo por defecto y no carga express ni jose.
- El modo HTTP no arranca sin una decisión de autenticación explícita: `bearer` (`MCP_AUTH_TOKEN`,
  uno o varios tokens de al menos 32 caracteres separados por comas para rotarlos, comparados como
  digest SHA-256 en tiempo constante), `oauth` (servidor de recursos para un IdP externo) o `none`,
  solo con `MCP_ALLOW_UNAUTHENTICATED=true` detrás de un gateway que autentique.
- OAuth: valida issuer, audience (`MCP_PUBLIC_URL` por defecto), expiración con 30 s de tolerancia,
  los `sub` permitidos (`MCP_OAUTH_ALLOWED_SUBJECTS`) y scopes opcionales; JWKS de
  `MCP_OAUTH_JWKS_URL` o por descubrimiento OIDC/RFC 8414. Metadatos RFC 9728 en
  `/.well-known/oauth-protected-resource<ruta>` y en la raíz; 401 con `WWW-Authenticate` y
  `resource_metadata`; 500 sin desafío si el IdP no responde. El log explica cada rechazo sin mostrar
  el token.
- Un usuario autenticado cuyo `sub` no está permitido recibe 403 sin `WWW-Authenticate`, para que el
  cliente no repita el inicio de sesión en bucle.
- Protecciones HTTP: Host validado, Origin fuera de `MCP_ALLOWED_ORIGINS` → 403 (comparado como
  `scheme://host[:puerto]`, y cada rechazo de Host u Origin queda en el log con su valor), GET/DELETE → 405,
  cuerpo limitado por `EVOLUTION_MAX_MESSAGE_BYTES` (413), `/health` sin token, log de acceso sin
  cabeceras ni cuerpos y apagado ordenado con SIGTERM.
- Todas las respuestas llevan `Cache-Control: no-store`: un CDN que guarda los GET por defecto (p. ej.
  una regla de caché de Cloudflare que respeta al origen) no puede servir un `/health` viejo ni un 404
  de los metadatos OAuth después de un cambio.
- En modo HTTP, `EVOLUTION_MAX_RESULT_BYTES` vale 150000 por defecto (claude.ai limita cada resultado
  a unos 150 000 caracteres); por stdio sigue en 4 MiB.
- Imagen Docker: `MCP_HOST=0.0.0.0`, `EXPOSE 3000` y un `HEALTHCHECK` sobre `/health` que no hace
  nada en modo stdio. El puerto es `MCP_PORT`, si no `PORT`, si no 3000. En Easypanel basta con las
  variables de entorno.
- Anotaciones MCP en las 169 herramientas (`title`, `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) desde un mapa explícito en `src/tools/annotations.ts`: las 65
  lecturas no piden confirmación en ChatGPT y Claude puede ejecutarlas sin preguntar; las 79
  destructivas (borrados, logout, bloqueos, sobrescribir configuración y cualquier envío a terceros)
  siempre piden confirmación. Los tests fijan las cuatro pistas de cada herramienta.
- Dependencias directas nuevas: express 5.2.1 y jose 6.2.3.

## 0.3.0 — Unreleased

Contrato revisado de nuevo contra Evolution API 2.3.7, 2.4.0-rc2 y `develop`
(julio 2026), con el SDK de MCP 1.32.1. Siguen siendo 169 herramientas en 26
grupos, 72 activas por defecto.

### Seguridad y dependencias

- `@modelcontextprotocol/sdk` 1.32.1 y `npm audit fix`: de 7 avisos (1 crítico,
  3 altos) a 0. Ninguno era alcanzable desde el servidor stdio, pero viajaban en
  la imagen Docker.
- Node.js 22 o superior (`engines`); la imagen usa `node:24-alpine`.

### Corregido

- Transporte: el servidor ya no muere en silencio con mensajes MCP de más de
  10 MiB (límite por defecto del SDK ≥ 1.30). El límite pasa a 64 MiB
  (`EVOLUTION_MAX_MESSAGE_BYTES`) y los errores de transporte se registran en
  stderr.
- Las peticiones con `delay` esperan `EVOLUTION_TIMEOUT_MS + delay`. Si un envío
  agota el tiempo, el error avisa que el mensaje puede entregarse igualmente; si
  `typebot_start` lo agota, avisa que el flujo puede seguir enviándose y que
  reintentar lo reinicia.
- `typebot_start` usa `startSession: true` por defecto (el modo `false` no
  entrega mensajes en 2.3.7–develop) y exige settings de Typebot guardados.
- `openai_creds_delete` ya no borra en cascada los bots que usan la credencial
  (requiere `force: true`) ni intenta borrar la credencial predeterminada.
- `settings_set` de los bots ya no convierte valores NULL guardados en
  `keywordFinish: "bye"` o `debounceTime: 1`: solo completa valores
  equivalentes hoy en ejecución (un `keywordFinish` NULL, y `unknownMessage` en
  Typebot, se envía como `""`). En Dify, n8n, EvoAI y Evolution Bot, donde
  Evolution rechaza `""` si todos los campos son obligatorios, reenvía el
  `fallbackId` guardado (o `null` si no hay), sin cambiar el fallback; en
  OpenAI usa `speechToText: false`. En Dify, n8n, EvoAI y Evolution Bot la
  herramienta no puede crear con `""` settings nunca guardados y lo explica en
  vez del 400 de Evolution.
  `fallbackId: ""` se rechaza antes de llamar al API (daba HTTP 500).
- `fallbackId` en el primer guardado se asigna con una segunda escritura
  (antes se comprueba que el bot exista), porque Evolution no lo acepta al crear
  los settings (HTTP 500). En OpenAI Evolution falla si la escritura lleva el
  `fallbackId` junto con la credencial, que la herramienta siempre envía, así
  que lo rechaza.
- `chat_update_message` envía `key.remoteJid` como `number` (fallaba con números
  521…/549… escritos en dígitos).
- `chat_find_messages` envía `remoteJid` también como `remoteJidAlt`: con el JID
  de teléfono encuentra además los mensajes recibidos guardados bajo el @lid del
  chat. `chat_find_contacts` pagina de 50 en 50 (`page` sin `offset` daba
  HTTP 500).
- `message_send_media` exige `fileName` con extensión en documentos (se toma de
  la URL cuando es posible) y `mimetype` o un `fileName` con extensión en audio
  base64; antes Evolution enviaba mimetype `"false"`.
- `message_send_contact` toma `wuid` de los dígitos del teléfono.
- `proxy_set` envía credenciales vacías (sin ellas el proxy no se guardaba) y
  solo admite `http`/`socks5`.
- `instance_create` recorta y exige `instanceName`; `template_find` convierte la
  respuesta vacía (falla de Meta) en error.
- Los errores `[object Object]` de restart/connect/delete se sustituyen por una
  indicación accionable.
- Descripciones corregidas: menciones, `webhookUrl` de plantillas, carrusel,
  `@newsletter`, perfil propio, `triggerType: "none"`, `change_status`,
  `workflow` de Dify, `fallbackId` en Dify/n8n, `webhook_set` (incluido que
  `base64` se aplica tras reconectar la instancia), duración de
  `typebot_start`, SQS global y nombres de credenciales OpenAI.

### Añadido

- `EVOLUTION_MAX_RESULT_BYTES` (4 MiB): en un resultado mayor, los textos de
  más de 64 KiB se sustituyen por `<omitted: N bytes>` (con una nota de lo
  omitido) para no cortar la conexión de Claude Code (10 MiB); un envío de media
  cuyo resultado trae el archivo en `message.base64` sigue siendo un éxito. Solo
  si eso no basta, o en `chat_media_base64`, se devuelve un error con su tamaño
  y un resumen (en los envíos, con la `key` del mensaje).
- Compatibilidad con `develop` (sin publicar): `group_revoke_invite` y
  `group_leave` envían cuerpo JSON, `instance_fetch` filtra del lado del cliente
  y los errores explican las regresiones de upstream (GET de grupos con
  Express 5 y creación de instancias tras #2549). En `group_fetch_all`, el
  mismo HTTP 500 en 2.3.7/2.4.0-rc2 indica que la instancia no tiene sesión de
  WhatsApp cargada y el error pide conectarla.
- CI: `npm test` en Node 22 y 24, publicación de la imagen condicionada a las
  pruebas, acciones con runtime Node 24, etiquetas OCI correctas y Dependabot.

### Cambios incompatibles

- Los resultados son JSON compacto (sin indentación).
- `typebot_start` sin `startSession` crea o reemplaza una sesión persistente y
  responde solo después de enviar los primeros mensajes del flujo.
- `openai_creds_delete` rechaza credenciales que usan bots salvo `force: true`
  y nunca borra la predeterminada de los settings.
- `settings_set` de los bots envía un `keywordFinish` NULL como `""` en vez de
  `"bye"` y, en Dify, n8n, EvoAI y Evolution Bot, añade el `fallbackId` guardado
  (o `null`); `fallbackId: ""` es inválido y OpenAI rechaza cualquier
  `fallbackId`.
- `chat_find_contacts` devuelve 50 contactos por defecto.
- `chat_update_message`: `number` es opcional y se ignora si hay `key.remoteJid`.
- `message_send_media` rechaza documentos sin extensión, `fileName` sin extensión
  (uno vacío cuenta como omitido) y audio base64 sin `mimetype` ni `fileName`.
- Poll, sticker, botones y carrusel ya no exponen menciones, y las tarjetas del
  carrusel ya no tienen `title` (si se envían, se descartan sin error);
  `mentioned: []` es inválido.
- `proxy_set` ya no admite `https`/`socks4`; omitir las credenciales significa
  sin autenticación.
- `instance_create` rechaza nombres vacíos; `template_find` falla en vez de
  devolver `null`.

## 0.2.0 — 2026-09-26

Publicada en `main` (imagen `:latest` y `npx`) sin tag de versión.

Contrato revisado contra Evolution API 2.3.7 y 2.4.0-rc2. Se exponen 169
herramientas en 26 grupos, con 72 herramientas activas por defecto.

### Corregido

- Reinicio de instancias mediante POST; listas con `sections` y `footerText`
  obligatorio; presencia con `delay` obligatorio; creación de instancias con
  ajustes planos.
- Actualizaciones parciales de settings, privacidad, Chatwoot y bots mediante
  lectura y combinación de valores actuales. Se conservan opciones omitidas,
  valores `false`/`0` y los campos condicionales de los bots.
- Arrays `events` predeterminados a `[]`, también en webhooks de creación de
  instancias; settings de bots con `fallbackId` y n8n con `basicAuthPass`.
- Contactos con `wuid` opcional y numérico; polls con `selectableCount: 0`;
  audio con `encoding`, sin menciones ignoradas; paginación de chats.
- Descripciones de filtros de contactos y recibos, respuestas por ID, fotos
  base64 y limitaciones `@lid`/audio de Evolution API 2.3.7.
- Errores con prioridad de `response.message`, detalle de validación, detección
  de fallos `{error:true}` con HTTP 200 y diagnóstico de licencia
  `503 LICENSE_REQUIRED` con URL de activación, sin reintentos.
- Timeout HTTP activo hasta terminar de leer la respuesta.

### Añadido

- Verificación de credenciales, proxy, plantillas Meta y catálogos; NATS, Kafka,
  Pusher, n8n y EvoAI; listas de exclusión de bots y modelos OpenAI.
- Envío de plantillas, consulta de chat por JID y cinco herramientas marcadas
  **Requires Evolution API 2.4+**: carrusel, marcar reproducido, votos de poll,
  canales y permisos para agregar miembros a grupos.
- Media de tipo `audio`, `messageId`, opciones GIF y subida multipart en
  `message_send_media` desde base64; JSON continúa como transporte por defecto.
- Pruebas de regresión sin red mediante `npm test`.

### Cambios incompatibles

- Los bots reciben campos directamente: se eliminan los contenedores `config`
  de create/update y `settings` de settings_set.
- `message_send_list` cambia `values` por `sections` y exige `footerText`.
- `chat_send_presence` exige `delay`.
- `instance_create` sustituye `settings` anidado por campos planos.

No se exponen receptores entrantes, rutas internas Baileys/S3, administración
de licencias, funciones exclusivas de develop ni el stub `call/offer`.
