FROM node:24.18.0 AS dependencies

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24.18.0

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g npm@11.19.1

COPY package.json package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN chmod 755 /app/docker-entrypoint.sh

VOLUME ["/config"]

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
