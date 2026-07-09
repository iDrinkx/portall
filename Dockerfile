FROM node:24.18.0

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g npm@12.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

VOLUME ["/config"]

EXPOSE 3000

CMD ["node", "server.js"]
