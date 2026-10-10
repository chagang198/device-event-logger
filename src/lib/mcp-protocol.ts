import type { Context } from "hono";
import type postgres from "postgres";
import type { Env, Vars, JsonRpcId, JsonRpcMessage } from "../types.ts";
import {
  buildEventSummaryText,
  computeUsageSummary,
  countMatchingEvents,
  deleteEvents,
  describeDeleteFilter,
  parseDeleteFilter,
  parseEventQueryFromToolArgs,
  queryEvents,
} from "./queries.ts";
import { withRetry } from "./db.ts";
import { appDailyReport, chargingSummary, lateNightActivity } from "./summaries.ts";
import { formatWithOffset, localDayRange } from "./timezone.ts";

const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
// 新版本排在最前，客户端报了不认识的版本时用它回落
const SUPPORTED_MCP_PROTOCOL_VERSION_LIST = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];
const LATEST_MCP_PROTOCOL_VERSION = SUPPORTED_MCP_PROTOCOL_VERSION_LIST[0];
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set(SUPPORTED_MCP_PROTOCOL_VERSION_LIST);

const MCP_SERVER_INFO = {
  name: "device-event-logger",
  title: "User Device Event Logger",
  version: "1.3.0",
  description: "Query and prune user device event records stored in a database.",
};

const QUERY_EVENTS_TOOL = {
  name: "query_events",
  title: "Query Events",
  description: "Query event records by time range, type, and value.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description: "Look back N hours. Defaults to 6 when since is omitted.",
        minimum: 0.001,
      },
      since: {
        type: "string",
        description: "Start time in ISO 8601 format. Overrides the default hours window.",
      },
      until: {
        type: "string",
        description: "End time in ISO 8601 format. Defaults to now.",
      },
      type: {
        type: "string",
        description:
          "Event type filter (dot-separated lowercase alphanumeric, e.g. 'app.open'). Prefix match when no dot is present; exact match otherwise. Use the list_event_types tool to discover available types.",
      },
      value: {
        type: "string",
        description: "Exact value filter.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of events to return. Default 100, max 1000.",
        minimum: 1,
        maximum: 1000,
      },
      offset: {
        type: "integer",
        description: "Pagination offset. Default 0.",
        minimum: 0,
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      total: { type: "integer" },
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "integer" },
            type: { type: "string" },
            value: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            ts: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
          },
          required: ["id", "type", "value", "ts"],
        },
      },
    },
    required: ["total", "events"],
  },
};

const LIST_EVENT_TYPES_TOOL = {
  name: "list_event_types",
  title: "List Event Types",
  description:
    "List all distinct event types currently stored in the database. Use this to discover available types before querying events.",
  // properties 必须留至少一个字段：Gemini 会拒收 properties 为空的 object 参数，
  // 整轮对话都会 400，工具再也调不动
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description:
          "Only list types seen in the last N hours. Omit to list every type ever recorded.",
        minimum: 0.001,
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      types: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["types"],
  },
};

const DELETE_EVENTS_TOOL = {
  name: "delete_events",
  title: "Delete Events",
  description:
    "Permanently delete event records matching a time range, an event type and/or a value. " +
    "Destructive and irreversible. Runs as a preview by default: without confirm=true it only reports " +
    "how many records would be deleted. At least one filter is required.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      before_days: {
        type: "number",
        description:
          "Delete records older than N days, counted from now. Cannot be combined with 'date' or 'until'.",
        minimum: 0.001,
      },
      date: {
        type: "string",
        description:
          "Delete one local calendar day, written as YYYY-MM-DD and read in the server's configured timezone. Cannot be combined with 'before_days', 'since' or 'until'.",
      },
      since: {
        type: "string",
        description: "Start of the range to delete, ISO 8601. Inclusive.",
      },
      until: {
        type: "string",
        description: "End of the range to delete, ISO 8601. Inclusive.",
      },
      type: {
        type: "string",
        description:
          "Event type filter (dot-separated lowercase alphanumeric). A type without a dot also matches its children, so 'app' covers 'app.open' and every other 'app.*'; 'app.open' matches that one type only. Use list_event_types to discover available types.",
      },
      value: {
        type: "string",
        description: "Exact value filter, e.g. one specific app name.",
      },
      confirm: {
        type: "boolean",
        description:
          "Must be true to actually delete. Omit it (or pass false) to preview how many records match first.",
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      confirmed: { type: "boolean" },
      matched: { type: "integer" },
      deleted: { type: "integer" },
      filter: { type: "string" },
    },
    required: ["confirmed", "matched", "deleted", "filter"],
  },
};

