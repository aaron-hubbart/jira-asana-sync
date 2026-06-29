FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY customers.yaml ./customers.yaml

FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
ENV DB_PATH=/data/state.db
RUN useradd -u 1000 -m sync && mkdir -p /data && chown -R sync:sync /data /app
USER sync
CMD ["node", "src/index.js"]
