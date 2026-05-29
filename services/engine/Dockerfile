# syntax=docker/dockerfile:1

FROM node:18-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY services/engine ./services/engine
COPY services/api ./services/api

RUN npm run engine:build

CMD ["node", "services/engine/dist/engine/src/cli.js"]
