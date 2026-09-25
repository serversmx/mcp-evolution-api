# Changelog

## 0.2.0 — Unreleased

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
