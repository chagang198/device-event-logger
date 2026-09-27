import { createApp } from "../src/app.ts";
import { desireTick } from "../src/lib/desire.ts";

const app = createApp();

function scheduleDesire() {
  desireTick().catch((e) => console.error("desire tick failed:", e));
}
scheduleDesire();
setInterval(scheduleDesire, 15 * 60 * 1000);

Deno.serve((req) =>
  app.fetch(req, {
    API_KEY: Deno.env.get("API_KEY") ?? "",
    DATABASE_URL: Deno.env.get("DATABASE_URL") ?? "",
    TZ_OFFSET: Deno.env.get("TZ_OFFSET"),
  })
);
