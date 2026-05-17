import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { notionDatabaseAdapter } from "../query/notionDatabaseAdapter.js";
import {
  aggregateDatabaseTable,
  getDatabaseRowsByIds,
  inspectDatabaseCompact,
  listDatabaseRowRefs,
  matchDatabaseRows,
  queryDatabaseTable,
  summarizeDatabaseTable,
  validateDatabaseQuery,
} from "../query/tableQueryEngine.js";
import { handleNotionError } from "../utils/error.js";

function jsonResult(result: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

export async function inspectDatabaseCompactTool(params: { database_id: string }): Promise<CallToolResult> {
  try {
    return jsonResult(await inspectDatabaseCompact(notionDatabaseAdapter, params.database_id));
  } catch (error) {
    return handleNotionError(error);
  }
}

export async function validateDatabaseQueryTool(params: any): Promise<CallToolResult> {
  try {
    return jsonResult(await validateDatabaseQuery(notionDatabaseAdapter, params));
  } catch (error) {
    return handleNotionError(error);
  }
}

export async function queryDatabaseTableTool(params: any): Promise<CallToolResult> {
  try {
    return jsonResult(await queryDatabaseTable(notionDatabaseAdapter, params));
  } catch (error) {
    return handleNotionError(error);
  }
}

export async function listDatabaseRowRefsTool(params: any): Promise<CallToolResult> {
  try {
    return jsonResult(await listDatabaseRowRefs(notionDatabaseAdapter, params));
  } catch (error) {
    return handleNotionError(error);
  }
}

export async function getDatabaseRowsByIdsTool(params: any): Promise<CallToolResult> {
  try {
    return jsonResult(await getDatabaseRowsByIds(notionDatabaseAdapter, params));
  } catch (error) {
    return handleNotionError(error);
  }
}

export async function matchDatabaseRowsTool(params: any): Promise<CallToolResult> {
  try {
    return jsonResult(await matchDatabaseRows(notionDatabaseAdapter, params));
  } catch (error) {
    return handleNotionError(error);
  }
}

export async function aggregateDatabaseTableTool(params: any): Promise<CallToolResult> {
  try {
    return jsonResult(await aggregateDatabaseTable(notionDatabaseAdapter, params));
  } catch (error) {
    return handleNotionError(error);
  }
}

export async function summarizeDatabaseTableTool(params: any): Promise<CallToolResult> {
  try {
    return jsonResult(await summarizeDatabaseTable(notionDatabaseAdapter, params));
  } catch (error) {
    return handleNotionError(error);
  }
}
