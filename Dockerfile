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
ENV HOST=0.0.0.0
ENV PORT=4173
ENV DB_PATH=/data/water.sqlite

EXPOSE 4173
CMD ["npm", "start"]
