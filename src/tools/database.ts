import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { handleNotionError } from "../utils/error.js";
import { DatabaseOperationParams } from "../types/database.js";
import { createDatabase } from "./createDatabase.js";
import { queryDatabase } from "./queryDatabase.js";
import { updateDatabase } from "./updateDatabase.js";
import {
  aggregateDatabaseTableTool,
  getDatabaseRowsByIdsTool,
  inspectDatabaseCompactTool,
  listDatabaseRowRefsTool,
  matchDatabaseRowsTool,
  queryDatabaseTableTool,
  summarizeDatabaseTableTool,
  validateDatabaseQueryTool,
} from "./databaseTable.js";

export const registerDatabaseOperationTool = async (
  params: DatabaseOperationParams
): Promise<CallToolResult> => {
  switch (params.payload.action) {
    case "create_database":
      return createDatabase(params.payload.params);
    case "query_database":
      return queryDatabase(params.payload.params);
    case "inspect_database_compact":
      return inspectDatabaseCompactTool(params.payload.params);
    case "validate_database_query":
      return validateDatabaseQueryTool(params.payload.params);
    case "query_database_table":
      return queryDatabaseTableTool(params.payload.params);
    case "list_database_row_refs":
      return listDatabaseRowRefsTool(params.payload.params);
    case "get_database_rows_by_ids":
      return getDatabaseRowsByIdsTool(params.payload.params);
    case "match_database_rows":
      return matchDatabaseRowsTool(params.payload.params);
    case "aggregate_database_table":
      return aggregateDatabaseTableTool(params.payload.params);
    case "summarize_database_table":
      return summarizeDatabaseTableTool(params.payload.params);
    case "update_database":
      return updateDatabase(params.payload.params);
    default:
      return handleNotionError(
        new Error(
          `Unsupported action, use one of the following: "create_database", "query_database", "inspect_database_compact", "validate_database_query", "query_database_table", "list_database_row_refs", "get_database_rows_by_ids", "match_database_rows", "aggregate_database_table", "summarize_database_table", "update_database"`
        )
      );
  }
};
