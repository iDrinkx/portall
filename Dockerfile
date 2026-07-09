FROM node:24.18.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

VOLUME ["/config"]

EXPOSE 3000

CMD ["node", "server.js"]
