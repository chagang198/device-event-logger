FROM denoland/deno:latest
EXPOSE 8000
WORKDIR /app
COPY deno.json .
COPY src/ src/
COPY entry/deno.ts entry/
COPY cron/ cron/
RUN deno cache entry/deno.ts
CMD ["deno", "task", "start"]
