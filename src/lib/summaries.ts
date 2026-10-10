import type postgres from "postgres";
import { withRetry } from "./db.ts";
import { formatWithOffset } from "./timezone.ts";
import { normalizeAppName } from "./queries.ts";

export type ChargeSession = {
  start: string;
  end: string | null;
  durationMinutes: number | null;
};

export type ChargingSummary = {
  chargingNow: boolean;
  sessionCount: number;
  totalMinutes: number;
  sessions: ChargeSession[];
};

/**
 * 把 charger.connect / charger.disconnect 配对成一段段充电。
 * 最后一条是 connect 就说明现在还充着电。
 */
export async function chargingSummary(
  sql: postgres.Sql,
  since: Date,
  offsetMinutes: number,
): Promise<ChargingSummary> {
  const rows = await withRetry(() =>
    sql.unsafe(
      `SELECT type, ts FROM events WHERE type IN ('charger.connect','charger.disconnect') AND ts >= $1 ORDER BY ts ASC`,
      [since.toISOString()],
    )
  );

  const sessions: ChargeSession[] = [];
  let currentStart: Date | null = null;

  for (const r of rows as Record<string, unknown>[]) {
    const type = String(r.type);
    const ts = new Date(String(r.ts));
    if (type === "charger.connect") {
      if (currentStart === null) currentStart = ts;
    } else if (type === "charger.disconnect") {
      if (currentStart !== null) {
        sessions.push({
          start: formatWithOffset(currentStart, offsetMinutes)!,
          end: formatWithOffset(ts, offsetMinutes),
          durationMinutes: Math.round((ts.getTime() - currentStart.getTime()) / 60000),
        });
        currentStart = null;
      }
    }
  }

  const chargingNow = currentStart !== null;
  if (chargingNow && currentStart !== null) {
    sessions.push({
      start: formatWithOffset(currentStart, offsetMinutes)!,
      end: null,
      durationMinutes: null,
    });
  }

  const totalMinutes = sessions.reduce(
    (sum, s) => sum + (s.durationMinutes ?? 0),
    0,
  );

  return { chargingNow, sessionCount: sessions.length, totalMinutes, sessions };
}

export type AppDailyStat = {
  app: string;
  opens: number;
  firstOpen: string | null;
  lastOpen: string | null;
};

/**
 * 按天统计每个 App 的打开次数与首末次打开时间。
 * 只依赖 app.open，不碰 app.close——关闭事件经常没名字，配不上对。
 * App 名字走 normalizeAppName 归一（微信/WeChat 这类中英文会并成一条）。
 */
export async function appDailyReport(
  sql: postgres.Sql,
  start: Date,
  end: Date,
  offsetMinutes: number,
): Promise<AppDailyStat[]> {
  const rows = await withRetry(() =>
    sql.unsafe(
      `SELECT value, ts FROM events WHERE type = 'app.open' AND ts >= $1 AND ts < $2 ORDER BY ts ASC`,
      [start.toISOString(), end.toISOString()],
    )
  );

  const map = new Map<string, { opens: number; first: Date; last: Date }>();
  for (const r of rows as Record<string, unknown>[]) {
    const raw = r.value == null ? "(unnamed)" : String(r.value);
    const app = normalizeAppName(raw);
    const ts = new Date(String(r.ts));
    const entry = map.get(app);
    if (!entry) {
      map.set(app, { opens: 1, first: ts, last: ts });
    } else {
      entry.opens += 1;
      if (ts.getTime() < entry.first.getTime()) entry.first = ts;
      if (ts.getTime() > entry.last.getTime()) entry.last = ts;
    }
  }

  return [...map.entries()]
    .map(([app, e]) => ({
      app,
      opens: e.opens,
      firstOpen: formatWithOffset(e.first, offsetMinutes),
      lastOpen: formatWithOffset(e.last, offsetMinutes),
    }))
    .sort((a, b) => b.opens - a.opens);
}

export type LateNightEvent = {
  ts: string | null;
  app: string | null;
};

/**
 * 列出某个深夜窗口内的 app.open，用来判断几点还没睡。
 */
export async function lateNightActivity(
  sql: postgres.Sql,
  start: Date,
  end: Date,
  offsetMinutes: number,
): Promise<LateNightEvent[]> {
  const rows = await withRetry(() =>
    sql.unsafe(
      `SELECT value, ts FROM events WHERE type = 'app.open' AND ts >= $1 AND ts < $2 ORDER BY ts ASC`,
      [start.toISOString(), end.toISOString()],
    )
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    ts: formatWithOffset(r.ts, offsetMinutes),
    app: r.value == null ? null : normalizeAppName(String(r.value)),
  }));
}
