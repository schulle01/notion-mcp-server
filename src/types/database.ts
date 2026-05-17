import { z } from "zod";
import {
  AGGREGATE_DATABASE_TABLE_SCHEMA,
  CREATE_DATABASE_SCHEMA,
  GET_DATABASE_ROWS_BY_IDS_SCHEMA,
  INSPECT_DATABASE_COMPACT_SCHEMA,
  LIST_DATABASE_ROW_REFS_SCHEMA,
  MATCH_DATABASE_ROWS_SCHEMA,
  QUERY_DATABASE_SCHEMA,
  QUERY_DATABASE_TABLE_SCHEMA,
  SUMMARIZE_DATABASE_TABLE_SCHEMA,
  UPDATE_DATABASE_SCHEMA,
  VALIDATE_DATABASE_QUERY_SCHEMA,
  DATABASE_OPERATION_SCHEMA,
} from "../schema/database.js";

export const createDatabaseSchema = z.object(CREATE_DATABASE_SCHEMA);
export type CreateDatabaseParams = z.infer<typeof createDatabaseSchema>;

export const queryDatabaseSchema = z.object(QUERY_DATABASE_SCHEMA);
export type QueryDatabaseParams = z.infer<typeof queryDatabaseSchema>;

export const inspectDatabaseCompactSchema = z.object(INSPECT_DATABASE_COMPACT_SCHEMA);
export type InspectDatabaseCompactParams = z.infer<typeof inspectDatabaseCompactSchema>;

export const validateDatabaseQuerySchema = z.object(VALIDATE_DATABASE_QUERY_SCHEMA);
export type ValidateDatabaseQueryParams = z.infer<typeof validateDatabaseQuerySchema>;

export const queryDatabaseTableSchema = z.object(QUERY_DATABASE_TABLE_SCHEMA);
export type QueryDatabaseTableParams = z.infer<typeof queryDatabaseTableSchema>;

export const listDatabaseRowRefsSchema = z.object(LIST_DATABASE_ROW_REFS_SCHEMA);
export type ListDatabaseRowRefsParams = z.infer<typeof listDatabaseRowRefsSchema>;

export const getDatabaseRowsByIdsSchema = z.object(GET_DATABASE_ROWS_BY_IDS_SCHEMA);
export type GetDatabaseRowsByIdsParams = z.infer<typeof getDatabaseRowsByIdsSchema>;

export const matchDatabaseRowsSchema = z.object(MATCH_DATABASE_ROWS_SCHEMA);
export type MatchDatabaseRowsParams = z.infer<typeof matchDatabaseRowsSchema>;

export const aggregateDatabaseTableSchema = z.object(AGGREGATE_DATABASE_TABLE_SCHEMA);
export type AggregateDatabaseTableParams = z.infer<typeof aggregateDatabaseTableSchema>;

export const summarizeDatabaseTableSchema = z.object(SUMMARIZE_DATABASE_TABLE_SCHEMA);
export type SummarizeDatabaseTableParams = z.infer<typeof summarizeDatabaseTableSchema>;

export const updateDatabaseSchema = z.object(UPDATE_DATABASE_SCHEMA);
export type UpdateDatabaseParams = z.infer<typeof updateDatabaseSchema>;

export const databaseOperationSchema = z.object(DATABASE_OPERATION_SCHEMA);
export type DatabaseOperationParams = z.infer<typeof databaseOperationSchema>;
