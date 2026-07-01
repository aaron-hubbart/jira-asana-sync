FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
# node:20 already ships a non-root "node" user (uid 1000) — reuse it.
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
