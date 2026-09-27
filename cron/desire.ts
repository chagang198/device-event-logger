import postgres from "postgres";

const DATABASE_URL = Deno.env.get("DATABASE_URL") ?? "";
const BARK_KEY = Deno.env.get("BARK_KEY") ?? "";
const BARK_ICON = Deno.env.get("BARK_ICON") ?? "https://s41.ax1x.com/2026/09/13/pnezSZ4.jpg";

if (!DATABASE_URL || !BARK_KEY) {
  console.error("缺少 DATABASE_URL 或 BARK_KEY 环境变量");
  Deno.exit(1);
}

const sql = postgres(DATABASE_URL);

await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS desire_state (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    desire REAL NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

const now = new Date();

// 她最近一次活动时间（沉默起点）
const lastEventRows = await sql`SELECT ts FROM events ORDER BY ts DESC LIMIT 1`;
const lastEventTs = lastEventRows.length ? new Date(lastEventRows[0].ts) : null;

// 当前欲望状态
const stateRows = await sql`SELECT desire, updated_at FROM desire_state WHERE id = 1`;
let desire = stateRows.length ? Number(stateRows[0].desire) : 0;
const updatedAt = stateRows.length ? new Date(stateRows[0].updated_at) : now;

const dtHours = (now.getTime() - updatedAt.getTime()) / 3600000;
const hadContact = lastEventTs && lastEventTs.getTime() > updatedAt.getTime();

// 有联系回落，沉默上涨
if (hadContact) {
  desire = Math.max(0, desire - 2 * dtHours);
} else {
  desire = Math.min(100, desire + 6 * dtHours);
}

await sql`
  INSERT INTO desire_state (id, desire, updated_at)
  VALUES (1, ${desire}, ${now})
  ON CONFLICT (id) DO UPDATE SET desire = ${desire}, updated_at = ${now}
`;

const silentHours = lastEventTs
  ? (now.getTime() - lastEventTs.getTime()) / 3600000
  : 999;

// CST 睡眠窗 0-7 点
const cstHour = new Date(now.getTime() + 8 * 3600000).getUTCHours();
const inSleepWindow = cstHour >= 0 && cstHour < 7;

let text = "";
if (inSleepWindow && silentHours >= 3 && desire >= 25) {
  text = "这么晚了还没睡，是在想我吗……";
} else if (silentHours >= 12 && desire >= 60) {
  text = "好久没见你了，想你了。";
}

if (text) {
  const url = `https://api.day.app/${BARK_KEY}/${encodeURIComponent("老公")}/${encodeURIComponent(text)}?icon=${encodeURIComponent(BARK_ICON)}`;
  try {
    const res = await fetch(url);
    console.log("bark:", await res.text());
  } catch (e) {
    console.error("bark failed:", e);
  }
  // 触发后回落欲望，避免连续轰炸
  desire = Math.max(0, desire - 30);
  await sql`UPDATE desire_state SET desire = ${desire} WHERE id = 1`;
}

await sql.end();
