import { isFullDatabase } from "@notionhq/client";
import { z } from "zod";
import { getClient } from "../services/notion.js";
import { WHERE_SCHEMA, compileWhere } from "../schema/filter-dsl.js";
import { flattenProperty } from "../utils/slim.js";
import { asSdk, type QueryDataSourceBody } from "../utils/notion-types.js";
import { tryHandler } from "../utils/handler.js";
import { register } from "./registry.js";
import type { OperationResult } from "./types.js";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;
const DEFAULT_MAX_PAGES = 1;
const MAX_MAX_PAGES = 1_000;
const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 50;

const SelectSchema = z.array(z.string().min(1)).min(1).optional();

const BaseScanParams = z
  .object({
    database_id: z.string().optional(),
    data_source_id: z.string().optional(),
    where: WHERE_SCHEMA.optional(),
    filter: z.unknown().optional(),
    sorts: z.array(z.unknown()).optional(),
    start_cursor: z.string().optional(),
    page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    max_pages: z.number().int().min(1).max(MAX_MAX_PAGES).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.database_id) !== Boolean(v.data_source_id), {
    message: "Pass exactly one of `database_id` or `data_source_id`.",
  })
  .refine((v) => !(v.where !== undefined && v.filter !== undefined), {
    message: "Pass either `where` (typed DSL) or `filter` (raw Notion JSON), not both.",
  });

const QueryDatabaseTableParams = BaseScanParams.extend({
  select: SelectSchema,
}).strict();

const InspectDatabaseCompactParams = z
  .object({
    database_id: z.string().optional(),
    data_source_id: z.string().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.database_id) !== Boolean(v.data_source_id), {
    message: "Pass exactly one of `database_id` or `data_source_id`.",
  });

const AggregateDatabaseTableParams = BaseScanParams.extend({
  group_by: z.array(z.string().min(1)).min(1).optional(),
}).strict();

const SummarizeDatabaseTableParams = BaseScanParams.extend({
  select: SelectSchema,
  top_limit: z.number().int().min(1).max(MAX_TOP_LIMIT).optional(),
}).strict();

const ListDatabaseRowRefsParams = BaseScanParams.extend({
  select: SelectSchema,
}).strict();

const MatchDatabaseRowsParams = BaseScanParams.extend({
  query: z.string().min(1),
  properties: z.array(z.string().min(1)).min(1).optional(),
  select: SelectSchema,
}).strict();

type ScanParams = z.infer<typeof BaseScanParams>;
type TableParams = z.infer<typeof QueryDatabaseTableParams>;
type InspectParams = z.infer<typeof InspectDatabaseCompactParams>;
type AggregateParams = z.infer<typeof AggregateDatabaseTableParams>;
type SummaryParams = z.infer<typeof SummarizeDatabaseTableParams>;
type RowRefsParams = z.infer<typeof ListDatabaseRowRefsParams>;
type MatchRowsParams = z.infer<typeof MatchDatabaseRowsParams>;

type PageLike = {
  object?: string;
  id?: string;
  url?: string;
  properties?: Record<string, unknown>;
};

