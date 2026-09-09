FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY apps ./apps
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# git powers worktree isolation and diff artifacts for managed runs.
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY packages ./packages
# bin/ holds agent-space.js (CLI + Claude hook bridge) and, when this build has
# the MCP module, agent-space-mcp.js (stdio MCP bridge for external clients).
COPY bin ./bin
COPY docs ./docs
COPY --from=build /app/apps/web/dist ./apps/web/dist
# data/ holds the SQLite database, worktrees, and artifacts; keep it on a volume.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 5173
# HOST=0.0.0.0 accepts remote clients only when AGENT_SPACE_TOKEN is set
# (shared mode); pass it with `docker run -e AGENT_SPACE_TOKEN=...`.
ENV HOST=0.0.0.0 \
    AGENT_SPACE_DB=/app/data/agent-space.sqlite \
    AGENT_SPACE_DATA_DIR=/app/data
CMD ["node", "packages/server/src/main.js"]
