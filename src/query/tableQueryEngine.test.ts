import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseAdapter } from "./notionDatabaseAdapter.js";
import { aggregateDatabaseTable, getDatabaseRowsByIds, queryDatabaseTable } from "./tableQueryEngine.js";

const database = {
  id: "db1",
  title: [{ plain_text: "Feature Steps" }],
  properties: {
    Task: { id: "title-id", type: "title" },
    Status: { id: "status-id", type: "status" },
  },
};

const rows = [
  {
    id: "page1",
    parent: { type: "database_id", database_id: "db1" },
    last_edited_time: "2026-05-17T10:00:00.000Z",
    properties: {
      Task: { type: "title", title: [{ plain_text: "Plan PO step" }] },
      Status: { type: "status", status: { name: "Ready" } },
    },
  },
  {
    id: "page2",
    parent: { type: "database_id", database_id: "db1" },
    last_edited_time: "2026-05-17T10:01:00.000Z",
    properties: {
      Task: { type: "title", title: [{ plain_text: "Build step" }] },
      Status: { type: "status", status: { name: "Manual" } },
    },
  },
];

const adapter: DatabaseAdapter = {
  async retrieveDatabase() {
    return database;
  },
  async queryDatabase() {
    return { results: rows, next_cursor: null, has_more: false };
  },
  async retrievePage(pageId: string) {
    return rows.find((row) => row.id === pageId);
  },
};

test("queryDatabaseTable returns projected rows only", async () => {
  const result = await queryDatabaseTable(adapter, {
    database_id: "db1",
    select: ["Task"],
    limit: 10,
  });

  assert.deepEqual(result.rows, [
    { page_id: "page1", Task: "Plan PO step" },
    { page_id: "page2", Task: "Build step" },
  ]);
  assert.equal(result.api_calls, 1);
});

test("aggregateDatabaseTable groups compact values", async () => {
  const result = await aggregateDatabaseTable(adapter, {
    database_id: "db1",
    group_by: ["Status"],
  });

  assert.equal(result.total, 2);
  assert.deepEqual(result.groups, [
    { key: { Status: "Ready" }, count: 1 },
    { key: { Status: "Manual" }, count: 1 },
  ]);
});

test("getDatabaseRowsByIds rejects pages outside the requested database", async () => {
  const mixedAdapter: DatabaseAdapter = {
    ...adapter,
    async retrievePage() {
      return {
        id: "other-page",
        parent: { type: "database_id", database_id: "other-db" },
        properties: {},
      };
    },
  };

  await assert.rejects(
    getDatabaseRowsByIds(mixedAdapter, {
      database_id: "db1",
      page_ids: ["other-page"],
      select: ["Task"],
    }),
    /does not belong to database db1/
  );
});
