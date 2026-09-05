FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Bangkok
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node","server.js"]
