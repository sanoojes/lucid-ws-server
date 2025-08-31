
FROM denoland/deno:latest

# Create working directory
WORKDIR /app

# Copy source
COPY . .

RUN deno install

ARG PORT
EXPOSE ${PORT:-8080}

# Run the app
CMD ["deno", "task", "start"]