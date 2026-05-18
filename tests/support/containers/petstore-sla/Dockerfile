FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev
COPY server.js /app/server.js
ENV PORT=8080
ENV BASE_PATH=/v1
ENV REDIS_PRIMARY_HOST=host.docker.internal
ENV REDIS_PRIMARY_PORT=6379
ENV REDIS_REPLICA_HOST=host.docker.internal
ENV REDIS_REPLICA_PORT=6379
EXPOSE 8080
CMD ["node", "server.js"]