const USAGE_SUMMARY_TOOL = {
  name: "usage_summary",
  title: "App Usage Summary",
  description:
    "Summarize how long each app has been used in a time window by pairing app.open and app.close events. Returns completed sessions (total duration and session count per app) and apps that are currently still open.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description: "Look back N hours. Defaults to 24 when since is omitted.",
        minimum: 0.001,
      },
      since: {
        type: "string",
        description: "Start time in ISO 8601 format. Overrides the default hours window.",
      },
      until: {
        type: "string",
        description: "End time in ISO 8601 format. Defaults to now.",
      },
      value: {
        type: "string",
        description: "Only summarize this specific app value (e.g. '抖音').",
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      window: {
        type: "object",
        additionalProperties: false,
        properties: {
          since: { type: "string" },
          until: { type: "string" },
        },
        required: ["since", "until"],
      },
      completed: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: { type: "string" },
            total_seconds: { type: "integer" },
            sessions: { type: "integer" },
          },
          required: ["value", "total_seconds", "sessions"],
        },
      },
      open_now: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: { type: "string" },
            open_seconds: { type: "integer" },
          },
          required: ["value", "open_seconds"],
        },
      },
    },
    required: ["window", "completed", "open_now"],
  },
};

const CHARGING_SUMMARY_TOOL = {
  name: "charging_summary",
  title: "Charging Summary",
  description:
    "Summarize charging sessions by pairing charger.connect and charger.disconnect events in a time window. " +
    "Returns the number of charging sessions, total charging minutes, and whether the device is charging right now.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description: "Look back N hours. Defaults to 24 when omitted.",
        minimum: 0.001,
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      chargingNow: { type: "boolean" },
      sessionCount: { type: "integer" },
      totalMinutes: { type: "integer" },
      sessions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            start: { type: "string" },
            end: { anyOf: [{ type: "string" }, { type: "null" }] },
            durationMinutes: { anyOf: [{ type: "integer" }, { type: "null" }] },
          },
          required: ["start", "end", "durationMinutes"],
        },
      },
    },
    required: ["chargingNow", "sessionCount", "totalMinutes", "sessions"],
  },
};

const APP_DAILY_REPORT_TOOL = {
  name: "app_daily_report",
  title: "App Daily Report",
  description:
    "Report per-app open counts and first/last open times for one local calendar day, based on app.open events. " +
    "Open counts are more reliable than durations because app.close events are often missing or unnamed.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: {
        type: "string",
        description:
          "Local calendar day as YYYY-MM-DD, read in the server's configured timezone. Defaults to today.",
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: { type: "string" },
      apps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            app: { type: "string" },
            opens: { type: "integer" },
            firstOpen: { anyOf: [{ type: "string" }, { type: "null" }] },
            lastOpen: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["app", "opens", "firstOpen", "lastOpen"],
        },
      },
    },
    required: ["date", "apps"],
  },
};

const LATE_NIGHT_ACTIVITY_TOOL = {
  name: "late_night_activity",
  title: "Late Night Activity",
  description:
    "List app.open events during a local night window to detect how late the device was still in use. " +
    "The window spans from startHour on the given day until 06:00 the next day.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: {
        type: "string",
        description:
          "Local calendar day as YYYY-MM-DD. Defaults to today.",
      },
      startHour: {
        type: "integer",
        description: "Local hour (0-23) that the night window starts. Defaults to 23.",
        minimum: 0,
        maximum: 23,
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            ts: { anyOf: [{ type: "string" }, { type: "null" }] },
            app: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["ts", "app"],
        },
      },
    },
    required: ["events"],
  },
};

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function isJsonRpcRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && Object.prototype.hasOwnProperty.call(message, "id");
}

