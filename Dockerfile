# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- builder
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# deps do servidor
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# deps do painel
COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix web install --no-audit --no-fund

# codigo
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY web ./web

RUN npx prisma generate
RUN npm run build:server
RUN npm --prefix web run build

# ---------------------------------------------------------------- runtime
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends openssl curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY prisma ./prisma
RUN npx prisma generate

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

# Sem HEALTHCHECK na imagem de proposito: a MESMA imagem roda a API e o
# worker, e o worker nao sobe servidor HTTP — um healthcheck de imagem o
# marcaria como doente para sempre. Configure o healthcheck no EasyPanel,
# apenas no servico da API, apontando para GET /health.

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["api"]
