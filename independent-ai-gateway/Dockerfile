FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
FROM node:20-alpine
ENV NODE_ENV=production PORT=3090 KNOWLEDGE_FILE=/opt/ai/config/knowledge.yaml
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY config /opt/ai/config
USER node
EXPOSE 3090
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3090/healthz >/dev/null || exit 1
CMD ["node","src/index.js"]
