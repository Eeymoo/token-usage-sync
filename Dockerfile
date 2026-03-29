FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8787

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY index.js package.json package-lock.json README.md ./
COPY src ./src
COPY sql ./sql

USER node

EXPOSE 8787

CMD ["node", "index.js"]
