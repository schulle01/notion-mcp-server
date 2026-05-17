import { compileSorts, compileWhere, validateQueryInput } from "./filterCompiler.js";
import { DatabaseAdapter } from "./notionDatabaseAdapter.js";
import { queryRows, scanRows } from "./paginate.js";
import { extractPropertyValue, extractRowValues, extractTitle } from "./propertyValueExtractor.js";
import { getDatabaseProperties, inspectCompactDatabase, resolvePropertyName } from "./schemaInspector.js";
import { DatabaseWhere, OrderBy, RowRef } from "./types.js";

export interface CommonQueryParams {
  database_id: string;
  where?: DatabaseWhere;
  filter?: any;
  order_by?: OrderBy[];
  max_pages?: number;
}

export interface QueryTableParams extends CommonQueryParams {
  select?: string[];
  cursor?: string;
  limit?: number;
  include_page_url?: boolean;
  max_string_length?: number;
}

export interface RowRefsParams extends CommonQueryParams {
  key_properties?: string[];
  sample_properties?: string[];
  cursor?: string;
  limit?: number;
  include_page_url?: boolean;
}

export interface RowsByIdsParams {
  database_id: string;
  page_ids: string[];
  select?: string[];
  include_page_url?: boolean;
  max_string_length?: number;
}

export interface MatchRowsParams extends CommonQueryParams {
  query: string;
  search_properties?: string[];
  key_properties?: string[];
  limit?: number;
  include_snippets?: boolean;
}

export interface AggregateParams extends CommonQueryParams {
  group_by?: string[];
}

export interface SummarizeParams extends CommonQueryParams {
  properties?: string[];
  top_values_limit?: number;
}

function rawFilter(params: CommonQueryParams, databaseProperties: Record<string, any>): any | undefined {
  return params.filter ?? compileWhere(databaseProperties, params.where);
}

function rawSorts(params: CommonQueryParams, databaseProperties: Record<string, any>): any[] | undefined {
  return compileSorts(databaseProperties, params.order_by);
}

function buildRowRef(
  page: any,
  databaseProperties: Record<string, any>,
  keyProperties: string[] | undefined,
  sampleProperties: string[] | undefined,
  includePageUrl = false
): RowRef {
  const ref: RowRef = {
    page_id: page.id,
    title: extractTitle(page, databaseProperties),
    last_edited_time: page.last_edited_time,
  };

  if (includePageUrl && page.url) ref.url = page.url;
  if (keyProperties?.length) ref.key = extractRowValues(page, databaseProperties, keyProperties, { maxStringLength: 120 });
  if (sampleProperties?.length) {
    ref.sample = extractRowValues(page, databaseProperties, sampleProperties, { maxStringLength: 160 });
  }

  return ref;
}

function searchablePropertyNames(databaseProperties: Record<string, any>, requested: string[] | undefined): string[] {
  const allowedTypes = new Set([
    "title",
    "rich_text",
    "select",
    "status",
    "multi_select",
    "url",
    "email",
    "phone_number",
    "formula",
    "number",
    "checkbox",
  ]);

  const candidates = requested?.length ? requested : Object.keys(databaseProperties);
  return candidates
    .map((name) => resolvePropertyName(databaseProperties, name))
    .filter((name): name is string => Boolean(name))
    .filter((name) => allowedTypes.has(databaseProperties[name]?.type));
}

function valueContains(value: unknown, query: string): boolean {
  const needle = query.toLowerCase();
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => valueContains(item, query));
  if (typeof value === "object") return JSON.stringify(value).toLowerCase().includes(needle);
  return String(value).toLowerCase().includes(needle);
}

function groupKey(row: any, databaseProperties: Record<string, any>, groupBy: string[]): string {
  const values = extractRowValues(row, databaseProperties, groupBy, { maxStringLength: 160 });
  return JSON.stringify(values);
}

function normalizeId(id: string | undefined): string {
  return (id ?? "").replace(/-/g, "").toLowerCase();
}

function assertPageBelongsToDatabase(page: any, databaseId: string): void {
  if (page?.parent?.type !== "database_id" || normalizeId(page.parent.database_id) !== normalizeId(databaseId)) {
    throw new Error(`Page ${page?.id ?? "unknown"} does not belong to database ${databaseId}`);
  }
}

export async function inspectDatabaseCompact(adapter: DatabaseAdapter, databaseId: string) {
  const database = await adapter.retrieveDatabase(databaseId);
  return inspectCompactDatabase(database);
}

export async function validateDatabaseQuery(adapter: DatabaseAdapter, params: QueryTableParams) {
  const database = await adapter.retrieveDatabase(params.database_id);
  const properties = getDatabaseProperties(database);
  const findings = validateQueryInput(properties, params.where, params.order_by, params.select);
  return {
    valid: findings.every((finding) => finding.level !== "error"),
    findings,
  };
}

export async function queryDatabaseTable(adapter: DatabaseAdapter, params: QueryTableParams) {
  const database = await adapter.retrieveDatabase(params.database_id);
  const properties = getDatabaseProperties(database);
  const filter = rawFilter(params, properties);
  const sorts = rawSorts(params, properties);
  const page = await queryRows(adapter, {
    database_id: params.database_id,
    filter,
    sorts,
    start_cursor: params.cursor,
    limit: params.limit ?? 25,
    max_pages: params.max_pages,
  });

  return {
    rows: page.rows.map((row) => ({
      page_id: row.id,
      ...(params.include_page_url && row.url ? { url: row.url } : {}),
      ...extractRowValues(row, properties, params.select, { maxStringLength: params.max_string_length ?? 500 }),
    })),
    has_more: page.has_more,
    next_cursor: page.next_cursor,
    ...page.stats,
  };
}

