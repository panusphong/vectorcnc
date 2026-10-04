FROM node:22-slim
WORKDIR /app
# 🎬 รอบ 148 — ffmpeg ประกอบวิดีโอนำเสนอของแอป Facade (core/facade-video.js)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production TZ=Asia/Bangkok
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node","server.js"]
