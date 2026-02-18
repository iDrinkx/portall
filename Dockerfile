FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

VOLUME ["/config"]

EXPOSE 3000

CMD ["node", "server.js"]