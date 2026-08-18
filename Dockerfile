FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci

COPY frontend ./frontend
RUN npm --prefix frontend run build \
    && npm prune --omit=dev

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    BACKEND_PORT=8080

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/frontend/public/dist ./frontend/public/dist
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node index.js server.js ./
COPY --chown=node:node src ./src

EXPOSE 8080

USER node
CMD ["node", "index.js"]