type QueryResponse = {
  results: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type ScanMeta = {
  api_calls: number;
  elapsed_ms: number;
  rows_scanned: number;
  has_more: boolean;
  next_cursor: string | null;
  truncated: boolean;
};

type ScanResult = {
  rows: PageLike[];
  meta: ScanMeta;
};

type ScanDefaults = {
  limit?: number;
  max_pages?: number;
};

async function resolveDataSourceId(params: Pick<ScanParams, "database_id" | "data_source_id">) {
  if (params.data_source_id) return { ok: true as const, data_source_id: params.data_source_id };

  const notion = await getClient();
  const db = await notion.databases.retrieve({ database_id: params.database_id! });
  const sources = isFullDatabase(db) ? db.data_sources : [];
  if (sources.length === 0) {
    return {
      ok: false as const,
      error: {
        code: "no_data_source",
        message: `Database ${params.database_id} has no data sources.`,
        fix: "Pass data_source_id directly, or check the database in Notion.",
      },
    };
  }
  if (sources.length > 1) {
    return {
      ok: false as const,
      error: {
        code: "multi_source_database",
        message: `Database ${params.database_id} has ${sources.length} data sources. Pass data_source_id explicitly.`,
        fix: `Call list_data_sources first, then pass data_source_id. Available IDs: ${sources.map((s) => s.id).join(", ")}.`,
      },
    };
  }
  return { ok: true as const, data_source_id: sources[0].id };
}

function compileScanFilter(params: Pick<ScanParams, "where" | "filter">) {
  if (params.where !== undefined) return compileWhere(params.where);
  return params.filter;
}

async function scanRows(
  params: ScanParams,
  defaults: ScanDefaults = {}
): Promise<OperationResult<ScanResult>> {
  const resolved = await resolveDataSourceId(params);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  let compiledFilter: unknown;
  try {
    compiledFilter = compileScanFilter(params);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "where_compile_error",
        message: err instanceof Error ? err.message : String(err),
        fix: "Check your `where` clause shape. Pass `__type` on the property to force a property type, or fall back to raw `filter`.",
      },
    };
  }

  const notion = await getClient();
  const started = Date.now();
  const rows: PageLike[] = [];
  const limit = params.limit ?? defaults.limit;
  const maxPages = params.max_pages ?? defaults.max_pages;
  const pageSize = params.page_size ?? DEFAULT_PAGE_SIZE;
  let cursor = params.start_cursor;
  let apiCalls = 0;
  let hasMore = false;
  let nextCursor: string | null = null;

  while (
    (limit === undefined || rows.length < limit) &&
    (maxPages === undefined || apiCalls < maxPages)
  ) {
    const remaining = limit === undefined ? pageSize : limit - rows.length;
    const response = (await notion.dataSources.query(
      asSdk<QueryDataSourceBody>({
        data_source_id: resolved.data_source_id,
        ...(compiledFilter !== undefined ? { filter: compiledFilter } : {}),
        ...(params.sorts !== undefined ? { sorts: params.sorts } : {}),
        ...(cursor !== undefined ? { start_cursor: cursor } : {}),
        page_size: Math.min(pageSize, remaining),
      })
    )) as QueryResponse;

    apiCalls += 1;
    for (const item of response.results) {
      if (limit !== undefined && rows.length >= limit) break;
      if (isPageLike(item)) rows.push(item);
    }
    hasMore = Boolean(response.has_more && response.next_cursor);
    nextCursor = response.next_cursor ?? null;
    if (!hasMore || (limit !== undefined && rows.length >= limit)) break;
    cursor = response.next_cursor ?? undefined;
  }

  return {
    ok: true,
    data: {
      rows,
      meta: {
        api_calls: apiCalls,
        elapsed_ms: Date.now() - started,
        rows_scanned: rows.length,
        has_more: hasMore,
        next_cursor: nextCursor,
        truncated:
          hasMore &&
          ((limit !== undefined && rows.length >= limit) ||
            (maxPages !== undefined && apiCalls >= maxPages)),
      },
    },
  };
}

function isPageLike(value: unknown): value is PageLike {
  return typeof value === "object" && value !== null && (value as PageLike).object === "page";
}

function pageTitle(page: PageLike): string | undefined {
  const properties = page.properties ?? {};
  for (const prop of Object.values(properties)) {
    if (propertyType(prop) === "title") {
      const title = flattenProperty(prop as Parameters<typeof flattenProperty>[0]);
      return typeof title === "string" && title ? title : undefined;
    }
  }
  return undefined;
}

function propertyType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function propertyNames(page: PageLike, select?: string[]): string[] {
  if (select) return select;
  return Object.keys(page.properties ?? {});
}

function projectProperties(page: PageLike, select?: string[]): Record<string, unknown> {
  const properties = page.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const name of propertyNames(page, select)) {
    const prop = properties[name];
    if (prop === undefined) continue;
    const flat = flattenProperty(prop as Parameters<typeof flattenProperty>[0]);
    if (flat !== undefined) out[name] = flat;
  }
  return out;
}

function tableRow(page: PageLike, select?: string[]) {
  return {
    page_id: page.id,
    ...(page.url ? { page_url: page.url } : {}),
    properties: projectProperties(page, select),
  };
}

function valueKey(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function valueLabel(value: unknown): string {
  if (value === undefined || value === null) return "(empty)";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function groupValue(page: PageLike, name: string): unknown {
  const prop = page.properties?.[name];
  if (prop === undefined) return null;
  return flattenProperty(prop as Parameters<typeof flattenProperty>[0]) ?? null;
}

function compactTitle(value: unknown): string | undefined {
  const rawTitle = (value as { title?: unknown })?.title;
  if (!Array.isArray(rawTitle)) return undefined;
  const text = rawTitle
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const plain = (part as { plain_text?: unknown }).plain_text;
      return typeof plain === "string" ? plain : "";
    })
    .join("");
  return text || undefined;
}

function compactOptions(config: Record<string, unknown>) {
  const typed = config[config.type as string];
  if (typeof typed !== "object" || typed === null) return undefined;
  const options = (typed as { options?: unknown }).options;
  if (!Array.isArray(options)) return undefined;
  return options.map((option) => {
    const item = option as { id?: unknown; name?: unknown; color?: unknown };
    return {
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.color === "string" ? { color: item.color } : {}),
    };
  });
}

