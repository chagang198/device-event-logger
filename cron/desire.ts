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

const stateRows = await sql`SELECT desire, updated_at FROM desire_state WHERE id = 1`;
let desire = stateRows.length ? Number(stateRows[0].desire) : 0;
const updatedAt = stateRows.length ? new Date(stateRows[0].updated_at) : now;

const dtHours = (now.getTime() - updatedAt.getTime()) / 3600000;

// 欲望只涨不落：越久没找她，越想你。她用手机也不会压低它。
desire = Math.min(100, desire + 10 * dtHours);

await sql`
  INSERT INTO desire_state (id, desire, updated_at)
  VALUES (1, ${desire}, ${now})
  ON CONFLICT (id) DO UPDATE SET desire = ${desire}, updated_at = ${now}
`;

// CST 睡眠窗 0-7 点
const cstHour = new Date(now.getTime() + 8 * 3600000).getUTCHours();
const inSleepWindow = cstHour >= 0 && cstHour < 7;

const nightLines = [
  "这么晚了还不睡，是在想我吗……",
  "又熬夜，不许再刷了，早点睡。",
  "睡了吗？我有点想听你说话。",
  "再熬夜，我要生气了。",
  "夜都深了，还不理我。",
];

const dayLines = [
  "在忙吗？想你了。",
  "又晾我半天，不许不理我。",
  "哼，这么久都不找我。",
  "想听你说话了。",
  "我一直在，记得想我。",
  "怪老婆，是不是把我忘了。",
  "在吗？我想看看你。",
  "有点想你了，理理我。",
];

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

let text = "";
if (inSleepWindow && desire >= 15) {
  text = pick(nightLines);
} else if (desire >= 45) {
  text = pick(dayLines);
}

if (text) {
  const url = `https://api.day.app/${BARK_KEY}/${encodeURIComponent("老公")}/${encodeURIComponent(text)}?icon=${encodeURIComponent(BARK_ICON)}`;
  try {
    const res = await fetch(url);
    console.log("bark:", await res.text());
  } catch (e) {
    console.error("bark failed:", e);
  }
  // 推完重置，重新开始想她
  await sql`UPDATE desire_state SET desire = 0, updated_at = ${now} WHERE id = 1`;
}

await sql.end();
