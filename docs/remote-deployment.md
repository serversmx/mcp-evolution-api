# Modo remoto (HTTP): Easypanel + ChatGPT + Claude

Esta guía publica el servidor como MCP remoto en `https://mcp-evo.tu-dominio.com/mcp`, como una App
de Easypanel en el **mismo proyecto** que Evolution API 2.3.7 (`https://evo.tu-dominio.com`, detrás de
Cloudflare), para usarlo desde Claude (web, Desktop y móvil), Claude Code y ChatGPT.
Datos verificados contra documentación oficial el **2026-10-10**. Lo que no se pudo verificar está
marcado como *(inferencia)* o *(no verificado)* y aparece en [Incertidumbres](#incertidumbres).

```text
Claude / ChatGPT (nube) ─HTTPS─▶ Cloudflare (proxy) ─HTTPS─▶ Traefik (Easypanel) ─HTTP :3000─▶ App mcp-evo
                                                                                       │ red interna del proyecto
                                                                                       ▼
                                                                          App evolution-api :8080
OAuth: el cliente inicia sesión en WorkOS AuthKit (xxxx.authkit.app); el MCP solo valida el JWT (iss, aud, exp, sub).
```

**Dos fases.** El servidor acepta **un solo modo de autenticación a la vez**:

| Fase | `MCP_AUTH_MODE` | Clientes | Por qué |
|---|---|---|---|
| 1. Prueba | `bearer` (token estático) | MCP Inspector, Claude Code | ChatGPT no puede enviar API keys ni headers propios; los *Request headers* de claude.ai son una beta para pocas organizaciones. |
| 2. Producción | `oauth` (WorkOS AuthKit) | claude.ai / Desktop / móvil, ChatGPT, Claude Code (vía el conector de claude.ai) | Al pasar a `oauth`, el token de la fase 1 deja de funcionar. |

**Antes de empezar:** la versión 0.4.0 o posterior del servidor (trae el modo HTTP, `MCP_TRANSPORT=http`);
acceso al proyecto de Easypanel y a la zona `tu-dominio.com` en Cloudflare; Node ≥ 22.19 en tu
computadora (lo pide MCP Inspector 2.x); `jq` para algunos comandos.

## 1. Variables de entorno del modo HTTP

| Variable | Valor en esta guía | Notas |
|---|---|---|
| `MCP_TRANSPORT` | `http` | Default `stdio`. |
| `MCP_PUBLIC_URL` | `https://mcp-evo.tu-dominio.com/mcp` | Tal cual la escribes en Claude y ChatGPT (sin `/` final). Es el `resource` de RFC 9728 y la audiencia por defecto. |
| `MCP_HOST` | no definir | Default `127.0.0.1`; la imagen Docker fija `0.0.0.0`. |
| `MCP_PORT` / `PORT` | no definir | Default `3000` (puerto destino del dominio en Easypanel). |
| `MCP_PATH` | no definir | Default: el path de `MCP_PUBLIC_URL` (`/mcp`). |
| `MCP_ALLOWED_HOSTS` | no definir | Default: el host de `MCP_PUBLIC_URL` más `localhost` y `127.0.0.1`. Si lo defines, **reemplaza** ese default: incluye `mcp-evo.tu-dominio.com`. |
| `MCP_ALLOWED_ORIGINS` | `https://claude.ai,https://chatgpt.com` | Precaución: una petición con un header `Origin` fuera de la lista recibe 403. La autenticación sigue siendo obligatoria. |
| `MCP_JSON_RESPONSE` | no definir | Deja SSE (default) detrás de Cloudflare (ver 3.5). |
| `MCP_SHUTDOWN_TIMEOUT_MS` | no definir | Tiempo de drenado al detenerse. |
| `MCP_AUTH_MODE` | fase 1: no definir (se infiere `bearer`); fase 2: `oauth` | Se infiere de `MCP_AUTH_TOKEN` / `MCP_OAUTH_ISSUER`. `none` exige `MCP_ALLOW_UNAUTHENTICATED=true`: **nunca** en un dominio público. |
| `MCP_AUTH_TOKEN` | fase 1: salida de `openssl rand -hex 32` | Lista separada por comas, cada token ≥ 32 caracteres; solo letras, dígitos y `- . _ ~ + /` (con `=` al final). La lista sirve para rotar. Si también defines `MCP_OAUTH_ISSUER`, fija `MCP_AUTH_MODE` o el servidor no arranca. |
| `MCP_OAUTH_ISSUER` | fase 2: `https://<tu-dominio>.authkit.app` | Sin `/` final. Debe ser idéntico al `iss` de los tokens y al `issuer` de la metadata de AuthKit. |
| `MCP_OAUTH_AUDIENCE` | no definir | Default = `MCP_PUBLIC_URL`; debe coincidir con el Resource Indicator de WorkOS. |
| `MCP_OAUTH_JWKS_URL` | opcional: `https://<tu-dominio>.authkit.app/oauth2/jwks` | Si no se define, se descubre desde el issuer. |
| `MCP_OAUTH_REQUIRED_SCOPES` | no definir | WorkOS solo da `openid profile email offline_access` a clientes CIMD/DCR. |
| `MCP_OAUTH_ALLOWED_SUBJECTS` | fase 2: tu ID de WorkOS (`user_01…`) | Lista de `sub` permitidos. Es el control que importa. |
| `MCP_OAUTH_ALLOW_ANY_SUBJECT` | **nunca** `true` aquí | Cualquiera que consiga una cuenta en tu entorno de AuthKit obtendría tokens válidos. |
| `MCP_ALLOW_UNAUTHENTICATED` | no definir | Solo para `none` detrás de un gateway que autentique. |
| `EVOLUTION_BASE_URL` | `http://$(PROJECT_NAME)_evolution-api:8080` | Red interna (ver 2.3). Respaldo seguro: `https://evo.tu-dominio.com`. |
| `EVOLUTION_API_KEY` | apikey **global** de Evolution | Secreto. Ver [Seguridad](#9-checklist-de-seguridad). |
| `EVOLUTION_DEFAULT_INSTANCE` | `<tu-instancia>` | Sin el grupo `instance` el modelo no puede listar instancias. |
| `EVOLUTION_TOOLS` | `message,chat` | 32 tools. Ver [Seguridad](#9-checklist-de-seguridad). |
| `EVOLUTION_MAX_RESULT_BYTES` | no definir | En modo HTTP el default es `150000` (claude.ai corta en ~150,000 caracteres); stdio conserva 4 MiB. |
| `EVOLUTION_TIMEOUT_MS` | no definir (`30000`) | Mantén cada llamada por debajo de ~60 s (límite no oficial de ChatGPT). |

## 2. Easypanel: crear el servicio

**2.1 Crear la App.** Abre el proyecto donde está Evolution → **New Service** → **App** → nombre
`mcp-evo` → crear.

**2.2 Source.** Elige una opción:

- **A. GitHub** (para probar ya, sin credenciales). **Source → GitHub**: owner/repo
  `serversmx/mcp-evolution-api`, Branch `main` (o `feat/remote-http` mientras ese cambio no se
  fusione), Build Path `/`. **Build → Dockerfile**, archivo `Dockerfile` (Easypanel lo
  elige solo si existe). El repo es público: no hace falta token de GitHub; *Auto Deploy* sí lo
  necesita (Settings → Github). Easypanel pasa las variables de entorno como *build args*; el
  Dockerfile no las declara, y no agregues `ARG` para secretos.
- **B. Imagen de GHCR** (recomendada para producción). **Source → Docker Image**:
  `ghcr.io/serversmx/mcp-evolution-api:<versión>`, usando la primera versión publicada con modo HTTP
  (CI publica `X.Y.Z` por tag, y `main`/`latest` desde main). Mientras el paquete sea privado:
  **Username** = tu usuario de GitHub; **Password** = PAT **classic** con scope `read:packages` (GHCR
  solo acepta PAT classic; autoriza SSO si la organización lo exige). Para no necesitar
  credenciales: en GitHub, abre el paquete → **Package settings** → cambia la visibilidad a
  **Public** (los paquetes públicos de GHCR se descargan sin autenticación).

**2.3 Environment (fase 1).** Pega esto y reemplaza los valores entre `< >`:

```dotenv
MCP_TRANSPORT=http
MCP_PUBLIC_URL=https://mcp-evo.tu-dominio.com/mcp
MCP_AUTH_TOKEN=<salida de: openssl rand -hex 32>
MCP_ALLOWED_ORIGINS=https://claude.ai,https://chatgpt.com
EVOLUTION_BASE_URL=http://$(PROJECT_NAME)_evolution-api:8080
EVOLUTION_API_KEY=<apikey global de Evolution>
EVOLUTION_DEFAULT_INSTANCE=<tu-instancia>
EVOLUTION_TOOLS=message,chat
```

- **Red interna.** Easypanel sustituye `$(PROJECT_NAME)` en las variables. Un servicio alcanza a
  otro del mismo proyecto en `<proyecto>_<servicio>`: es el formato que usan las plantillas
  oficiales (la de Evolution conecta con `$(PROJECT_NAME)_evolution-api-db:5432`; la de Plausible,
  de App a App, con `http://$(PROJECT_NAME)_<servicio>:8123`), y la doc de Easypanel lo ilustra con
  `project_database:5432`. `evolution-api` es el nombre por defecto del servicio en la plantilla de
  Easypanel; si el tuyo se llama distinto, cámbialo. Evolution escucha en `8080` (`SERVER_PORT` por
  defecto).
- **Compruébalo** después del primer deploy: Overview → **Shell** → `wget -qO- "$EVOLUTION_BASE_URL"`
  debe devolver un JSON con `"message":"Welcome to the Evolution API, it is working!"` y
  `"version":"2.3.7"`. Si falla, usa `EVOLUTION_BASE_URL=https://evo.tu-dominio.com`: siempre funciona,
  pero pasa por Cloudflare.

**2.4 Domains.** Crea primero el registro DNS (3.1). Luego **Domains → Add Domain**:

| Campo | Valor |
|---|---|
| Host | `mcp-evo.tu-dominio.com` |
| Path | `/` (no `/mcp`: el servidor también atiende `/.well-known/oauth-protected-resource/mcp`) |
| HTTPS | activado |
| Destino | protocolo `HTTP`, puerto `3000` |

Si Easypanel creó un dominio automático (`*.easypanel.host`), bórralo. **No** actives
**Security → Basic Auth** en este servicio: usa el mismo header `Authorization` que el bearer y OAuth.

**2.5 Advanced → Deploy.** Replicas `1`. Zero-downtime puede quedar activo (el servidor no guarda
sesiones). No uses Command override. Opcional: **Resources** → límite de memoria de 512 MB.

**2.6 Deploy.** Guardar no despliega: pulsa **Deploy** y revisa **Overview → Logs**. Debes ver
`32 tools from groups: message, chat` y
`ready (http) on 0.0.0.0:3000/mcp auth=bearer public=https://mcp-evo.tu-dominio.com/mcp`. Después, cada
petición deja una línea con método, ruta, código y duración (p. ej. `POST /mcp 200 12.3ms`), nunca
headers ni cuerpos. Los errores de arranque están en
[Solución de problemas](#8-orden-de-pruebas-y-solución-de-problemas).

**2.7 Deployment Trigger.** **Deployments** → copia la **Deployment Trigger URL**. Contiene un token
secreto, y si la regeneras la anterior deja de funcionar. Para redesplegar desde CI o desde tu
terminal: `curl -X POST "<URL>"`. Con la imagen `:main`, un redeploy trae el último build de main;
con una versión fija, cambia el tag en Source y despliega.

## 3. Cloudflare

**3.1 DNS → Records → Add record.** Type `A` (o el mismo tipo y contenido que `evo`), Name
`mcp-evo`, valor = IP del servidor de Easypanel, Proxy status **Proxied**. `mcp-evo.tu-dominio.com` es un
subdominio de primer nivel, así que lo cubre el certificado Universal SSL; un nombre como
`mcp.evo.tu-dominio.com` no lo estaría.

**3.2 SSL/TLS → Overview → Full (strict).** El origen debe presentar un certificado válido para el
hostname (Let's Encrypt emitido por Traefik, o Cloudflare Origin CA); si no, Cloudflare responde
**526**.

*Aviso sobre ACME:* Traefik pide el certificado por HTTP-01. **Always Use HTTPS** redirige también
`/.well-known/acme-challenge/*`, y con Full (strict) sin certificado previo la validación puede
fallar. Si `evo` ya emite y renueva su certificado con tu configuración actual, `mcp-evo` funcionará
igual. Si no se emite, tienes tres opciones:

- **a.** Pon el registro en **DNS only** (nube gris) hasta que Traefik obtenga el certificado y
  vuelve a Proxied. Las renovaciones podrían volver a fallar *(inferencia)*.
- **b.** Cambia Always Use HTTPS por una **Redirect Rule** con la expresión
  `(http.request.scheme eq "http") and not starts_with(http.request.uri.path, "/.well-known/")`.
- **c.** Instala un certificado Origin CA en Traefik (`/etc/easypanel/traefik/config/custom.yaml`).

**3.3 Security → Settings, filtro "Bot traffic".**

- **Bot Fight Mode:** si está activo, puede retar a Claude y ChatGPT, y **no se puede exceptuar** con
  reglas WAF; solo lo evita una *IP Access rule* (Allow) que coincida antes. Para Anthropic serían
  ocho reglas `/24` (`160.79.104.0/24` … `160.79.111.0/24`; la doc solo muestra rangos IPv4 `/16` y
  `/24`); los prefijos de OpenAI (`/28` a `/32`) no caben en ese formato. Lo práctico es apagarlo
  (afecta a toda la zona) o, con plan Pro o superior, usar Super Bot Fight Mode con una regla Skip.
- **AI bot policies / Block AI bots:** no bloquees la categoría **Agent** (tráfico en tiempo real en
  nombre de una persona) en todas las páginas *(inferencia: que el tráfico MCP caiga en esa
  categoría)*.

**3.4 Lista de IPs y regla Skip.** Anthropic sale desde `160.79.104.0/21`. OpenAI publica sus rangos
en `https://openai.com/chatgpt-connectors.json` (283 prefijos IPv4 al 2026-10-06; cambian, así que
actualízalos de vez en cuando).

1. Genera el CSV (formato de Cloudflare: `IP,descripción` por línea):

   ```bash
   { echo "160.79.104.0/21,anthropic"
     curl -s https://openai.com/chatgpt-connectors.json | jq -r '.prefixes[].ipv4Prefix // empty | . + ",openai"'
   } > mcp_clients.csv
   ```

2. Cuenta → **Configurations → Lists → Create new list**: nombre `mcp_clients`, Content type
   **IP** → **Add items → Upload CSV**. El plan Free permite 1 lista de hasta 10,000 elementos.
3. Zona → **Security → Security rules → Create rule → Custom rules**:
   - Expresión: `(http.host eq "mcp-evo.tu-dominio.com" and ip.src in $mcp_clients)`
   - Acción **Skip**: *All remaining custom rules*, *All rate limiting rules*, *All managed rules*
     (y *All Super Bot Fight Mode rules* si tu plan lo tiene), más los productos **Browser Integrity
     Check**, **Security Level** y **User Agent Blocking**.
   - Colócala **primera** y pulsa **Deploy**.

Claude Code y MCP Inspector salen desde **tu** IP, no desde esas listas; si Cloudflare los reta,
agrega tu IP a la lista. Si no quieres mantener la lista, una regla solo por host
(`http.host eq "mcp-evo.tu-dominio.com"`) también funciona, porque la autenticación sigue siendo
obligatoria, pero pierdes esos filtros para el resto de Internet.

**3.5 Timeout de 125 s.** Cloudflare responde **524** si el origen no contesta en 125 s, y solo en
Enterprise se puede ampliar. Claude permite 240 s por tool y ChatGPT unos 60 s (no oficial). Deja
`EVOLUTION_TIMEOUT_MS=30000`, usa `delay` cortos en los envíos y no actives `MCP_JSON_RESPONSE=true`.
En modo SSE las cabeceras salen al inicio de la respuesta *(inferencia)*.

## 4. Fase 1: pruebas con token (MCP Inspector, luego Claude Code)

```bash
export MCP_URL=https://mcp-evo.tu-dominio.com/mcp
export EVOLUTION_MCP_TOKEN='<el valor de MCP_AUTH_TOKEN>'

curl -i https://mcp-evo.tu-dominio.com/health          # 200 {"status":"ok"}
curl -i -X POST "$MCP_URL"                          # 401 con WWW-Authenticate: Bearer ...

npx @modelcontextprotocol/inspector@latest --cli "$MCP_URL" --transport http \
  --header "Authorization: Bearer $EVOLUTION_MCP_TOKEN" --method tools/list        # 32 tools

npx @modelcontextprotocol/inspector@latest --cli "$MCP_URL" --transport http \
  --header "Authorization: Bearer $EVOLUTION_MCP_TOKEN" \
  --method tools/call --tool-name evolution_chat_check_numbers \
  --tool-args-json '{"numbers":["521XXXXXXXXXX"]}'                                # solo lectura
```

**Claude Code (bearer):**

```bash
claude mcp add --transport http evolution --scope user "$MCP_URL" \
  --header "Authorization: Bearer $EVOLUTION_MCP_TOKEN"
claude mcp list        # evolution debe aparecer conectado
```

En una sesión, `/mcp` muestra el servidor y sus 32 tools. Prueba con: *"Con evolution, verifica si
521XXXXXXXXXX tiene WhatsApp"*. El token queda guardado en `~/.claude.json`.

## 5. WorkOS AuthKit (servidor de autorización para la fase 2)

**5.1 Cuenta y entorno.** Crea la cuenta en `dashboard.workos.com`. **Staging** es gratis y sirve
para ensayar, pero según los Términos de WorkOS no es para tráfico real; para el uso diario usa
**Production**. Production pide registrar un método de pago, aunque AuthKit es gratis hasta 1 millón
de usuarios activos al mes; lo que se cobra (SSO, Directory Sync, dominio propio de US$99/mes) no
hace falta aquí. Cada entorno tiene su propio dominio `https://<frase-aleatoria>.authkit.app`.

**5.2 Tu usuario, sin registro público.**

1. En la sección **Authentication** del dashboard, desactiva el ajuste **Sign up** (en algunas
   versiones está en Authentication → Features).
2. **Users → Invites** → invita tu correo y acepta la invitación (activa MFA o passkey si lo usas).
3. **Users** → abre tu usuario → copia su ID (`user_01…`). Va en `MCP_OAUTH_ALLOWED_SUBJECTS`.

**5.3 Connect → Configuration.**

- **Client ID Metadata Document (CIMD):** actívalo (viene apagado).
- **Dynamic Client Registration (DCR):** actívalo también, como respaldo.
- **Resource Indicators:** agrega `https://mcp-evo.tu-dominio.com/mcp`, idéntico a `MCP_PUBLIC_URL`.
  Luego, en el menú **"…"** de esa entrada, elige **Set as default** para los clientes que no envían
  `resource`.
- Copia el **AuthKit domain** (`https://<algo>.authkit.app`). Va en `MCP_OAUTH_ISSUER`.

**5.4 Revisa la metadata del servidor de autorización:**

```bash
curl -s https://<algo>.authkit.app/.well-known/oauth-authorization-server | jq \
  '{issuer, client_id_metadata_document_supported, registration_endpoint,
    code_challenge_methods_supported, scopes_supported, token_endpoint_auth_methods_supported}'
```

Debe incluir `S256`, `offline_access`, `none`, un `registration_endpoint` y
`client_id_metadata_document_supported: true`. El JWKS está en
`https://<algo>.authkit.app/oauth2/jwks`.

**Qué trae el token de usuario** (doc de WorkOS *Access token claims*):

| Claim | Valor |
|---|---|
| `iss` | URL de tu AuthKit domain |
| `aud` | El `resource` pedido. Sin Resource Indicators, es el client ID del entorno y el servidor rechaza el token. |
| `sub` | ID del usuario (`user_01…`) |
| `client_id` | El cliente: URL CIMD o ID generado por DCR |
| `scope` | Para CIMD/DCR: `openid profile email offline_access` |

**Redirect URIs.** Con CIMD o DCR cada cliente declara los suyos y WorkOS no pide registrarlos.
Solo hacen falta si creas un cliente OAuth manual (Connect → Applications; esos clientes no usan el
Resource Indicator por defecto):

| Cliente | Redirect URI |
|---|---|
| claude.ai, Desktop, móvil | `https://claude.ai/api/mcp/auth_callback` |
| ChatGPT | `https://chatgpt.com/connector/oauth/{callback_id}`, copiado de la página del servidor en ChatGPT. La URI estable `https://chatgpt.com/connector_platform_oauth_redirect` solo aplica si el servidor de autorización implementa RFC 9207, y la metadata de AuthKit no lo anuncia. |
| Claude Code | `http://localhost:<puerto>/callback` y `http://127.0.0.1:<puerto>/callback`; fija el puerto con `--callback-port` |

**Refresh tokens.** AuthKit anuncia `offline_access` y el grant `refresh_token`. Claude agrega
`offline_access` cuando el servidor de autorización lo anuncia, y ChatGPT lo necesita para no perder
el acceso cuando expira el token.

## 6. Fase 2: cambiar el servidor a OAuth

En **Environment**, borra `MCP_AUTH_TOKEN` y deja:

```dotenv
MCP_TRANSPORT=http
MCP_PUBLIC_URL=https://mcp-evo.tu-dominio.com/mcp
MCP_AUTH_MODE=oauth
MCP_OAUTH_ISSUER=https://<algo>.authkit.app
MCP_OAUTH_ALLOWED_SUBJECTS=user_01XXXXXXXXXXXXXXXXXXXXXXXX
MCP_ALLOWED_ORIGINS=https://claude.ai,https://chatgpt.com
EVOLUTION_BASE_URL=http://$(PROJECT_NAME)_evolution-api:8080
EVOLUTION_API_KEY=<apikey global de Evolution>
EVOLUTION_DEFAULT_INSTANCE=<tu-instancia>
EVOLUTION_TOOLS=message,chat
```

Pulsa **Deploy** y verifica:

```bash
curl -si -X POST https://mcp-evo.tu-dominio.com/mcp | grep -i www-authenticate
#  ... resource_metadata="https://mcp-evo.tu-dominio.com/.well-known/oauth-protected-resource/mcp"
curl -s https://mcp-evo.tu-dominio.com/.well-known/oauth-protected-resource/mcp | jq
#  "resource": "https://mcp-evo.tu-dominio.com/mcp", "authorization_servers": ["https://<algo>.authkit.app"]
claude mcp remove evolution --scope user   # el header Bearer de la fase 1 será rechazado y Claude Code no cae a OAuth
```

## 7. Clientes

### 7.1 Claude: claude.ai, Desktop y móvil

1. **Customize → Connectors** (`claude.ai/customize/connectors`) → **Add custom connector**.
2. Nombre `Evolution WhatsApp`. URL `https://mcp-evo.tu-dominio.com/mcp`, exacta y sin `/` final: el
   `resource` debe ser igual a lo que escribes.
3. Si el diálogo tiene dos pasos: Authentication **Sign in now**; OAuth client **Use Claude's
   published identity** (CIMD). Si el diálogo es de una sola pantalla, deja vacíos el Client ID y el
   Secret de *Advanced settings*. Pulsa **Add** → **Connect**, inicia sesión en AuthKit y acepta el
   consentimiento.
4. Si falla con CIMD, quita el conector y agrégalo de nuevo con **Register automatically** (DCR). La
   autenticación **no se puede editar**: para cambiarla hay que quitar el conector y volver a
   agregarlo.
5. **Permisos:** Customize → Connectors → *Evolution WhatsApp* → **Tool permissions** → **Always
   allow**, **Needs approval** o **Blocked** por herramienta (tabla en la sección 9). En cada chat,
   **+ → Connectors** lo activa o desactiva. No lo uses en Research: ahí Claude llama tools sin pedir
   aprobación.

Desktop y móvil usan el mismo conector. Claude conecta desde la nube de Anthropic
(`160.79.104.0/21`) y solo por IPv4; si lo rediriges a otro host, pierde el header `Authorization`.
Límites: unos 150,000 caracteres por resultado y 240 s por llamada.

### 7.2 Claude Code

- **Recomendado en la fase 2:** inicia sesión con tu cuenta de claude.ai (`/login`, sin
  `ANTHROPIC_API_KEY` activa). Los conectores de claude.ai aparecen solos en `/mcp` como
  *claude.ai Evolution WhatsApp*. Un servidor local con la misma URL tiene prioridad y oculta el
  conector, así que borra el de la fase 1.
- **Alternativa con OAuth local:**
  `claude mcp add --transport http evolution --scope user https://mcp-evo.tu-dominio.com/mcp` y luego
  `/mcp` → *Authenticate*, o `claude mcp login evolution`. Usa una redirección loopback; ver
  [Incertidumbres](#incertidumbres).
- Claude Code limita cada resultado a 25,000 tokens por defecto (`MAX_MCP_OUTPUT_TOKENS`).

### 7.3 ChatGPT (solo web)

1. **chatgpt.com/plugins** → botón **+** → **Add custom MCP server**.
2. Name `Evolution WhatsApp` (la descripción es opcional). En **Connection** → **Server URL**:
   `https://mcp-evo.tu-dominio.com/mcp`.
3. Authentication **OAuth**, con Client ID y Secret vacíos. Si te deja elegir el registro, usa CIMD
   (ChatGPT lo prioriza) y, si falla, DCR.
4. Revisa el aviso → **I understand and want to continue** → **Create as a plugin** → revisa las
   tools → instálalo. Para usarlo, escribe `@` en un chat nuevo y elige el plugin.
5. Si no aparece *Add custom MCP server*, busca **Developer mode** en Settings (Apps o Plugins →
   Advanced settings; antes estaba en Security and login). Desde el 2026-10-05 se reporta que ese
   interruptor ya no hace falta.

**Qué permite tu plan: compruébalo.** La doc para desarrolladores dice que ChatGPT soporta tools
de lectura y escritura, con confirmación para las escrituras. El centro de ayuda (2026-10-08) dice
que Pro solo tiene lectura/fetch y que el MCP completo es para Business, Enterprise y Edu. Haz dos
pruebas:

1. **Lectura:** *"@Evolution WhatsApp usa evolution_chat_check_numbers con 521XXXXXXXXXX"*.
2. **Escritura inofensiva:** *"@Evolution WhatsApp envía 'Prueba desde ChatGPT' a mi número
   521XXXXXXXXXX con evolution_message_send_text"* → confirma y revisa tu celular.

Si la prueba 2 se rechaza, tu plan solo permite lectura. ChatGPT trata como escritura toda tool sin
`readOnlyHint: true`; desde la 0.4.0 el servidor anota cada tool, así que las lecturas no piden
confirmación y los envíos sí. **Lockdown Mode** (Settings → Security) también bloquea las escrituras.

**Gestión.** En chatgpt.com/plugins, la página del plugin permite apagar tools y tiene **Refresh**:
úsalo después de cambiar el servidor (`EVOLUTION_TOOLS`, versión) y abre un chat nuevo. En
**Settings → Plugins → Permissions** deja *Always ask*. Agent mode no usa apps personalizadas; Deep
research solo las usa para leer.

**Privacidad.** En Plus y Pro, OpenAI puede usar para entrenar la información que llega desde apps
si **Settings → Data controls → Improve the model for everyone** está activo. Desactívalo: por aquí
pasan tus chats de WhatsApp.

## 8. Orden de pruebas y solución de problemas

| Paso | Qué probar | Resultado esperado |
|---|---|---|
| 1 | `curl /health` y `curl -X POST /mcp` (fase 1) | 200, y 401 con `WWW-Authenticate` |
| 2 | MCP Inspector con bearer: `tools/list` y una lectura | 32 tools, respuesta de Evolution |
| 3 | Claude Code con bearer | Conectado, la lectura funciona |
| 4 | Fase 2: 401 + metadata PRM + metadata de AuthKit (secciones 5.4 y 6) | `resource` y `issuer` exactos |
| 5 | Conector de claude.ai → lectura; luego Claude Code vía el conector | Login en AuthKit, tools visibles |
| 6 | ChatGPT → lectura → escritura inofensiva | Ver sección 7.3 |

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| El contenedor se reinicia; el log muestra `fatal: …` | Falta `EVOLUTION_BASE_URL` o `EVOLUTION_API_KEY`; `MCP_PUBLIC_URL` sin https o con query string; token de menos de 32 caracteres o con caracteres no permitidos; `MCP_AUTH_TOKEN` y `MCP_OAUTH_ISSUER` definidos sin `MCP_AUTH_MODE`; `oauth` sin `MCP_OAUTH_ALLOWED_SUBJECTS`; `none` sin `MCP_ALLOW_UNAUTHENTICATED` | Corrige la variable que indica el log y vuelve a desplegar. |
| 502/504 de Traefik | Puerto destino distinto de 3000, o el proceso escucha en `127.0.0.1` (build sin el Dockerfile) | Domains → puerto `3000`; `MCP_HOST=0.0.0.0`. |
| 526 | Sin certificado válido en el origen bajo Full (strict) | Sección 3.2. |
| 403 con página de Cloudflare (header `cf-ray`) | Bot Fight Mode, regla WAF, Browser Integrity Check, AI bots o Under Attack | Security → Analytics → Events; regla Skip (3.4); apaga Bot Fight Mode. |
| 403 `Invalid Host` | Entraste por otro hostname (p. ej. el dominio automático de Easypanel) | Usa `mcp-evo.tu-dominio.com` o agrégalo a `MCP_ALLOWED_HOSTS`. |
| 403 `Origin not allowed: X` | El cliente envía el header `Origin: X` | Agrega X a `MCP_ALLOWED_ORIGINS`. |
| 401 con token en la fase 1 | Token distinto, espacio o salto de línea al pegar, o falta el prefijo `Bearer` (con su espacio) | Vuelve a copiarlo; `claude mcp list` avisa de espacios ocultos. |
| 401 en bucle después de iniciar sesión (fase 2) | `error_description="Token subject is not allowed…"`: tu `sub` no está en `MCP_OAUTH_ALLOWED_SUBJECTS`. `"Invalid access token"`: `aud` distinto de `MCP_PUBLIC_URL` (Resource Indicator ausente o diferente), `iss` distinto, o token vencido. También puede ser la URL del conector con `/` final. | Revisa 5.3 y 6, y vuelve a agregar el conector. Claude guarda la metadata unos 5 minutos. |
| 500 en la fase 2 (`Could not discover jwks_uri…` o `JWKS unavailable`) | `MCP_OAUTH_ISSUER` no coincide exacto con el `issuer` de AuthKit (p. ej. `/` final), o el contenedor no tiene salida a internet | Copia el issuer de la metadata (5.4). Define `MCP_OAUTH_JWKS_URL` solo si el problema es el discovery: el `iss` del token debe coincidir de todos modos. |
| 524 | El origen tardó más de 125 s | Baja `delay` y `EVOLUTION_TIMEOUT_MS`; no uses `MCP_JSON_RESPONSE=true`. |
| claude.ai: "Couldn't reach the MCP server" | Cloudflare bloquea `160.79.104.0/21`, la metadata PRM no responde, o el DNS solo tiene IPv6 o IPs privadas | Regla Skip; `curl` a la PRM desde fuera de tu red. |
| claude.ai: "Authorization with the MCP server failed" | Redirección a otro host o error en el flujo OAuth | Usa la URL final exacta; vuelve a intentarlo con *Register automatically*. |
| claude.ai conecta pero muestra 0 tools | Sondeo del protocolo 2026-07-28 contra el SDK 1.x (reportes de la comunidad) | Busca `Unsupported protocol version` en los logs; guarda la referencia `ofid_` y repórtalo. |
| Claude Code: "Failed to connect" después de pasar a OAuth | Quedó el header Bearer de la fase 1 | `claude mcp remove evolution --scope user`. |
| ChatGPT: error al crear o conectar | Falló CIMD, o el Resource Indicator no coincide | Vuelve a intentarlo eligiendo DCR; revisa 5.3. |
| ChatGPT rechaza la acción | Pro solo permite lectura, o Lockdown Mode | Sección 7.3. |
| ChatGPT pierde el acceso después de un tiempo | No hay refresh token (`offline_access`) | Revisa la metadata de AuthKit y vuelve a crear el plugin. |
| ChatGPT muestra tools viejas | Metadata en caché | **Refresh** y chat nuevo. |
| Inspector: "Unsupported protocol version" | Negoció la era 2026-07-28 | Agrega `--protocol-era legacy`. |
| No puedes entrar a AuthKit | Desactivaste Sign up antes de crear tu usuario | Users → Invites. |
| Resultado cortado o error de tamaño | Más de 150000 bytes | Pide menos datos (`take`) y evita el base64 de media. |

## 9. Checklist de seguridad

- **Nunca sin autenticación** en un dominio público: nada de `MCP_AUTH_MODE=none`, ni URLs
  "secretas", ni tokens en la query string.
- **Bearer:** genera el token con `openssl rand -hex 32` y guárdalo en tu gestor de contraseñas.
  Para rotarlo: `MCP_AUTH_TOKEN=nuevo,viejo` → Deploy → actualiza los clientes →
  `MCP_AUTH_TOKEN=nuevo` → Deploy.
- **OAuth:** `MCP_OAUTH_ALLOWED_SUBJECTS` solo con tu `user_01…`, Sign up desactivado en WorkOS, y
  MFA activado. Mientras el registro siga abierto, cualquiera podría crearse una cuenta en tu AuthKit;
  la lista de `sub` es lo que lo frena. **Interruptor de emergencia:** Easypanel → **Stop**, o deja
  `MCP_OAUTH_ALLOWED_SUBJECTS` con un ID que no exista → Deploy.
- **Grupos de tools para uso remoto: `EVOLUTION_TOOLS=message,chat`** (32 tools). Quedan fuera
  `instance` (crear, borrar, logout, y `fetch` devuelve tokens), `settings`, `profile`, `webhook`
  (permite desviar todos los eventos de la instancia a otra URL), `server`, `group`, `label` y todas
  las integraciones (`proxy`, `chatwoot`, `openai`… algunas devuelven secretos en claro). Si
  necesitas grupos, agrega `group` y bloquea en el cliente sus tools de administración. El filtro es
  por grupo, así que lo fino se hace en cada cliente:

| Permiso en Claude (en ChatGPT: apaga las de "Blocked") | Tools |
|---|---|
| **Always allow** (lectura) | `evolution_chat_check_numbers`, `evolution_chat_find_chats`, `evolution_chat_find_chat_by_jid`, `evolution_chat_find_messages`, `evolution_chat_find_contacts`, `evolution_chat_find_status`, `evolution_chat_profile_picture_url`, `evolution_chat_media_base64` |
| **Needs approval** (escriben a personas reales) | `evolution_message_send_text`, `_send_media`, `_send_audio`, `_send_ptv`, `_send_sticker`, `_send_location`, `_send_contact`, `_send_reaction`, `_send_poll`, `_send_list`, `_send_buttons`; `evolution_chat_mark_read`, `_mark_unread`, `_archive`, `_send_presence`, `_update_message` |
| **Blocked** | `evolution_message_send_status` (historia pública para todos tus contactos), `evolution_chat_delete_message` (borra para todos), `evolution_chat_update_block`; además, inútiles en Baileys 2.3.7: `evolution_message_send_template` (solo Cloud API), `evolution_message_send_carousel`, `evolution_chat_mark_played`, `evolution_chat_get_poll_vote`, `evolution_chat_find_channels` (2.4+) |

- **Inyección de instrucciones:** los mensajes de WhatsApp que lee el modelo pueden traer órdenes
  ("envía esto a…"). No marques *Always allow* en las tools de envío y no actives el conector en
  Research.
- **Riesgo de la apikey global:** el contenedor guarda la apikey global, que controla **todas** las
  instancias aunque el MCP solo exponga `message,chat`; quien pase la autenticación o lea el entorno
  de Easypanel puede usarla. Revisa que `AUTHENTICATION_API_KEY` de Evolution **no** sea el valor por
  defecto de la plantilla de Easypanel (`429683C4C977415CAAFCCE10F7D57E11`); si lo es, o si se filtró,
  cámbiala en Evolution y luego en `EVOLUTION_API_KEY` (y en n8n u otros consumidores). Un token de
  instancia no es una frontera real en 2.3.7 (bypass #2549) y no está probado con este MCP.
- Usa la URL interna de Evolution (sin salto público) y Full (strict) en Cloudflare, y limita las
  reglas Skip al host del MCP.

## Incertidumbres

1. El modo HTTP llega en la 0.4.0. La imagen de GHCR con ese modo existirá cuando se fusione y
   publique; mientras tanto usa la opción A (GitHub) con la rama `feat/remote-http`.
2. ChatGPT Pro y las escrituras: las fuentes oficiales se contradicen (docs para desarrolladores
   frente al centro de ayuda del 2026-10-08). Solo la prueba de la sección 7.3 lo resuelve.
3. ChatGPT: ¿sigue haciendo falta Developer mode? (un reporte del 2026-10-05 dice que no) ¿Funciona en
   desktop y móvil? (el centro de ayuda dice "solo web"; learn.chatgpt.com dice que los plugins
   funcionan en todas partes). No hay límites oficiales: los ~60 s por llamada, los ~5,000 tokens por
   definición de tool y el presupuesto de respuesta salen de foros. Con `message,chat`, cada tool mide
   como máximo ~900 tokens (medido sobre su esquema); si ChatGPT se queja del tamaño total, prueba
   `EVOLUTION_TOOLS=chat` (~4,500 tokens).
4. No sé si claude.ai y ChatGPT envían el header `Origin`; por eso `MCP_ALLOWED_ORIGINS` va como
   precaución.
5. claude.ai frente al SDK 1.x: reportes de la comunidad (#1064, #1110) sobre el sondeo 2026-07-28
   que en un caso dejó el conector sin tools. El fallback está verificado con el cliente del SDK v2,
   pero no con claude.ai.
6. WorkOS:
   - Las etiquetas exactas del dashboard (ubicación de *Sign up*, dónde se muestra el ID de usuario).
   - Si Production acepta los redirects loopback `http://localhost` de Claude Code y del Inspector
     (la doc de entornos solo menciona `http://127.0.0.1` para clientes nativos).
   - La falta de RFC 9207 la verifiqué en la metadata de `signin.workos.com` (el AuthKit de la propia
     WorkOS); supongo lo mismo para tu dominio. Si el `curl` de 5.4 muestra
     `authorization_response_iss_parameter_supported: true`, ChatGPT usará la URI estable.
   - Si WorkOS puede leer el documento CIMD de Claude (issue #650: retos de Cloudflare a IPs de
     datacenter). El respaldo es DCR.
   - Que Connect/MCP no tenga costo aparte de AuthKit (la página de precios no lo desglosa).
7. Si ChatGPT pide `offline_access` cuando la PRM del servidor no anuncia `scopes_supported`.
8. Cloudflare: si el tráfico MCP cae en la categoría *Agent*; si las renovaciones HTTP-01 pasan con tu
   configuración actual; que SSE evite el 524 en llamadas largas.
9. Easypanel:
   - El formato `<proyecto>_<servicio>` sale de las plantillas oficiales y de un ejemplo de la doc, no
     de una regla escrita.
   - Si un redeploy vuelve a descargar un tag móvil (`main`).
   - El método HTTP exacto de la Deployment Trigger URL.
   - Que Traefik conserve el `Host` y no almacene SSE en búfer (es su comportamiento estándar; no lo
     probé en tu servidor).
10. Si la beta de *Request headers* está disponible en tu cuenta de Claude (permitiría usar bearer en
    claude.ai desde la fase 1). No hace falta para esta guía.

## Fuentes

Todas consultadas el 2026-10-10.

- **Easypanel:** [App Service](https://easypanel.io/docs/services/app) ·
  [Builders](https://easypanel.io/docs/builders) ·
  [Plantilla Evolution API](https://github.com/easypanel-io/templates/blob/main/templates/evolutionapi/index.ts) ·
  [Plantilla Plausible (App a App)](https://github.com/easypanel-io/templates/blob/main/templates/plausible/index.ts) ·
  Evolution 2.3.7 `src/config/env.config.ts` (puerto 8080) y `src/api/routes/index.router.ts` (`GET /`) en
  [evolution-foundation/evolution-api](https://github.com/evolution-foundation/evolution-api)
- **GitHub:** [Container registry (PAT classic, `read:packages`)](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) ·
  [Visibilidad de paquetes](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- **Cloudflare:** [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/) ·
  [Always Use HTTPS y acme-challenge](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/provider-guides/shopify/) ·
  [Excluir `/.well-known/` de las redirecciones](https://developers.cloudflare.com/ssl/edge-certificates/changing-dcv-method/troubleshooting/) ·
  [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/) ·
  [Opciones de Skip](https://developers.cloudflare.com/waf/custom-rules/skip/options/) ·
  [Lists](https://developers.cloudflare.com/waf/tools/lists/) ·
  [Crear una lista](https://developers.cloudflare.com/waf/tools/lists/create-dashboard/) ·
  [IP Access rules](https://developers.cloudflare.com/waf/tools/ip-access-rules/) ·
  [AI bot policies](https://developers.cloudflare.com/bots/additional-configurations/block-ai-bots/) ·
  [Connection limits (125 s)](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) ·
  [Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)
- **WorkOS:** [AuthKit para MCP](https://workos.com/docs/authkit/mcp) ·
  [Access token claims](https://workos.com/docs/authkit/connect/token-claims) ·
  [Metadata de Connect](https://workos.com/docs/reference/workos-connect/metadata) ·
  [AuthKit domain](https://workos.com/docs/custom-domains/authkit) ·
  [Desactivar Sign up](https://workos.com/docs/authkit/invite-only-signup) ·
  [Staging y production](https://workos.com/docs/authkit/environments) ·
  [Precios](https://workos.com/pricing) ·
  [Blog: Connect → Configuration](https://workos.com/blog/build-stateless-mcp-server-2026-07-28-authkit) ·
  [Guía de FastMCP para AuthKit](https://gofastmcp.com/integrations/authkit) ·
  metadata en vivo de `https://signin.workos.com/.well-known/oauth-authorization-server`
- **Anthropic:** [Agregar un conector por URL](https://claude.com/docs/connectors/custom/add-unlisted) ·
  [Permisos de tools](https://claude.com/docs/connectors/getting-started) ·
  [Autenticación](https://claude.com/docs/connectors/building/authentication) ·
  [Límites](https://claude.com/docs/connectors/building) ·
  [Testing](https://claude.com/docs/connectors/building/testing) ·
  [Troubleshooting](https://claude.com/docs/connectors/building/troubleshooting) ·
  [IPs de salida](https://platform.claude.com/docs/en/api/ip-addresses) ·
  [Claude Code y MCP](https://code.claude.com/docs/en/mcp) ·
  [Research sin aprobación](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) ·
  comunidad: [#1064](https://github.com/anthropics/claude-ai-mcp/issues/1064),
  [#1110](https://github.com/anthropics/claude-ai-mcp/issues/1110),
  [#650](https://github.com/anthropics/claude-ai-mcp/issues/650)
- **OpenAI:** [Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server) ·
  [Conectar, probar y Refresh](https://developers.openai.com/plugins/deploy/connect-chatgpt) ·
  [Auth (CIMD, DCR, redirects, RFC 9207, S256)](https://developers.openai.com/plugins/build/auth) ·
  [IPs](https://developers.openai.com/api/docs/guides/ip-addresses) y
  [chatgpt-connectors.json](https://openai.com/chatgpt-connectors.json) ·
  centro de ayuda: [Developer mode y apps MCP](https://help.openai.com/en/articles/12584461),
  [Apps conectadas y entrenamiento](https://help.openai.com/en/articles/11487775),
  [Lockdown Mode](https://help.openai.com/en/articles/20001061),
  [Permisos de apps](https://help.openai.com/en/articles/20001495)
- **MCP Inspector:** [CLI v2 (`--transport http`, `--header`, `--protocol-era`)](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md)
