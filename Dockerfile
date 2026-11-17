# syntax=docker/dockerfile:1

# ---- build: install all deps, compile TypeScript -------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# --ignore-scripts: `prepare` runs the build, which needs the sources copied below.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---- runtime: production deps + compiled output only ---------------------------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    # Non-loopback bind (reachable from outside the container). This makes
    # SERVER_AUTH_TOKEN mandatory: the server refuses to start without it.
    HOST=0.0.0.0

COPY package.json package-lock.json ./
# --ignore-scripts: `prepare` would try to build, and devDependencies are absent.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
