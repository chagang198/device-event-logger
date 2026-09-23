import type postgres from "postgres";
import type { DeleteFilter, EventQuery, EventRecord } from "../types.ts";
import { formatWithOffset, localDayRange } from "./timezone.ts";
import { withRetry } from "./db.ts";

/** 与建表时 CHECK 约束一致的事件类型格式 */
const TYPE_PATTERN = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

/** 同一 App 在不同触发下会报中英文两个名字，这里归一 */
const APP_NAME_ALIASES: Record<string, string> = {
  WeChat: "微信",
  Shortcuts: "快捷指令",
  XIQUEER: "喜鹊儿",
  Chaoxing: "学习通",
};

export function normalizeAppName(value: string): string {
  return APP_NAME_ALIASES[value] ?? value;
}

export function parseEventQueryFromUrl(url: URL): EventQuery | { error: string } {
  const result = parseEventQuery({
    hours: url.searchParams.get("hours") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    until: url.searchParams.get("until") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    value: url.searchParams.get("value") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  }, false);
  // When allowDefaultHours=false, parseEventQuery never returns string
  return result as EventQuery | { error: string };
}

export function parseEventQueryFromToolArgs(args: Record<string, unknown>): EventQuery | string {
  const result = parseEventQuery(args, true);
  if (typeof result === "string") return result;
  return result as EventQuery;
}

export function parseEventQuery(
  input: Record<string, unknown>,
  allowDefaultHours: boolean,
): EventQuery | { error: string } | string {
  const rawHours = input.hours;
  const rawSince = input.since;
  const rawUntil = input.until;
  const rawType = input.type;
  const rawValue = input.value;
  const rawLimit = input.limit;
  const rawOffset = input.offset;

  const fail = (message: string) => allowDefaultHours ? message : { error: message };

  let since: Date;
  if (rawHours != null && rawHours !== "") {
    const hours = Number(rawHours);
    if (!Number.isFinite(hours) || hours <= 0) return fail("Invalid 'hours'");
    since = new Date(Date.now() - hours * 3600_000);
  } else if (rawSince != null && String(rawSince).trim()) {
    since = new Date(String(rawSince));
    if (Number.isNaN(since.getTime())) return fail("Invalid 'since' format");
  } else if (allowDefaultHours) {
    since = new Date(Date.now() - 6 * 3600_000);
  } else {
    return fail("Provide 'hours' or 'since'");
  }

  let until: Date;
  if (rawUntil != null && String(rawUntil).trim()) {
    until = new Date(String(rawUntil));
    if (Number.isNaN(until.getTime())) return fail("Invalid 'until' format");
  } else {
    until = new Date();
  }

  if (until.getTime() < since.getTime()) {
    return fail("'until' must be greater than or equal to 'since'");
  }

  const type = rawType == null || String(rawType).trim() === "" ? undefined : String(rawType).trim();
  const value = rawValue == null || String(rawValue).trim() === "" ? undefined : String(rawValue);

  const limitNumber = rawLimit == null || rawLimit === "" ? 100 : Number(rawLimit);
  if (!Number.isFinite(limitNumber) || limitNumber < 1) return fail("Invalid 'limit'");
  const limit = Math.min(Math.floor(limitNumber), 1000);

  const offsetNumber = rawOffset == null || rawOffset === "" ? 0 : Number(rawOffset);
  if (!Number.isFinite(offsetNumber) || offsetNumber < 0) return fail("Invalid 'offset'");
  const offset = Math.floor(offsetNumber);

  return { since, until, type, value, limit, offset };
}

type EventFilter = {
  since?: Date;
  until?: Date;
  untilExclusive?: boolean;
  type?: string;
  value?: string;
};

/**
 * 拼 WHERE 子句。查询和删除共用，省得两边的类型前缀匹配规则各写一套后跑偏。
 * 没有任何条件时 where 是空串，调用方自己决定这算不算合法。
 */
function buildEventConditions(
  filter: EventFilter,
): { where: string; values: (string | number)[]; nextIndex: number } {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let paramIndex = 1;

  if (filter.since) {
    conditions.push(`ts >= $${paramIndex++}`);
    values.push(filter.since.toISOString());
  }
  if (filter.until) {
    conditions.push(`ts ${filter.untilExclusive ? "<" : "<="} $${paramIndex++}`);
    values.push(filter.until.toISOString());
  }

  if (filter.type) {
    if (filter.type.includes(".")) {
      conditions.push(`type = $${paramIndex++}`);
      values.push(filter.type);
    } else {
      conditions.push(`(type = $${paramIndex} OR type LIKE $${paramIndex + 1})`);
      values.push(filter.type, `${filter.type}.%`);
      paramIndex += 2;
    }
  }

  if (filter.value) {
    conditions.push(`value = $${paramIndex++}`);
    values.push(filter.value);
  }

  return { where: conditions.join(" AND "), values, nextIndex: paramIndex };
}

