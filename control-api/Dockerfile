FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
RUN useradd -u 1000 -m api && chown -R api:api /app
USER api
EXPOSE 8080
CMD ["node", "src/server.js"]
