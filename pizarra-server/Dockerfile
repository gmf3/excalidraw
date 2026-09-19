# Pizarra: Excalidraw con proyectos y hojas guardados en disco.
# Se construye desde la raíz del repo:
#   docker build -f pizarra-server/Dockerfile -t pizarra .

FROM node:24 AS build

WORKDIR /opt/node_app

COPY . .

RUN --mount=type=cache,target=/root/.cache/yarn \
    yarn --frozen-lockfile --network-timeout 600000

ENV VITE_APP_PIZARRA=true
RUN yarn build:app:docker

FROM node:24-alpine

WORKDIR /app
COPY pizarra-server/server.mjs ./
COPY --from=build /opt/node_app/excalidraw-app/build ./build

ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/build \
    DATA_DIR=/data

VOLUME /data
EXPOSE 8080
USER node

HEALTHCHECK CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

CMD ["node", "server.mjs"]
