# The CashGear licence server. Build from this folder:
#   docker build -t cashgear-licensing services/licensing
# and run with CGV_LICENSING_KEY (the signing key's PEM) and a volume for the store.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN rm -f src/*.test.ts && mkdir /data && chown node:node /data
ENV NODE_ENV=production CGV_LICENSING_STORE=/data/licences.json PORT=8080
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/main.ts", "serve"]
