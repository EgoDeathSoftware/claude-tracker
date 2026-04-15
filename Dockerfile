FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
RUN pnpm install --frozen-lockfile

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 python3-pip \
	&& rm -rf /var/lib/apt/lists/* \
	&& pip3 install --no-cache-dir debugpy \
	&& ln -sf /usr/bin/python3 /usr/local/bin/python
COPY . .
EXPOSE 3001 5173
CMD ["pnpm", "dev"]
