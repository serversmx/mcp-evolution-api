# Evolution API MCP Server

Servidor [MCP](https://modelcontextprotocol.io) (Model Context Protocol) que expone
la **Evolution API v2** (WhatsApp) como herramientas para clientes MCP como Claude
Desktop, Claude Code o Cursor.

Versión del servidor MCP: **0.2.0**. Consulta el [CHANGELOG](CHANGELOG.md).

- **169 herramientas** con cobertura de la API v2 (instancias, mensajes, chats,
  grupos, perfil, etiquetas, proxy, plantillas Meta, catálogo, webhooks, colas de
  eventos, Chatwoot y 7 integraciones de chatbot).
- **Contrato verificado** contra el código fuente de Evolution API `2.3.7` y
  `2.4.0-rc2`: método, ruta y campos obligatorios de cada herramienta.
- **TypeScript** sobre el SDK oficial, transporte **stdio**.
- **Imagen Docker** publicada en GHCR y ejecutable con `npx` (sin clonar).
- **Multi-instancia**: las operaciones sobre instancias aceptan `instance`; opcionalmente una
  instancia por defecto.
- **Grupos activables** vía `EVOLUTION_TOOLS` para no saturar el contexto del modelo.

Compatible con Evolution API `2.3.7` y `2.4` (verificado contra `2.4.0-rc2`). Las herramientas que solo existen
desde 2.4 lo indican en su descripción (**"Requires Evolution API 2.4+"**); en 2.3.7
responden 404 y el error lo explica.

## Requisitos

- Una instancia de Evolution API v2 y su **apikey global**.
- Para `npx` / local: Node.js 18 o superior. Para Docker: solo Docker.

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
| `EVOLUTION_TIMEOUT_MS` | — | Timeout por petición (default `30000`). |

> ⚠️ La apikey global da **control total** sobre la instancia (crear/borrar
> instancias, enviar mensajes, leer chats). Trátala como un secreto: nunca la
> subas al repositorio ni la hornees en una imagen.

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
  actual, la combina con lo que pasaste y envía el objeto completo.
- Los `events` de webhook/websocket/rabbitmq/sqs/nats/kafka/pusher siempre se
  envían: `[]` (por defecto) significa **todos** los eventos.
- `message_send_media` permite `transport: "multipart"`: recibe base64 en los
  argumentos MCP y lo convierte en un archivo binario en el campo HTTP `file`.
  Para `delay`, `quoted` o menciones usa el transporte `json` (por defecto):
  Evolution recibe los campos multipart como strings y rechaza esos tipos.
  Los demás envíos de media aceptan URL/base64 mediante JSON.
- Se excluyen los receptores de webhooks entrantes, las rutas internas de
  Baileys/S3, administración de licencias y `call/offer`, que es un stub y no
  realiza llamadas. Las rutas exclusivas de `develop` tampoco se exponen.

## Estructura

```text
src/
  index.ts            Server MCP (stdio): lista y ejecuta tools
  config.ts           Carga/valida variables de entorno
  client.ts           Cliente HTTP de Evolution (apikey, errores, 503 de licencia, timeout)
  registry.ts         Filtra grupos según EVOLUTION_TOOLS
  types.ts            Tipos ToolDef / ToolGroup
  schemas/common.ts   Fragmentos zod reutilizables
  tools/              Un archivo por controlador + integrations/ (eventos, Chatwoot, bots)
  tools/helpers.ts    Utilidades de handlers (body, merge de configuración)
  smoke.ts            Smoke test de solo lectura
Dockerfile            Imagen multi-stage (build + runtime no-root)
.github/workflows/    CI (build) y publicación de la imagen en GHCR
```

Las herramientas de bots (`typebot`, `openai`, `dify`, `evolutionbot`, `flowise`,
`n8n`, `evoai`) comparten una misma fábrica con campos tipados: los comunes
(`enabled`, `triggerType`, `expire`, `keepOpen`, …) más los propios de cada bot
(p.ej. `url`/`typebot`, `openaiCredsId`/`botType`, `webhookUrl`/`basicAuthPass`,
`agentUrl`). El bot por defecto de los settings se indica con `fallbackId`.

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

La CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) compila con `tsc` en
cada push/PR. Al hacer push a `main` o publicar un tag `vX.Y.Z`, la imagen se
publica en `ghcr.io/serversmx/mcp-evolution-api`
([docker-publish.yml](.github/workflows/docker-publish.yml)).

## Licencia

MIT
