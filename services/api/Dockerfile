# syntax=docker/dockerfile:1

FROM node:18-alpine AS deps
WORKDIR /app

# Install root deps (we run from the repo root to share node_modules)
COPY package.json package-lock.json ./
RUN npm ci

FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY services/api ./services/api

# Build the API
RUN npm run api:build

EXPOSE 3000
CMD ["npm", "run", "api:start"]