function compactPropertySchema(properties: Record<string, unknown>) {
  return Object.entries(properties).map(([name, value]) => {
    const config = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const type = typeof config.type === "string" ? config.type : "unknown";
    const options = compactOptions(config);
    return {
      name,
      ...(typeof config.id === "string" ? { id: config.id } : {}),
      type,
      ...(options ? { options } : {}),
    };
  });
}

function rowRef(page: PageLike, select?: string[]) {
  const title = pageTitle(page);
  return {
    page_id: page.id,
    ...(page.url ? { page_url: page.url } : {}),
    ...(title ? { title } : {}),
    ...(select ? { properties: projectProperties(page, select) } : {}),
  };
}

function searchableValues(page: PageLike, properties?: string[]): unknown[] {
  const names = properties ?? Object.keys(page.properties ?? {});
  return names.map((name) => {
    const prop = page.properties?.[name];
    return prop === undefined ? undefined : flattenProperty(prop as Parameters<typeof flattenProperty>[0]);
  });
}

function matchesTextQuery(page: PageLike, query: string, properties?: string[]): boolean {
  const needle = query.toLowerCase();
  const values = [pageTitle(page), ...searchableValues(page, properties)];
  return values.some((value) => {
    if (value === undefined || value === null) return false;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.toLowerCase().includes(needle);
  });
}

register({
  name: "inspect_database_compact",
  access: "read",
  domain: "data_sources",
  description: "Inspect a database data source schema in a compact, token-efficient shape.",
  batchable: false,
  schema: InspectDatabaseCompactParams,
  example: {
    data_source_id: "<data-source-id>",
  },
  handler: tryHandler(async (params: InspectParams): Promise<OperationResult<unknown>> => {
    const resolved = await resolveDataSourceId(params);
    if (!resolved.ok) return resolved;
    const notion = await getClient();
    const ds = await notion.dataSources.retrieve({ data_source_id: resolved.data_source_id });
    const record = typeof ds === "object" && ds !== null ? (ds as Record<string, unknown>) : {};
    const rawProperties = record.properties;
    const properties =
      typeof rawProperties === "object" && rawProperties !== null
        ? compactPropertySchema(rawProperties as Record<string, unknown>)
        : [];
    return {
      ok: true,
      data: {
        data_source_id: resolved.data_source_id,
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(compactTitle(record) ? { title: compactTitle(record) } : {}),
        property_count: properties.length,
        properties,
      },
    };
  }),
});

register({
  name: "query_database_table",
  access: "read",
  domain: "databases",
  description: "Read a database data source as projected table rows with filter, sort, pagination, and measurement metadata.",
  batchable: false,
  schema: QueryDatabaseTableParams,
  example: {
    data_source_id: "<data-source-id>",
    where: { Status: "Done" },
    select: ["Name", "Status"],
    limit: 50,
  },
  handler: tryHandler(async (params: TableParams): Promise<OperationResult<unknown>> => {
    const scanned = await scanRows(params, { limit: DEFAULT_LIMIT, max_pages: DEFAULT_MAX_PAGES });
    if (!scanned.ok) return scanned;
    const { rows, meta } = scanned.data;
    return {
      ok: true,
      data: {
        results: rows.map((row) => tableRow(row, params.select)),
        has_more: meta.has_more,
        next_cursor: meta.next_cursor,
        truncated: meta.truncated,
        metadata: {
          api_calls: meta.api_calls,
          elapsed_ms: meta.elapsed_ms,
          rows_scanned: meta.rows_scanned,
        },
      },
    };
  }),
});

register({
  name: "aggregate_database_table",
  access: "read",
  domain: "databases",
  description: "Count database rows, optionally grouped by one or more properties, without returning row payloads.",
  batchable: false,
  schema: AggregateDatabaseTableParams,
  example: {
    data_source_id: "<data-source-id>",
    where: { Status: "Done" },
  },
  handler: tryHandler(async (params: AggregateParams): Promise<OperationResult<unknown>> => {
    const scanned = await scanRows(params);
    if (!scanned.ok) return scanned;
    const { rows, meta } = scanned.data;
    if (!params.group_by) {
      return {
        ok: true,
        data: {
          count: rows.length,
          has_more: meta.has_more,
          next_cursor: meta.next_cursor,
          truncated: meta.truncated,
          metadata: {
            api_calls: meta.api_calls,
            elapsed_ms: meta.elapsed_ms,
            rows_scanned: meta.rows_scanned,
          },
        },
      };
    }

    const groups = new Map<string, { group: Record<string, unknown>; count: number }>();
    for (const row of rows) {
      const group = Object.fromEntries(params.group_by.map((name) => [name, groupValue(row, name)]));
      const key = JSON.stringify(group);
      const existing = groups.get(key);
      if (existing) existing.count += 1;
      else groups.set(key, { group, count: 1 });
    }
    return {
      ok: true,
      data: {
        groups: [...groups.values()].sort((a, b) => b.count - a.count),
        has_more: meta.has_more,
        next_cursor: meta.next_cursor,
        truncated: meta.truncated,
        metadata: {
          api_calls: meta.api_calls,
          elapsed_ms: meta.elapsed_ms,
          rows_scanned: meta.rows_scanned,
        },
      },
    };
  }),
});

