import { DatabaseAdapter } from "./notionDatabaseAdapter.js";
import { OrderBy, PaginatedRows, QueryStats } from "./types.js";

export interface PageQueryInput {
  database_id: string;
  filter?: any;
  sorts?: any[];
  start_cursor?: string;
  page_size?: number;
  limit?: number;
  max_pages?: number;
}

function elapsedSince(start: number): number {
  return Date.now() - start;
}

export async function queryRows(adapter: DatabaseAdapter, input: PageQueryInput): Promise<PaginatedRows> {
  const start = Date.now();
  const limit = input.limit ?? input.page_size ?? 25;
  const maxPages = input.max_pages ?? 1000;
  const rows: any[] = [];
  let cursor: string | undefined = input.start_cursor;
  let nextCursor: string | null = null;
  let hasMore = false;
  let apiCalls = 0;

  while (rows.length < limit && apiCalls < maxPages) {
    const remaining = Math.max(1, Math.min(100, limit - rows.length));
    const response = await adapter.queryDatabase({
      database_id: input.database_id,
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.sorts ? { sorts: input.sorts } : {}),
      ...(cursor ? { start_cursor: cursor } : {}),
      page_size: remaining,
    });

    apiCalls += 1;
    rows.push(...(response.results ?? []));
    nextCursor = response.next_cursor ?? null;
    hasMore = Boolean(response.has_more);

    if (!hasMore || !nextCursor) break;
    cursor = nextCursor;
  }

  const stats: QueryStats = {
    api_calls: apiCalls,
    elapsed_ms: elapsedSince(start),
    truncated: apiCalls >= maxPages && hasMore,
  };

  return { rows, next_cursor: nextCursor, has_more: hasMore, stats };
}

export async function scanRows(
  adapter: DatabaseAdapter,
  input: Omit<PageQueryInput, "page_size" | "limit">
): Promise<PaginatedRows> {
  const start = Date.now();
  const maxPages = input.max_pages ?? 1000;
  const rows: any[] = [];
  let cursor: string | undefined = input.start_cursor;
  let nextCursor: string | null = null;
  let hasMore = false;
  let apiCalls = 0;

  do {
    const response = await adapter.queryDatabase({
      database_id: input.database_id,
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.sorts ? { sorts: input.sorts } : {}),
      ...(cursor ? { start_cursor: cursor } : {}),
      page_size: 100,
    });

    apiCalls += 1;
    rows.push(...(response.results ?? []));
    nextCursor = response.next_cursor ?? null;
    hasMore = Boolean(response.has_more);
    cursor = nextCursor ?? undefined;
  } while (hasMore && cursor && apiCalls < maxPages);

  const stats: QueryStats = {
    api_calls: apiCalls,
    elapsed_ms: elapsedSince(start),
    truncated: apiCalls >= maxPages && hasMore,
  };

  return { rows, next_cursor: nextCursor, has_more: hasMore, stats };
}
