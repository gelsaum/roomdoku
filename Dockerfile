FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3080

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c "wget -qO- http://localhost:${PORT:-3080}/health || exit 1"

CMD ["node", "server.js"]