function isJsonRpcNotification(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && !Object.prototype.hasOwnProperty.call(message, "id");
}

function isJsonRpcResponse(message: JsonRpcMessage): boolean {
  return Object.prototype.hasOwnProperty.call(message, "result") ||
    Object.prototype.hasOwnProperty.call(message, "error");
}

/** 响应头里回显的协议版本：没带头按规范默认，带了不认识的版本就报自己支持的最新版 */
function resolveResponseProtocolVersion(header?: string): string {
  if (!header) return DEFAULT_MCP_PROTOCOL_VERSION;
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.has(header) ? header : LATEST_MCP_PROTOCOL_VERSION;
}

/** 握手请求（可能被包在批量里）在版本协商完成前不该因为版本头被拒 */
function containsInitialize(body: unknown): boolean {
  const isInitialize = (item: unknown) =>
    !!item && typeof item === "object" &&
    (item as JsonRpcMessage).method === "initialize";
  return Array.isArray(body) ? body.some(isInitialize) : isInitialize(body);
}

async function callQueryEventsTool(args: Record<string, unknown>, sql: postgres.Sql, offsetMinutes: number) {
  const parsed = parseEventQueryFromToolArgs(args);
  if (typeof parsed === "string") {
    return { content: [{ type: "text", text: parsed }], isError: true };
  }
  try {
    const result = await queryEvents(parsed, sql, offsetMinutes);
    return {
      content: [{ type: "text", text: buildEventSummaryText(result.events, result.total) }],
      structuredContent: result,
      isError: false,
    };
  } catch (error) {
    console.error("MCP query_events failed:", error);
    return { content: [{ type: "text", text: "Database error while querying events." }], isError: true };
  }
}

async function callListEventTypesTool(args: Record<string, unknown>, sql: postgres.Sql) {
  const rawHours = args.hours;
  let since: string | null = null;
  if (rawHours != null && rawHours !== "") {
    const hours = Number(rawHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { content: [{ type: "text", text: "Invalid 'hours'" }], isError: true };
    }
    since = new Date(Date.now() - hours * 3600_000).toISOString();
  }

  try {
    const rows = await withRetry(() =>
      since
        ? sql.unsafe("SELECT DISTINCT type FROM events WHERE ts >= $1 ORDER BY type", [since])
        : sql.unsafe("SELECT DISTINCT type FROM events ORDER BY type")
    );
    const types = rows.map((r: Record<string, unknown>) => String(r.type));
    return {
      content: [{ type: "text", text: types.length ? types.join("\n") : "No event types found." }],
      structuredContent: { types },
      isError: false,
    };
  } catch (error) {
    console.error("MCP list_event_types failed:", error);
    return { content: [{ type: "text", text: "Database error while listing event types." }], isError: true };
  }
}