export async function listDatabaseRowRefs(adapter: DatabaseAdapter, params: RowRefsParams) {
  const database = await adapter.retrieveDatabase(params.database_id);
  const properties = getDatabaseProperties(database);
  const filter = rawFilter(params, properties);
  const sorts = rawSorts(params, properties);
  const page = await queryRows(adapter, {
    database_id: params.database_id,
    filter,
    sorts,
    start_cursor: params.cursor,
    limit: params.limit ?? 50,
    max_pages: params.max_pages,
  });

  return {
    rows: page.rows.map((row) =>
      buildRowRef(row, properties, params.key_properties, params.sample_properties, params.include_page_url)
    ),
    has_more: page.has_more,
    next_cursor: page.next_cursor,
    ...page.stats,
  };
}

export async function getDatabaseRowsByIds(adapter: DatabaseAdapter, params: RowsByIdsParams) {
  const started = Date.now();
  const database = await adapter.retrieveDatabase(params.database_id);
  const properties = getDatabaseProperties(database);
  const rows = [];
  let apiCalls = 1;

  for (const pageId of params.page_ids) {
    const page = await adapter.retrievePage(pageId);
    assertPageBelongsToDatabase(page, params.database_id);
    apiCalls += 1;
    rows.push({
      page_id: page.id,
      ...(params.include_page_url && page.url ? { url: page.url } : {}),
      ...extractRowValues(page, properties, params.select, { maxStringLength: params.max_string_length ?? 500 }),
    });
  }

  return {
    rows,
    api_calls: apiCalls,
    elapsed_ms: Date.now() - started,
    truncated: false,
  };
}

export async function matchDatabaseRows(adapter: DatabaseAdapter, params: MatchRowsParams) {
  const database = await adapter.retrieveDatabase(params.database_id);
  const properties = getDatabaseProperties(database);
  const filter = rawFilter(params, properties);
  const sorts = rawSorts(params, properties);
  const scan = await scanRows(adapter, {
    database_id: params.database_id,
    filter,
    sorts,
    max_pages: params.max_pages,
  });
  const searchableNames = searchablePropertyNames(properties, params.search_properties);
  const matches: RowRef[] = [];

  for (const row of scan.rows) {
    const matchedProperties: string[] = [];
    for (const propertyName of searchableNames) {
      const value = extractPropertyValue(row?.properties?.[propertyName], { maxStringLength: 2000 });
      if (valueContains(value, params.query)) matchedProperties.push(propertyName);
    }

    if (matchedProperties.length > 0) {
      const ref = buildRowRef(row, properties, params.key_properties, params.include_snippets ? matchedProperties : undefined, false);
      ref.matched_properties = matchedProperties;
      matches.push(ref);
    }
  }

  const limit = params.limit ?? 100;
  return {
    matched_total: matches.length,
    rows: matches.slice(0, limit),
    has_more: matches.length > limit,
    ...scan.stats,
  };
}

export async function aggregateDatabaseTable(adapter: DatabaseAdapter, params: AggregateParams) {
  const database = await adapter.retrieveDatabase(params.database_id);
  const properties = getDatabaseProperties(database);
  const filter = rawFilter(params, properties);
  const sorts = rawSorts(params, properties);
  const scan = await scanRows(adapter, {
    database_id: params.database_id,
    filter,
    sorts,
    max_pages: params.max_pages,
  });

  if (!params.group_by?.length) {
    return {
      total: scan.rows.length,
      groups: [],
      ...scan.stats,
    };
  }

  const groups = new Map<string, { key: Record<string, unknown>; count: number }>();
  for (const row of scan.rows) {
    const key = groupKey(row, properties, params.group_by);
    const parsedKey = JSON.parse(key);
    const current = groups.get(key) ?? { key: parsedKey, count: 0 };
    current.count += 1;
    groups.set(key, current);
  }

  return {
    total: scan.rows.length,
    groups: Array.from(groups.values()).sort((a, b) => b.count - a.count),
    ...scan.stats,
  };
}

export async function summarizeDatabaseTable(adapter: DatabaseAdapter, params: SummarizeParams) {
  const database = await adapter.retrieveDatabase(params.database_id);
  const properties = getDatabaseProperties(database);
  const filter = rawFilter(params, properties);
  const sorts = rawSorts(params, properties);
  const scan = await scanRows(adapter, {
    database_id: params.database_id,
    filter,
    sorts,
    max_pages: params.max_pages,
  });
  const selected = params.properties?.length ? params.properties : Object.keys(properties);
  const limit = params.top_values_limit ?? 10;
  const summaries: Record<string, unknown> = {};

  for (const requested of selected) {
    const propertyName = resolvePropertyName(properties, requested);
    if (!propertyName) continue;
    const counts = new Map<string, number>();
    let empty = 0;
    let present = 0;

    for (const row of scan.rows) {
      const value = extractPropertyValue(row?.properties?.[propertyName], { maxStringLength: 160 });
      const isEmpty =
        value === null ||
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && value.length === 0);
      if (isEmpty) {
        empty += 1;
      } else {
        present += 1;
        const key = JSON.stringify(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    summaries[propertyName] = {
      type: properties[propertyName]?.type,
      count_present: present,
      count_empty: empty,
      top_values: Array.from(counts.entries())
        .map(([value, count]) => ({ value: JSON.parse(value), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit),
    };
  }

  return {
    total: scan.rows.length,
    properties: summaries,
    ...scan.stats,
  };
}
