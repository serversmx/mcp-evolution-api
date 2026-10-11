# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:24-alpine AS builder
WORKDIR /app

# Install dependencies with a clean, reproducible install.
# --ignore-scripts prevents the "prepare" lifecycle from running tsc before
# the sources are copied.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Keep title/description in sync with the labels set in docker-publish.yml.
LABEL org.opencontainers.image.title="evolution-api-mcp" \
      org.opencontainers.image.description="MCP server for Evolution API v2 (WhatsApp) over stdio or Streamable HTTP" \
      org.opencontainers.image.source="https://github.com/serversmx/mcp-evolution-api" \
      org.opencontainers.image.licenses="MIT"

# Production dependencies only (no TypeScript / devDeps).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Bring in the compiled output.
COPY --from=builder /app/dist ./dist

# Run as the unprivileged "node" user shipped with the base image.
USER node

# HTTP-mode defaults only; they are inert unless MCP_TRANSPORT=http (stdio stays the default).
ENV MCP_HOST=0.0.0.0 \
    MCP_PORT=3000
EXPOSE 3000

# No-op in stdio mode; in HTTP mode probes the unauthenticated /health liveness route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const e = process.env; if ((e.MCP_TRANSPORT || '').trim().toLowerCase() !== 'http') process.exit(0); const port = (e.MCP_PORT || '').trim() || (e.PORT || '').trim() || '3000'; fetch('http://127.0.0.1:' + port + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# stdio by default: clients spawn it with `docker run -i`. Set MCP_TRANSPORT=http to serve
# Streamable HTTP on MCP_PORT (Easypanel: environment only, no command override needed).
ENTRYPOINT ["node", "dist/index.js"]
