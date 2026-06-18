FROM node:24-alpine

RUN apk add --no-cache sqlite python3 py3-openpyxl

WORKDIR /app
COPY app/package.json ./package.json
COPY app/src ./src
COPY app/public ./public
COPY app/db ./db
COPY app/scripts ./scripts

RUN mkdir -p /data && chown -R node:node /app /data

ENV NODE_ENV=production
ENV DB_PATH=/data/water.sqlite

CMD ["npm", "start"]