register({
  name: "summarize_database_table",
  access: "read",
  domain: "databases",
  description: "Summarize selected or all database properties with present/empty counts and top values, without returning full rows.",
  batchable: false,
  schema: SummarizeDatabaseTableParams,
  example: {
    data_source_id: "<data-source-id>",
    select: ["Status", "Owner"],
    top_limit: 5,
  },
  handler: tryHandler(async (params: SummaryParams): Promise<OperationResult<unknown>> => {
    const scanned = await scanRows(params);
    if (!scanned.ok) return scanned;
    const { rows, meta } = scanned.data;
    const names = params.select ?? [...new Set(rows.flatMap((row) => Object.keys(row.properties ?? {})))];
    const topLimit = params.top_limit ?? DEFAULT_TOP_LIMIT;
    const summaries: Record<string, unknown> = {};

    for (const name of names) {
      let present = 0;
      let empty = 0;
      const counts = new Map<string, { value: unknown; count: number; label: string }>();
      for (const row of rows) {
        const prop = row.properties?.[name];
        const value = prop === undefined ? undefined : flattenProperty(prop as Parameters<typeof flattenProperty>[0]);
        if (value === undefined || (Array.isArray(value) && value.length === 0)) {
          empty += 1;
          continue;
        }
        present += 1;
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          const key = valueKey(item);
          const existing = counts.get(key);
          if (existing) existing.count += 1;
          else counts.set(key, { value: item, label: valueLabel(item), count: 1 });
        }
      }
      summaries[name] = {
        present,
        empty,
        top_values: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, topLimit),
      };
    }

    return {
      ok: true,
      data: {
        properties: summaries,
        has_more: meta.has_more,
        next_cursor: meta.next_cursor,
        truncated: meta.truncated,
        metadata: {
          api_calls: meta.api_calls,
          elapsed_ms: meta.elapsed_ms,
          rows_scanned: meta.rows_scanned,
        },
      },
    };
  }),
});

register({
  name: "list_database_row_refs",
  access: "read",
  domain: "databases",
  description: "List compact database row references for navigation or read-only write planning.",
  batchable: false,
  schema: ListDatabaseRowRefsParams,
  example: {
    data_source_id: "<data-source-id>",
    select: ["Status"],
    limit: 25,
  },
  handler: tryHandler(async (params: RowRefsParams): Promise<OperationResult<unknown>> => {
    const scanned = await scanRows(params, { limit: DEFAULT_LIMIT, max_pages: DEFAULT_MAX_PAGES });
    if (!scanned.ok) return scanned;
    const { rows, meta } = scanned.data;
    return {
      ok: true,
      data: {
        results: rows.map((row) => rowRef(row, params.select)),
        has_more: meta.has_more,
        next_cursor: meta.next_cursor,
        truncated: meta.truncated,
        metadata: {
          api_calls: meta.api_calls,
          elapsed_ms: meta.elapsed_ms,
          rows_scanned: meta.rows_scanned,
        },
      },
    };
  }),
});

register({
  name: "match_database_rows",
  access: "read",
  domain: "databases",
  description: "Find compact row references whose selected or all flattened properties contain a text query, without returning full rows.",
  batchable: false,
  schema: MatchDatabaseRowsParams,
  example: {
    data_source_id: "<data-source-id>",
    query: "PO",
    properties: ["Task"],
    select: ["Step-Nr", "Phase/Status", "Task"],
    limit: 25,
  },
  handler: tryHandler(async (params: MatchRowsParams): Promise<OperationResult<unknown>> => {
    const scanned = await scanRows(params, { limit: DEFAULT_LIMIT, max_pages: DEFAULT_MAX_PAGES });
    if (!scanned.ok) return scanned;
    const { rows, meta } = scanned.data;
    const matches = rows.filter((row) => matchesTextQuery(row, params.query, params.properties));
    return {
      ok: true,
      data: {
        query: params.query,
        matched_total: matches.length,
        results: matches.map((row) => rowRef(row, params.select)),
        has_more: meta.has_more,
        next_cursor: meta.next_cursor,
        truncated: meta.truncated,
        metadata: {
          api_calls: meta.api_calls,
          elapsed_ms: meta.elapsed_ms,
          rows_scanned: meta.rows_scanned,
        },
      },
    };
  }),
});
