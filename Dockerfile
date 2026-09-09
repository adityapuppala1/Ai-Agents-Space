FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY apps ./apps
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY packages ./packages
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 5173
ENV HOST=0.0.0.0
CMD ["node", "packages/server/src/main.js"]
