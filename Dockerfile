FROM node:20-alpine

RUN apk add --no-cache curl wget

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3080

EXPOSE 3080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c "wget -qO- http://127.0.0.1:${PORT:-3080}/health || exit 1"

CMD ["node", "server.js"]

