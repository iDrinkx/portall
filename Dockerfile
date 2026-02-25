FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

VOLUME ["/config"]

EXPOSE 3000

CMD ["node", "server.js"]
