# Evolution API MCP Server

Servidor [MCP](https://modelcontextprotocol.io) (Model Context Protocol) que expone
la **Evolution API v2** (WhatsApp) como herramientas para clientes MCP como Claude
Desktop, Claude Code o Cursor.

Versión del servidor MCP: **0.3.0**. Consulta el [CHANGELOG](CHANGELOG.md).

- **169 herramientas** con cobertura de la API v2 (instancias, mensajes, chats,
  grupos, perfil, etiquetas, proxy, plantillas Meta, catálogo, webhooks, colas de
  eventos, Chatwoot y 7 integraciones de chatbot).
- **Contrato verificado** contra el código fuente de Evolution API `2.3.7` y
  `2.4.0-rc2` (y revisado contra `develop`, julio 2026): método, ruta, campos
  obligatorios y comportamiento real de cada herramienta.
- **TypeScript** sobre el SDK oficial, transporte **stdio**.
- **Imagen Docker** publicada en GHCR y ejecutable con `npx` (sin clonar).
- **Multi-instancia**: las operaciones sobre instancias aceptan `instance`; opcionalmente una
  instancia por defecto.
- **Grupos activables** vía `EVOLUTION_TOOLS` para no saturar el contexto del modelo.

Compatible con Evolution API `2.3.7` y `2.4` (verificado contra `2.4.0-rc2`). Las herramientas que solo existen
desde 2.4 lo indican en su descripción (**"Requires Evolution API 2.4+"**); en 2.3.7
responden 404 y el error lo explica.

> La rama `develop` de Evolution (futura 2.4 final, aún sin publicar) trae dos
> regresiones de upstream: las 6 herramientas de grupo que usan GET
> (`invite_code`, `find_info`, `participants`, `fetch_all`, `invite_info`,
> `accept_invite`) fallan con HTTP 500 por la migración a Express 5, y crear
> instancias falla con un 400 de clave foránea tras el fix de seguridad #2549.
> El MCP lo explica en el mensaje de error; en 2.3.7 y 2.4.0-rc2 todo funciona
> (allí `group_fetch_all` solo responde ese HTTP 500 si la instancia no tiene
> sesión de WhatsApp cargada, y el error indica conectarla).

## Requisitos

- Una instancia de Evolution API v2 y su **apikey global**.
- Para `npx` / local: Node.js 22 o superior (24 LTS recomendado); la opción B
  (`npx github:`) requiere además `git` en el PATH. Para Docker: solo Docker.

## Cómo ejecutarlo

Hay tres formas, de la más simple a la más manual. Todas necesitan las mismas
variables de entorno (ver [Configuración](#configuración)).

### Opción A — Docker (recomendada)

Imagen lista en GitHub Container Registry, no necesitas Node ni clonar nada:

```bash
docker run -i --rm \
  -e EVOLUTION_BASE_URL=https://your-evolution-instance.com \
  -e EVOLUTION_API_KEY=tu-apikey-global \
  -e EVOLUTION_DEFAULT_INSTANCE=myinstance \
  ghcr.io/serversmx/mcp-evolution-api:latest
```

> El servidor habla MCP por **stdio**, por eso `docker run` usa `-i` (mantiene
> stdin abierto). No expone puertos.

> ℹ️ La imagen es **multi-arquitectura** (`linux/amd64` + `linux/arm64`): corre
> nativa en Macs Apple Silicon e Intel y en servidores Linux. Al publicarse por
> primera vez en GHCR el paquete queda **privado**; para que cualquiera pueda
> hacer `docker pull`, el mantenedor debe marcarlo **público** una sola vez:
> pestaña **Packages** del repo → paquete `mcp-evolution-api` → **Package
> settings** → **Change visibility** → **Public**. Mientras tanto, las Opciones
> B (npx) y C (local) no dependen de GHCR.

Construir la imagen localmente en vez de usar GHCR:

```bash
docker build -t evolution-api-mcp .
docker run -i --rm -e EVOLUTION_BASE_URL=... -e EVOLUTION_API_KEY=... evolution-api-mcp
```

### Opción B — npx (sin clonar)

Compila y ejecuta directamente desde GitHub:

```bash
EVOLUTION_BASE_URL=https://your-evolution-instance.com \
EVOLUTION_API_KEY=tu-apikey-global \
EVOLUTION_DEFAULT_INSTANCE=myinstance \
npx -y github:serversmx/mcp-evolution-api
```

> ⚠️ La **primera** ejecución clona el repo, instala dependencias y compila
> TypeScript (`prepare` → `tsc`), así que puede tardar ~30–60 s. Algunos clientes
> MCP marcan el servidor como fallido si supera su timeout de arranque: si te
> pasa, córrelo una vez en una terminal para precargar la caché de npx y reintenta,
> o usa **Docker (Opción A)**, que no compila en cada arranque.

### Opción C — Local (clonar y compilar)

```bash
git clone https://github.com/serversmx/mcp-evolution-api.git
cd mcp-evolution-api
npm install        # compila a dist/ automáticamente (script "prepare")
cp .env.example .env   # edita tus credenciales
npm start
```

## Configuración

Variables de entorno (ver [.env.example](.env.example)):

| Variable | Requerida | Descripción |
|---|:---:|---|
| `EVOLUTION_BASE_URL` | ✅ | URL base, p.ej. `https://your-evolution-instance.com` (sin slash final). |
| `EVOLUTION_API_KEY` | ✅ | apikey global (header `apikey`). |
| `EVOLUTION_DEFAULT_INSTANCE` | — | Instancia usada cuando una herramienta omite `instance`. |
| `EVOLUTION_TOOLS` | — | Allowlist de grupos separada por comas. Ver abajo. |
| `EVOLUTION_TIMEOUT_MS` | — | Timeout por petición (default `30000`). Las peticiones con `delay` (envíos y `chat_send_presence`) esperan timeout + delay, porque Evolution mantiene la petición abierta durante el delay. |
| `EVOLUTION_MAX_MESSAGE_BYTES` | — | Tamaño máximo de un mensaje MCP entrante, p.ej. una llamada con media en base64 (default `67108864` = 64 MiB). Si se supera, la conexión se cierra y queda registrado en stderr. |
| `EVOLUTION_MAX_RESULT_BYTES` | — | Tamaño máximo de un resultado (default `4194304` = 4 MiB). En uno mayor, los textos de más de 64 KiB (p.ej. el base64 que devuelve un envío de media) se sustituyen por `<omitted: N bytes>`; solo es un error si eso no basta, y siempre en `chat_media_base64`. Mantenlo por debajo del límite del cliente: Claude Code corta los servidores con mensajes de más de 10 MiB (Claude Desktop, 32 MiB). |

> ⚠️ La apikey global da **control total** sobre la instancia (crear/borrar
> instancias, enviar mensajes, leer chats). Trátala como un secreto: nunca la
> subas al repositorio ni la hornees en una imagen.

> ⚠️ **Seguridad del servidor Evolution.** Hasta `2.4.0-rc2`, cualquiera con el
> token de **una** instancia puede operar sobre las demás (bypass entre
> instancias corregido solo en `develop`, #2549). No compartas tokens de
> instancia con terceros. Además, el paquete npm `evolution-api-mcp` es **otro
> proyecto**: este servidor se ejecuta solo con `npx -y github:serversmx/mcp-evolution-api`.

### Grupos de herramientas

`EVOLUTION_TOOLS` controla qué grupos se exponen:

- **Sin definir** → grupos núcleo: `server, instance, settings, message, chat, profile, label, group, webhook` (72 tools).
- `all` → todos los grupos (169 tools).
- Lista explícita, p.ej. `message,chat,group` → solo esos.

| Grupo | Núcleo | Tools | Herramientas |
|---|:---:|:---:|---|
| `server` | ✅ | 1 | verificar que la apikey es la global (`/verify-creds`) |
| `instance` | ✅ | 8 | crear (settings planos + webhook), conectar, estado, reiniciar, presencia, logout, borrar, listar |
| `settings` | ✅ | 2 | leer/escribir settings de la instancia (actualización parcial segura) |
| `message` | ✅ | 14 | texto, media (imagen/video/documento/audio), audio PTT, sticker, ubicación, contacto, reacción, poll, lista, botones, status, ptv, plantilla Meta, carrusel (2.4+) |
| `chat` | ✅ | 18 | verificar números, marcar leído/reproducido (2.4+)/no leído, archivar, borrar, presencia, bloquear, foto, base64, buscar chats/mensajes/contactos/recibos, chat por JID, editar, votos de poll (2.4+), canales (2.4+) |
| `profile` | ✅ | 8 | perfil propio y de negocio, privacidad (actualización parcial segura), nombre/estado/foto |
| `label` | ✅ | 2 | listar y asignar etiquetas |
| `group` | ✅ | 17 | crear, participantes, invitaciones, ajustes, quién agrega miembros (2.4+), ephemeral, salir |
| `webhook` | ✅ | 2 | configurar/leer webhook |
| `proxy` | — | 2 | configurar/leer el proxy de la instancia |
| `template` | — | 4 | crear/editar/borrar/listar plantillas Meta (solo Cloud API) |
| `business` | — | 2 | catálogo y colecciones de WhatsApp Business |
| `websocket` | — | 2 | configurar/leer websocket |
| `rabbitmq` | — | 2 | configurar/leer RabbitMQ |
| `sqs` | — | 2 | configurar/leer AWS SQS |
| `nats` | — | 2 | configurar/leer NATS |
| `kafka` | — | 2 | configurar/leer Kafka |
| `pusher` | — | 2 | configurar/leer Pusher |
| `chatwoot` | — | 2 | configurar (actualización parcial segura)/leer Chatwoot |
| `typebot` | — | 11 | bots + settings + sesiones + ignoreJid + start |
| `openai` | — | 14 | bots + settings + sesiones + ignoreJid + credenciales + modelos |
| `dify` | — | 10 | bots + settings + sesiones + ignoreJid |
| `evolutionbot` | — | 10 | bots + settings + sesiones + ignoreJid |
| `flowise` | — | 10 | bots + settings + sesiones + ignoreJid |
| `n8n` | — | 10 | bots + settings + sesiones + ignoreJid |
| `evoai` | — | 10 | bots + settings + sesiones + ignoreJid |

## Configuración en tu cliente MCP

Añade el servidor a tu config (`claude_desktop_config.json`, `.cursor/mcp.json`,
o `claude mcp add`). Elige el bloque según cómo lo ejecutes.

> ⚠️ **Claude Desktop (macOS) y el PATH.** Claude Desktop se lanza desde
> Finder/Dock y hereda un PATH mínimo (`/usr/bin:/bin:/usr/sbin:/sbin`), por lo
> que a menudo **no** encuentra `docker`, `npx` ni `node` y falla con
> `spawn docker ENOENT` la primera vez. (Claude Code por CLI y Cursor heredan el
> PATH de tu shell, así que no les afecta.) Solución: usa la **ruta absoluta** del
> binario en `"command"`, obtenida con `which docker` / `which npx` / `which node`
> (p.ej. `/usr/local/bin/docker` o `/opt/homebrew/bin/node`).

**Con Docker:**

```json
{
  "mcpServers": {
    "evolution-api": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "EVOLUTION_BASE_URL",
        "-e", "EVOLUTION_API_KEY",
        "-e", "EVOLUTION_DEFAULT_INSTANCE",
        "ghcr.io/serversmx/mcp-evolution-api:latest"
      ],
      "env": {
        "EVOLUTION_BASE_URL": "https://your-evolution-instance.com",
        "EVOLUTION_API_KEY": "tu-apikey-global",
        "EVOLUTION_DEFAULT_INSTANCE": "myinstance"
      }
    }
  }
}
```

> Los `-e VAR` sin valor reenvían la variable desde el bloque `env`, así la
> apikey no queda escrita en `args`.

**Con npx:**

```json
{
  "mcpServers": {
    "evolution-api": {
      "command": "npx",
      "args": ["-y", "github:serversmx/mcp-evolution-api"],
      "env": {
        "EVOLUTION_BASE_URL": "https://your-evolution-instance.com",
        "EVOLUTION_API_KEY": "tu-apikey-global",
        "EVOLUTION_DEFAULT_INSTANCE": "myinstance"
      }
    }
  }
}
```

**Local (compilado):**

```json
{
  "mcpServers": {
    "evolution-api": {
      "command": "node",
      "args": ["/ruta/absoluta/a/mcp-evolution-api/dist/index.js"],
      "env": {
        "EVOLUTION_BASE_URL": "https://your-evolution-instance.com",
        "EVOLUTION_API_KEY": "tu-apikey-global",
        "EVOLUTION_DEFAULT_INSTANCE": "myinstance"
      }
    }
  }
}
```

Con Claude Code por CLI (Docker):

```bash
claude mcp add evolution-api \
  --env EVOLUTION_BASE_URL=https://your-evolution-instance.com \
  --env EVOLUTION_API_KEY=tu-apikey-global \
  --env EVOLUTION_DEFAULT_INSTANCE=myinstance \
  -- docker run -i --rm \
     -e EVOLUTION_BASE_URL -e EVOLUTION_API_KEY -e EVOLUTION_DEFAULT_INSTANCE \
     ghcr.io/serversmx/mcp-evolution-api:latest
```

## Verificación

Smoke test de **solo lectura** contra tu instancia (no envía mensajes ni modifica nada):

```bash
EVOLUTION_BASE_URL=https://your-evolution-instance.com \
EVOLUTION_API_KEY=tu-apikey-global \
EVOLUTION_DEFAULT_INSTANCE=myinstance \
node dist/smoke.js
```

Con la imagen Docker (sin compilar nada local):

```bash
docker run --rm --entrypoint node \
  -e EVOLUTION_BASE_URL=https://your-evolution-instance.com \
  -e EVOLUTION_API_KEY=tu-apikey-global \
  -e EVOLUTION_DEFAULT_INSTANCE=myinstance \
  ghcr.io/serversmx/mcp-evolution-api:latest dist/smoke.js
```

Salida esperada: `4/4 checks passed.`

## Ejemplos de uso (lenguaje natural)

Una vez conectado, puedes pedirle a Claude cosas como:

- "Verifica si el número 5215550123 está en WhatsApp."
- "Envía 'Hola 👋' al 5215550123 desde la instancia myinstance."
- "Lista todos los grupos de la instancia myinstance."
- "¿Cuál es el estado de conexión de mis instancias?"

## Convenciones de las herramientas

- Nombre: `evolution_<grupo>_<acción>` (p.ej. `evolution_message_send_text`).
- Las herramientas que operan sobre una instancia aceptan `instance`
  (opcional si hay `EVOLUTION_DEFAULT_INSTANCE`).
- Los `number` aceptan dígitos con código de país o JID completo
  (`5215550123` o `5215550123@s.whatsapp.net`).
- Los errores del API se devuelven como resultado de error con el `status` y el
  detalle de validación de Evolution (`response.message`), no solo "Bad Request".
  La apikey nunca aparece en logs ni errores.
- **Licencia 2.4**: si el servidor 2.4+ no está activado, todas las llamadas
  a herramientas de negocio responden 503 `LICENSE_REQUIRED`; el error indica la URL de activación
  (`/manager/login`) y que reintentar no sirve.
- **Actualizaciones parciales seguras**: `settings_set`, `profile_update_privacy`,
  `chatwoot_set`, y `update`/`settings_set` de los bots exigen en el API todos los
  campos obligatorios. Si omites alguno, la herramienta lee la configuración
  actual, la combina con lo que pasaste y envía el objeto completo. En
  `settings_set` de los bots, un valor guardado como NULL solo se completa con un
  valor equivalente hoy en ejecución (`delayMessage` 1000, `debounceTime` 0,
  `ignoreJids` [], `unknownMessage` por defecto salvo en Typebot); un
  `keywordFinish` NULL (y `unknownMessage` en Typebot) se envía como `""`, que
  Evolution acepta si la petición lleva algún campo opcional. En Dify, n8n, EvoAI
  y Evolution Bot todos los campos son obligatorios, así que la herramienta
  reenvía el `fallbackId` guardado (o `null` si no hay): el fallback no cambia
  (en OpenAI usa `speechToText: false`, equivalente en ejecución). Si esos
  settings nunca se guardaron, Evolution no puede crearlos con `""`: guárdalos
  una vez con un valor y luego vacíalo. No inventa valores que cambien el
  comportamiento del bot, y `fallbackId: ""` se rechaza antes de llamar al API.
- Los resultados se devuelven como JSON compacto. En un resultado mayor que
  `EVOLUTION_MAX_RESULT_BYTES`, los textos de más de 64 KiB se sustituyen por
  `<omitted: N bytes>` y un segundo bloque indica qué se omitió (p.ej.
  `message.base64` cuando un envío de media devuelve el archivo porque el webhook
  tiene `base64: true`). Si aun así no cabe, o en `chat_media_base64`, se
  devuelve un error con su tamaño y un resumen; en los envíos incluye la `key`
  del mensaje y avisa que Evolution ya lo aceptó (no reintentar). Para media
  grande usa `message.mediaUrl` (con S3/MinIO) o el base64 de los webhooks
  (`webhook_set` con `base64: true`; en Baileys se aplica a la media nueva tras
  reconectar la instancia, p.ej. con `instance_restart`) en lugar de
  `chat_media_base64`.
- Los `events` de webhook/websocket/rabbitmq/sqs/nats/kafka/pusher siempre se
  envían: `[]` (por defecto) significa **todos** los eventos.
- `message_send_media` permite `transport: "multipart"`: recibe base64 en los
  argumentos MCP y lo convierte en un archivo binario en el campo HTTP `file`.
  Para `delay`, `quoted` o menciones usa el transporte `json` (por defecto):
  Evolution recibe los campos multipart como strings y rechaza esos tipos.
  Los demás envíos de media aceptan URL/base64 mediante JSON.
- `message_send_media`: todo `fileName` debe llevar extensión (Evolution deriva
  el mimetype de él y si no envía `"false"`); uno vacío (`""`) cuenta como
  omitido. Los documentos lo exigen (se toma de la ruta de la URL cuando termina
  en extensión) y el audio base64 necesita `mimetype` o `fileName`.
- Menciones: poll, sticker, botones y carrusel no las ofrecen porque Evolution
  nunca las aplica; `send_list` las conserva (2.3.7 las aplica, 2.4+ las ignora).
- `chat_find_contacts` pagina de 50 en 50 por defecto (usa `page`/`offset`).
- `typebot_start` usa `startSession: true` por defecto (el modo `false` no
  entrega mensajes en 2.3.7–develop) y requiere settings de Typebot guardados.
  Evolution responde cuando termina de enviar los primeros mensajes del flujo, así
  que una apertura larga puede agotar `EVOLUTION_TIMEOUT_MS`: revisa el chat
  antes de reintentar, porque reintentar borra las sesiones de bot del chat y
  reinicia el flujo.
- `openai_creds_delete` nunca borra la credencial predeterminada de los settings
  (primero apunta los settings a otra) y rechaza credenciales que usan bots (se
  borrarían en cascada) salvo con `force: true`.
- `proxy_set` solo admite `http` y `socks5`; omitir `username`/`password` deja el
  proxy sin autenticación.
- Se excluyen los receptores de webhooks entrantes, las rutas internas de
  Baileys/S3, administración de licencias y `call/offer`, que es un stub y no
  realiza llamadas. Las rutas exclusivas de `develop` tampoco se exponen.

## Estructura

```text
src/
  index.ts            Punto de entrada: transporte stdio y arranque
  server.ts           Server MCP: lista y ejecuta tools (límite de tamaño, JSON compacto)
  config.ts           Carga/valida variables de entorno
  client.ts           Cliente HTTP de Evolution (apikey, errores, 503 de licencia, timeout)
  registry.ts         Filtra grupos según EVOLUTION_TOOLS
  types.ts            Tipos ToolDef / ToolGroup
  schemas/common.ts   Fragmentos zod reutilizables
  tools/              Un archivo por controlador + integrations/ (eventos, Chatwoot, bots)
  tools/helpers.ts    Utilidades de handlers (body, merge de configuración)
  smoke.ts            Smoke test de solo lectura
Dockerfile            Imagen multi-stage (build + runtime no-root, node:24-alpine)
.github/workflows/    CI (build + pruebas en Node 22 y 24) y publicación de la imagen en GHCR
.github/dependabot.yml  Actualizaciones semanales de dependencias (npm, Actions, Docker)
```

Las herramientas de bots (`typebot`, `openai`, `dify`, `evolutionbot`, `flowise`,
`n8n`, `evoai`) comparten una misma fábrica con campos tipados: los comunes
(`enabled`, `triggerType`, `expire`, `keepOpen`, …) más los propios de cada bot
(p.ej. `url`/`typebot`, `openaiCredsId`/`botType`, `webhookUrl`/`basicAuthPass`,
`agentUrl`). El bot por defecto de los settings se indica con `fallbackId`
(Dify y n8n lo guardan pero lo ignoran en ejecución en Evolution 2.3.7–develop;
OpenAI no puede guardarlo, Evolution falla con HTTP 500, así que la herramienta
lo rechaza). En el primer guardado de los settings, la herramienta los crea y
después asigna el `fallbackId`, porque Evolution no lo acepta al crearlos.

### Cambios incompatibles en 0.3.0

- Resultados en JSON compacto y con límite de tamaño (`EVOLUTION_MAX_RESULT_BYTES`).
- `evolution_typebot_start`: sin `startSession` crea o reemplaza una sesión
  persistente y responde solo después de enviar los primeros mensajes del flujo;
  si los settings de Typebot nunca se guardaron, falla sin llamar a
  `/typebot/start` (antes consulta `/typebot/fetchSettings`).
- `evolution_openai_creds_delete`: rechaza credenciales que usan bots salvo
  `force: true` y nunca borra la credencial predeterminada de los settings.
- `settings_set` de los bots: un `keywordFinish` NULL se envía como `""` (sin
  inventar `"bye"`) y en Dify, n8n, EvoAI y Evolution Bot va acompañado del
  `fallbackId` guardado o `null` (ver arriba); `fallbackId: ""` es inválido y
  OpenAI rechaza cualquier `fallbackId`.
- `evolution_chat_find_contacts`: 50 contactos por defecto.
- `evolution_chat_update_message`: `number` es opcional y se usa `key.remoteJid`.
- `evolution_message_send_media`: valida `fileName`/`mimetype` antes de enviar.
- Poll, sticker, botones y carrusel sin menciones; tarjetas del carrusel sin
  `title` (los campos sobrantes se descartan sin error).
- `evolution_proxy_set`: sin `https`/`socks4`; sin credenciales = sin autenticación.
- `evolution_instance_create` rechaza nombres vacíos; `evolution_template_find`
  falla en vez de devolver `null` cuando falla la petición a Meta.

Detalle completo en el [CHANGELOG](CHANGELOG.md).

### Cambios incompatibles en 0.2.0

- Bots: `create`/`update` ya no reciben `config` y `settings_set` ya no recibe
  `settings`; los campos van directamente en los argumentos.
- `evolution_message_send_list`: `values` pasa a `sections` y `footerText` es obligatorio.
- `evolution_chat_send_presence`: `delay` es obligatorio.
- `evolution_instance_create`: `settings` anidado se reemplaza por campos planos
  (`rejectCall`, `msgCall`, `groupsIgnore`, …), que es lo que lee el API.

## Desarrollo

```bash
npm run watch    # compila en modo watch
npm run build    # compila a dist/
npm test         # compila y ejecuta regresiones sin conexión a un servidor
npm start        # ejecuta el servidor (requiere env)
```

La CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) compila con `tsc` y
ejecuta `npm test` en Node 22 y 24 en cada push/PR. Al hacer push a `main` o
publicar un tag `vX.Y.Z`, la imagen se publica en
`ghcr.io/serversmx/mcp-evolution-api`
([docker-publish.yml](.github/workflows/docker-publish.yml)), solo si esas
pruebas pasan.

## Licencia

MIT