export async function queryEvents(
  query: EventQuery,
  sql: postgres.Sql,
  offsetMinutes: number,
): Promise<{ events: EventRecord[]; total: number }> {
  const built = buildEventConditions(query);
  const where = built.where;
  const values = built.values;
  const limitIdx = built.nextIndex;
  const offsetIdx = built.nextIndex + 1;
  values.push(query.limit, query.offset);

  const [countResult, rows] = await withRetry(async () => {
    const c = await sql.unsafe(
      `SELECT COUNT(*)::int AS total FROM events WHERE ${where}`,
      values.slice(0, -2),
    );
    const r = await sql.unsafe(
      `SELECT id, type, value, ts FROM events WHERE ${where} ORDER BY ts ASC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      values,
    );
    return [c, r] as const;
  });

  const events = rows.map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    type: String(r.type ?? ""),
    value: r.value == null ? null : String(r.value),
    ts: formatWithOffset(r.ts, offsetMinutes),
  }));

  return {
    events,
    total: Number(countResult[0].total ?? 0),
  };
}

export function buildEventSummaryText(events: EventRecord[], total: number): string {
  if (!events.length) {
    return `Found 0 events. Total matches: ${total}.`;
  }

  const lines = events.map((event) => {
    const time = event.ts ? event.ts.replace("T", " ").slice(0, 16) : "unknown-time";
    const detail = event.value ? ` (value=${event.value})` : "";
    return `- [${time}] ${event.type}${detail}`;
  });

  return [
    `Found ${events.length} event(s). Total matches: ${total}.`,
    ...lines,
  ].join("\n");
}

/**
 * 解析删除条件。时间有三种写法，互斥：
 * - `before_days`：删 N 天前的记录
 * - `date`：删本地某一天（按 TZ_OFFSET 解释）
 * - `since` / `until`：自定义区间
 *
 * 至少要给一个条件（时间、类型或值），一个都不给直接报错，
 * 免得「一句话清空整张表」。出错时返回错误信息字符串。
 */
export function parseDeleteFilter(
  input: Record<string, unknown>,
  offsetMinutes: number,
): DeleteFilter | string {
  const text = (key: string): string | undefined => {
    const raw = input[key];
    if (raw == null) return undefined;
    const trimmed = String(raw).trim();
    return trimmed === "" ? undefined : trimmed;
  };

  const rawBeforeDays = text("before_days");
  const rawDate = text("date");
  const rawSince = text("since");
  const rawUntil = text("until");
  const rawType = text("type");
  const value = input.value == null || String(input.value).trim() === ""
    ? undefined
    : String(input.value);

  if (rawDate && (rawBeforeDays || rawSince || rawUntil)) {
    return "'date' cannot be combined with 'before_days', 'since' or 'until'";
  }
  if (rawBeforeDays && rawUntil) {
    return "'before_days' cannot be combined with 'until': both set the upper time bound";
  }

  let since: Date | undefined;
  let until: Date | undefined;
  let untilExclusive = false;

  if (rawDate) {
    const range = localDayRange(rawDate, offsetMinutes);
    if (!range) return "Invalid 'date': expected an existing calendar day as YYYY-MM-DD";
    since = range.start;
    until = range.end;
    untilExclusive = true;
  }

  if (rawBeforeDays) {
    const days = Number(rawBeforeDays);
    if (!Number.isFinite(days) || days <= 0) return "'before_days' must be a number greater than 0";
    until = new Date(Date.now() - days * 86400_000);
    untilExclusive = true;
  }

  if (rawSince) {
    since = new Date(rawSince);
    if (Number.isNaN(since.getTime())) return "Invalid 'since' format";
  }
  if (rawUntil) {
    until = new Date(rawUntil);
    if (Number.isNaN(until.getTime())) return "Invalid 'until' format";
  }

  if (since && until && until.getTime() < since.getTime()) {
    return "'until' must be greater than or equal to 'since'";
  }

  let type: string | undefined;
  if (rawType) {
    // 类型会被拼进 LIKE 模式，含 % 或 _ 的字符串会悄悄扩大删除范围，直接挡掉
    if (!TYPE_PATTERN.test(rawType)) {
      return "Invalid 'type' format: use dot-separated lowercase alphanumeric (e.g. 'app' or 'app.open')";
    }
    type = rawType;
  }

  if (!since && !until && !type && value === undefined) {
    return "Provide at least one filter: 'before_days', 'date', 'since', 'until', 'type' or 'value'";
  }

  return { since, until, untilExclusive, type, value };
}

/** 把删除条件写成人能读的一行，用在预览和结果文案里 */
export function describeDeleteFilter(filter: DeleteFilter, offsetMinutes: number): string {
  const parts: string[] = [];
  if (filter.since) parts.push(`since=${formatWithOffset(filter.since, offsetMinutes)}`);
  if (filter.until) {
    const bound = filter.untilExclusive ? "until(exclusive)" : "until";
    parts.push(`${bound}=${formatWithOffset(filter.until, offsetMinutes)}`);
  }
  if (filter.type) {
    parts.push(filter.type.includes(".") ? `type=${filter.type}` : `type=${filter.type}(+${filter.type}.*)`);
  }
  if (filter.value) parts.push(`value=${filter.value}`);
  return parts.join(", ");
}

/** 预览：只数命中多少条，不动数据 */
export async function countMatchingEvents(filter: DeleteFilter, sql: postgres.Sql): Promise<number> {
  const { where, values } = buildEventConditions(filter);
  if (!where) throw new Error("Refusing to count events without any filter");

  const rows = await withRetry(() =>
    sql.unsafe(`SELECT COUNT(*)::int AS total FROM events WHERE ${where}`, values)
  );
  return Number((rows[0] as Record<string, unknown> | undefined)?.total ?? 0);
}

/** 真删。空条件在这里再拦一道，任何调用方都别想绕过去清空整张表 */
export async function deleteEvents(filter: DeleteFilter, sql: postgres.Sql): Promise<number> {
  const { where, values } = buildEventConditions(filter);
  if (!where) throw new Error("Refusing to delete events without any filter");

  const result = await withRetry(() => sql.unsafe(`DELETE FROM events WHERE ${where}`, values));
  return Number((result as unknown as { count?: number }).count ?? 0);
}

/** App 使用时长汇总的一行结果 */
export type UsageSummaryRow = {
  value: string;
  totalSeconds: number;
  sessions: number;
};

/** 把别名的名字归一后再合并：微信/WeChat 这类中英文重复会被并成一条 */
function mergeUsageRows(rows: UsageSummaryRow[]): UsageSummaryRow[] {
  const map = new Map<string, UsageSummaryRow>();
  for (const row of rows) {
    const name = normalizeAppName(row.value);
    const existing = map.get(name);
    if (existing) {
      existing.totalSeconds += row.totalSeconds;
      existing.sessions += row.sessions;
    } else {
      map.set(name, { value: name, totalSeconds: row.totalSeconds, sessions: row.sessions });
    }
  }
  return [...map.values()].sort((a, b) => b.totalSeconds - a.totalSeconds);
}

/**
 * 汇总每个 App 在时间窗内的使用时长。
 * 用窗口函数把 app.open 与紧随其后的 app.close 配成一次会话；
 * 重复的 close、落单的 open 会被自然跳过。另返回「当前仍打开」的 App。
 */
export async function computeUsageSummary(
  since: Date,
  until: Date,
  sql: postgres.Sql,
): Promise<{ completed: UsageSummaryRow[]; openNow: UsageSummaryRow[] }> {
  const completedRows = await withRetry(async () => {
    const rows = await sql.unsafe(
      `WITH ordered AS (
         SELECT value, type, ts,
                LEAD(type) OVER (PARTITION BY value ORDER BY ts ASC, id ASC) AS next_type,
                LEAD(ts) OVER (PARTITION BY value ORDER BY ts ASC, id ASC) AS next_ts
         FROM events
         WHERE type IN ('app.open','app.close')
           AND value IS NOT NULL
           AND ts >= $1 AND ts <= $2
       )
       SELECT value,
              SUM(EXTRACT(EPOCH FROM (next_ts - ts)))::int AS total_seconds,
              COUNT(*)::int AS sessions
       FROM ordered
       WHERE type = 'app.open' AND next_type = 'app.close'
       GROUP BY value
       ORDER BY total_seconds DESC`,
      [since.toISOString(), until.toISOString()],
    );
    return rows.map((r: Record<string, unknown>) => ({
      value: String(r.value),
      totalSeconds: Number(r.total_seconds ?? 0),
      sessions: Number(r.sessions ?? 0),
    }));
  });

  const lastRows = await withRetry(async () => {
    const rows = await sql.unsafe(
      `SELECT DISTINCT ON (value) value, type, ts
       FROM events
       WHERE type IN ('app.open','app.close')
         AND value IS NOT NULL
         AND ts <= $1
       ORDER BY value, ts DESC, id DESC`,
      [until.toISOString()],
    );
    return rows.map((r: Record<string, unknown>) => ({
      value: String(r.value),
      type: String(r.type),
      ts: r.ts as string | null,
    }));
  });

  const rawOpenNow: UsageSummaryRow[] = lastRows
    .filter((e) => e.type === "app.open")
    .map((e) => ({
      value: e.value,
      totalSeconds: e.ts
        ? Math.max(0, Math.floor((until.getTime() - new Date(e.ts).getTime()) / 1000))
        : 0,
      sessions: 1,
    }));

  // openNow 用「最近一次打开」取最小值去重，不累加
  const openNowMap = new Map<string, UsageSummaryRow>();
  for (const row of rawOpenNow) {
    const name = normalizeAppName(row.value);
    const existing = openNowMap.get(name);
    if (!existing || row.totalSeconds < existing.totalSeconds) {
      openNowMap.set(name, { value: name, totalSeconds: row.totalSeconds, sessions: 1 });
    }
  }
  const openNow = [...openNowMap.values()].sort((a, b) => b.totalSeconds - a.totalSeconds);

  return { completed: mergeUsageRows(completedRows), openNow };
}