async function callDeleteEventsTool(
  args: Record<string, unknown>,
  sql: postgres.Sql,
  offsetMinutes: number,
) {
  const filter = parseDeleteFilter(args, offsetMinutes);
  if (typeof filter === "string") {
    return { content: [{ type: "text", text: filter }], isError: true };
  }

  const description = describeDeleteFilter(filter, offsetMinutes);
  const confirmed = args.confirm === true || args.confirm === "true";

  try {
    if (!confirmed) {
      const matched = await countMatchingEvents(filter, sql);
      return {
        content: [{
          type: "text",
          text:
            `Preview only, nothing was deleted. ${matched} event(s) match ${description}. ` +
            `Call delete_events again with the same filters plus confirm=true to delete them.`,
        }],
        structuredContent: { confirmed: false, matched, deleted: 0, filter: description },
        isError: false,
      };
    }

    const deleted = await deleteEvents(filter, sql);
    return {
      content: [{ type: "text", text: `Deleted ${deleted} event(s) matching ${description}.` }],
      structuredContent: { confirmed: true, matched: deleted, deleted, filter: description },
      isError: false,
    };
  } catch (error) {
    console.error("MCP delete_events failed:", error);
    return {
      content: [{ type: "text", text: "Database error while deleting events." }],
      isError: true,
    };
  }
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

async function callUsageSummaryTool(
  args: Record<string, unknown>,
  sql: postgres.Sql,
) {
  const rawHours = args.hours;
  const rawSince = args.since;
  const rawUntil = args.until;
  const rawValue = args.value;

  let since: Date;
  if (rawHours != null && rawHours !== "") {
    const hours = Number(rawHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { content: [{ type: "text", text: "Invalid 'hours'" }], isError: true };
    }
    since = new Date(Date.now() - hours * 3600_000);
  } else if (rawSince != null && String(rawSince).trim()) {
    since = new Date(String(rawSince));
    if (Number.isNaN(since.getTime())) {
      return { content: [{ type: "text", text: "Invalid 'since' format" }], isError: true };
    }
  } else {
    since = new Date(Date.now() - 24 * 3600_000);
  }

  let until: Date;
  if (rawUntil != null && String(rawUntil).trim()) {
    until = new Date(String(rawUntil));
    if (Number.isNaN(until.getTime())) {
      return { content: [{ type: "text", text: "Invalid 'until' format" }], isError: true };
    }
  } else {
    until = new Date();
  }

  if (until.getTime() < since.getTime()) {
    return {
      content: [{ type: "text", text: "'until' must be greater than or equal to 'since'" }],
      isError: true,
    };
  }

  const value = rawValue == null || String(rawValue).trim() === "" ? undefined : String(rawValue);

  try {
    const { completed, openNow } = await computeUsageSummary(since, until, sql);

    const filteredCompleted = value ? completed.filter((row) => row.value === value) : completed;
    const filteredOpenNow = value ? openNow.filter((row) => row.value === value) : openNow;

    const lines: string[] = [];
    if (filteredCompleted.length) {
      lines.push("已完成会话（App 使用时长）：");
      for (const row of filteredCompleted) {
        lines.push(`- ${row.value}: ${formatDuration(row.totalSeconds)}（${row.sessions}次）`);
      }
    } else {
      lines.push("该时间窗内没有已完成的 App 会话。");
    }

    if (filteredOpenNow.length) {
      lines.push("", "正在打开：");
      for (const row of filteredOpenNow) {
        lines.push(`- ${row.value}: 已打开 ${formatDuration(row.totalSeconds)}`);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        window: { since: since.toISOString(), until: until.toISOString() },
        completed: filteredCompleted.map((r) => ({
          value: r.value,
          total_seconds: r.totalSeconds,
          sessions: r.sessions,
        })),
        open_now: filteredOpenNow.map((r) => ({
          value: r.value,
          open_seconds: r.totalSeconds,
        })),
      },
      isError: false,
    };
  } catch (error) {
    console.error("MCP usage_summary failed:", error);
    return {
      content: [{ type: "text", text: "Database error while summarizing usage." }],
      isError: true,
    };
  }
}

async function callChargingSummaryTool(
  args: Record<string, unknown>,
  sql: postgres.Sql,
  offsetMinutes: number,
) {
  const rawHours = args.hours;
  let hours = 24;
  if (rawHours != null && rawHours !== "") {
    hours = Number(rawHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { content: [{ type: "text", text: "Invalid 'hours'" }], isError: true };
    }
  }

  const since = new Date(Date.now() - hours * 3600_000);
  try {
    const result = await chargingSummary(sql, since, offsetMinutes);
    const lines = [
      `正在充电：${result.chargingNow ? "是" : "否"}`,
      `充电次数：${result.sessionCount}`,
      `累计充电：${result.totalMinutes} 分钟`,
    ];
    for (const s of result.sessions) {
      if (s.end === null) {
        lines.push(`- ${s.start} 起（还在充）`);
      } else {
        lines.push(`- ${s.start} → ${s.end}（${s.durationMinutes} 分钟）`);
      }
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: result,
      isError: false,
    };
  } catch (error) {
    console.error("MCP charging_summary failed:", error);
    return { content: [{ type: "text", text: "Database error while summarizing charging." }], isError: true };
  }
}

async function callAppDailyReportTool(
  args: Record<string, unknown>,
  sql: postgres.Sql,
  offsetMinutes: number,
) {
  const rawDate = typeof args.date === "string" && args.date.trim() ? args.date.trim() : undefined;
  const todayStr = (formatWithOffset(new Date(), offsetMinutes) ?? "").slice(0, 10);
  const dateStr = rawDate ?? todayStr;
  const range = localDayRange(dateStr, offsetMinutes);
  if (!range) {
    return {
      content: [{ type: "text", text: "Invalid 'date': expected an existing calendar day as YYYY-MM-DD" }],
      isError: true,
    };
  }

  try {
    const apps = await appDailyReport(sql, range.start, range.end, offsetMinutes);
    const lines = apps.length
      ? apps.map((a) => `- ${a.app}: ${a.opens} 次（${a.firstOpen} ~ ${a.lastOpen}）`)
      : ["那天没有 app.open 记录。"];
    return {
      content: [{ type: "text", text: [`${dateStr} 的 App 打开统计：`, ...lines].join("\n") }],
      structuredContent: { date: dateStr, apps },
      isError: false,
    };
  } catch (error) {
    console.error("MCP app_daily_report failed:", error);
    return { content: [{ type: "text", text: "Database error while building the app daily report." }], isError: true };
  }
}

async function callLateNightActivityTool(
  args: Record<string, unknown>,
  sql: postgres.Sql,
  offsetMinutes: number,
) {
  const rawDate = typeof args.date === "string" && args.date.trim() ? args.date.trim() : undefined;
  const todayStr = (formatWithOffset(new Date(), offsetMinutes) ?? "").slice(0, 10);
  const dateStr = rawDate ?? todayStr;
  const range = localDayRange(dateStr, offsetMinutes);
  if (!range) {
    return {
      content: [{ type: "text", text: "Invalid 'date': expected an existing calendar day as YYYY-MM-DD" }],
      isError: true,
    };
  }

  let startHour = 23;
  const rawStartHour = args.startHour;
  if (rawStartHour != null && rawStartHour !== "") {
    startHour = Number(rawStartHour);
    if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
      return {
        content: [{ type: "text", text: "Invalid 'startHour': must be an integer between 0 and 23" }],
        isError: true,
      };
    }
  }

  const start = new Date(range.start.getTime() + startHour * 3600_000);
  const end = new Date(range.start.getTime() + 30 * 3600_000);

  try {
    const events = await lateNightActivity(sql, start, end, offsetMinutes);
    const lines = events.length
      ? events.map((e) => `- [${e.ts}] ${e.app ?? "(unnamed)"}`)
      : ["那个深夜窗口没有 app.open 记录。"];
    return {
      content: [{ type: "text", text: [`${dateStr} ${startHour}:00 起的深夜活动：`, ...lines].join("\n") }],
      structuredContent: { events },
      isError: false,
    };
  } catch (error) {
    console.error("MCP late_night_activity failed:", error);
    return { content: [{ type: "text", text: "Database error while listing late night activity." }], isError: true };
  }
}

