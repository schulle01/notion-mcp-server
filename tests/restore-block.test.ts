import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const notionStub = {
  blocks: { update: vi.fn() },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

import { dispatch } from "../src/dispatch/index.js";
import { getOperation, initOperations } from "../src/operations/index.js";
import { emitJsonSchema } from "../src/schema/emit.js";

const BLOCK = {
  object: "block" as const,
  id: "block-original-id",
  parent: { type: "page_id" as const, page_id: "page-1" },
  created_time: "2026-09-23T00:00:00.000Z",
  last_edited_time: "2026-09-23T00:00:01.000Z",
  created_by: { object: "user" as const, id: "user-1" },
  last_edited_by: { object: "user" as const, id: "user-1" },
  has_children: false,
  archived: false,
  in_trash: false,
  type: "paragraph" as const,
  paragraph: {
    rich_text: [
      {
        type: "text" as const,
        plain_text: "Preserved text",
        href: null,
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: "default" as const,
        },
        text: { content: "Preserved text", link: null },
      },
    ],
    color: "default" as const,
  },
};

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  notionStub.blocks.update.mockReset();
});

describe("restore_block", () => {
  it("is a batchable blocks write with only block_id and verbose parameters", () => {
    const def = getOperation("restore_block")!;
    expect(def).toMatchObject({ access: "write", domain: "blocks", batchable: true });

    const schema = emitJsonSchema(def.schema);
    expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual(["block_id", "verbose"]);
  });

  it("sends only block_id and in_trash: false and returns the slimmed block", async () => {
    notionStub.blocks.update.mockResolvedValue(BLOCK);

    const result = await dispatch("restore_block", { block_id: "block-original-id" });

    expect(notionStub.blocks.update).toHaveBeenCalledWith({
      block_id: "block-original-id",
      in_trash: false,
    });
    expect(notionStub.blocks.update).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      data: { id: "block-original-id", type: "paragraph", text: "Preserved text" },
    });
  });

  it("returns the unchanged SDK response in verbose mode", async () => {
    notionStub.blocks.update.mockResolvedValue(BLOCK);

    const result = await dispatch("restore_block", {
      block_id: "block-original-id",
      verbose: true,
    });

    expect(result).toEqual({ ok: true, data: BLOCK });
  });

  it("uses the generic batch integration", async () => {
    notionStub.blocks.update.mockImplementation(async ({ block_id }) => ({ ...BLOCK, id: block_id }));

    const result = await dispatch("restore_block", {
      items: [{ block_id: "block-1" }, { block_id: "block-2" }],
      concurrency: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      summary: { total: 2, succeeded: 2, failed: 0 },
      results: [
        { index: 0, ok: true, data: { id: "block-1" } },
        { index: 1, ok: true, data: { id: "block-2" } },
      ],
    });
    expect(notionStub.blocks.update.mock.calls.map(([body]) => body)).toEqual([
      { block_id: "block-1", in_trash: false },
      { block_id: "block-2", in_trash: false },
    ]);
  });

  it("returns provider failures through the shared error envelope", async () => {
    notionStub.blocks.update.mockRejectedValue(new Error("provider unavailable"));

    const result = await dispatch("restore_block", { block_id: "block-original-id" });

    expect(result).toEqual({
      ok: false,
      error: { code: "internal_error", message: "provider unavailable" },
    });
  });
});
