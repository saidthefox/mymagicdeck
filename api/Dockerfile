FROM node:20-alpine

# Install build deps for better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Data directory — mount /srv/data/mymagicdeck here
RUN mkdir -p /data

ENV PORT=3002
ENV DB_PATH=/data/mymagicdeck.db
# Set JWT_SECRET via environment in docker-compose (do not hardcode)

EXPOSE 3002

CMD ["node", "server.js"]