async function handleMcpRequest(message: JsonRpcMessage, sql: postgres.Sql, offsetMinutes: number) {
  const id = (message.id ?? null) as JsonRpcId;
  const method = typeof message.method === "string" ? message.method : "";
  const params = (message.params && typeof message.params === "object")
    ? message.params as Record<string, unknown>
    : {};

  switch (method) {
    case "initialize": {
      const requestedVersion = typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : "";
      // 客户端报了不认识的版本就回落到自己支持的最新版，由客户端决定接不接受。
      // 直接返回错误会让升级了协议版本的客户端彻底连不上。
      const negotiatedVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : LATEST_MCP_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          "This server exposes user device event records. Use list_event_types to discover available event types, then use query_events to read records by time range, type, and value. " +
          "use usage_summary to see how long each app has been used. " +
          "charging_summary pairs charger.connect/charger.disconnect into charging sessions; app_daily_report and late_night_activity summarize app.open activity by local day. " +
          "delete_events removes records permanently: always run it once without confirm to preview the match count, show that count to the user, and only re-run it with confirm=true after they agree.",
      });
    }
    case "notifications/initialized":
      return null;
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, {
        tools: [
          QUERY_EVENTS_TOOL,
          LIST_EVENT_TYPES_TOOL,
          DELETE_EVENTS_TOOL,
          USAGE_SUMMARY_TOOL,
          CHARGING_SUMMARY_TOOL,
          APP_DAILY_REPORT_TOOL,
          LATE_NIGHT_ACTIVITY_TOOL,
        ],
      });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object")
        ? params.arguments as Record<string, unknown>
        : {};
      if (name === LIST_EVENT_TYPES_TOOL.name) {
        return jsonRpcResult(id, await callListEventTypesTool(args, sql));
      }
      if (name === DELETE_EVENTS_TOOL.name) {
        return jsonRpcResult(id, await callDeleteEventsTool(args, sql, offsetMinutes));
      }
      if (name === USAGE_SUMMARY_TOOL.name) {
        return jsonRpcResult(id, await callUsageSummaryTool(args, sql));
      }
      if (name === CHARGING_SUMMARY_TOOL.name) {
        return jsonRpcResult(id, await callChargingSummaryTool(args, sql, offsetMinutes));
      }
      if (name === APP_DAILY_REPORT_TOOL.name) {
        return jsonRpcResult(id, await callAppDailyReportTool(args, sql, offsetMinutes));
      }
      if (name === LATE_NIGHT_ACTIVITY_TOOL.name) {
        return jsonRpcResult(id, await callLateNightActivityTool(args, sql, offsetMinutes));
      }
      if (name !== QUERY_EVENTS_TOOL.name) {
        return jsonRpcError(id, -32601, `Unknown tool: ${name || "(empty)"}`);
      }
      return jsonRpcResult(id, await callQueryEventsTool(args, sql, offsetMinutes));
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method || "(empty)"}`);
  }
}

export async function handleMcpPost(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const sql = c.var.sql;
  const offsetMinutes = c.var.offsetMinutes;

  const version = c.req.header("mcp-protocol-version")?.trim();
  const protocolVersion = resolveResponseProtocolVersion(version);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  // Validate protocol version header —— 握手请求除外，那会儿版本还没协商完
  if (version && !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version) && !containsInitialize(body)) {
    return c.json({ error: `Unsupported MCP protocol version: ${version}` }, 400);
  }

  // Batch handling — array of JSON-RPC messages
  if (Array.isArray(body)) {
    if (!body.length) {
      c.header("MCP-Protocol-Version", protocolVersion);
      return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
    }
    const responses: unknown[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") {
        responses.push(jsonRpcError(null, -32600, "Invalid Request"));
        continue;
      }
      const message = item as JsonRpcMessage;
      if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) continue;
      if (!isJsonRpcRequest(message)) {
        responses.push(jsonRpcError(null, -32600, "Invalid Request"));
        continue;
      }
      responses.push(await handleMcpRequest(message, sql, offsetMinutes));
    }
    if (!responses.length) {
      return c.body(null, 202);
    }
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(responses);
  }

  // Single message handling
  if (!body || typeof body !== "object") {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }
  const message = body as JsonRpcMessage;
  if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) {
    return c.body(null, 202);
  }
  if (!isJsonRpcRequest(message)) {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }
  const response = await handleMcpRequest(message, sql, offsetMinutes);
  if (response == null) {
    return c.body(null, 202);
  }
  c.header("MCP-Protocol-Version", protocolVersion);
  return c.json(response);
}
