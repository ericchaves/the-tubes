# ── Stage 1: base ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable

# ── Stage 2: deps ─────────────────────────────────────────────────────────────
# Zero runtime dependencies, so this stage is minimal.
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod 2>/dev/null || true

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app

# Copy only what's needed to run
COPY --from=deps /app/node_modules ./node_modules
COPY bin/ ./bin/
COPY src/ ./src/
COPY package.json ./

# Non-root user for security
RUN addgroup -S -g 1001 thetubes && \
    adduser -S -G thetubes -u 1001 -h /home/thetubes thetubes && \
    mkdir -p /home/thetubes && \
    chown thetubes:thetubes /home/thetubes
USER thetubes

ENV NODE_ENV=production \
    HOME=/home/thetubes

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.TT_PUBLIC_PORT||80)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "bin/tt.js"]
CMD ["serve"]
