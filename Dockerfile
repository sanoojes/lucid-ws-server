FROM oven/bun:latest

WORKDIR /usr/src/app

COPY . .

RUN bun install

ARG PORT
EXPOSE ${PORT:-3000}

CMD ["bun", "run", "start"]
