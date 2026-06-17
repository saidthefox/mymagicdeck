FROM node:20-alpine

# Build deps for better-sqlite3 (native module) + ImageMagick for perspective deskew
# + OpenCV (musl-native cv2) for document-scanner card corner detection
RUN apk add --no-cache python3 make g++ imagemagick py3-opencv py3-numpy ttf-dejavu fontconfig

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY detect_corners.py ./

# Data directory — mount /srv/data/mymagicdeck here
RUN mkdir -p /data

ENV PORT=3002
ENV DB_PATH=/data/mymagicdeck.db
# Set JWT_SECRET via environment in docker-compose (do not hardcode)

EXPOSE 3002

CMD ["node", "server.js"]
