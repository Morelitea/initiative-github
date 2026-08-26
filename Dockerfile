# Build the app, then ship only what runs it.
#
# Two stages because the build needs devDependencies and the TypeScript
# compiler, and the runtime needs neither — the smaller final image is a
# smaller thing to keep patched, not just a faster pull.

FROM node:24-alpine AS build

WORKDIR /app

# Dependencies first, so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
# The kit's `prepare` fetches the manifest schema from its pinned Initiative
# revision, so this layer needs the network. It is cached with the lockfile.
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm run manifest

# Re-resolve without devDependencies: the runtime carries the compiler nowhere.
RUN npm prune --omit=dev


FROM node:24-alpine AS runtime

# A published image should say what it is and where it came from.
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="initiative-github" \
      org.opencontainers.image.description="The reference Initiative app: GitHub issues and reviews." \
      org.opencontainers.image.source="https://github.com/Morelitea/initiative-github" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/manifest.json ./manifest.json
COPY package.json ./

# Never root. The node image ships an unprivileged `node` user for this.
USER node

EXPOSE 8080

# The platform pulls /.well-known/initiative-app.json, so a container that
# cannot serve is one that should not receive traffic. `readyz` additionally
# proves the database is reachable.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
