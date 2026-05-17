export type Direction = "ascending" | "descending";

export interface QueryStats {
  api_calls: number;
  elapsed_ms: number;
  truncated: boolean;
}

export interface DatabasePropertyInfo {
  name: string;
  id?: string;
  type: string;
  writable: boolean;
  options?: string[];
}

export interface CompactDatabaseInfo {
  database_id: string;
  title: string;
  properties: DatabasePropertyInfo[];
}

export interface SimpleFilter {
  property: string;
  op: string;
  value?: unknown;
}

export interface CompoundFilter {
  and?: DatabaseWhere[];
  or?: DatabaseWhere[];
}

export type DatabaseWhere = SimpleFilter | CompoundFilter;

export interface OrderBy {
  property?: string;
  timestamp?: "created_time" | "last_edited_time";
  direction: Direction;
}

export interface RowRef {
  page_id: string;
  title: string | null;
  key?: Record<string, unknown>;
  last_edited_time?: string;
  url?: string;
  matched_properties?: string[];
  sample?: Record<string, unknown>;
}

export interface PaginatedRows {
  rows: any[];
  next_cursor: string | null;
  has_more: boolean;
  stats: QueryStats;
}
