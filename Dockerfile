FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY server/package.json server/pnpm-lock.yaml server/
RUN pnpm install --frozen-lockfile
RUN cd server && pnpm install --frozen-lockfile

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY . .
RUN [ -d server/src ] && cd server && pnpm build || true
EXPOSE 3001 5173
CMD ["pnpm", "dev"]
