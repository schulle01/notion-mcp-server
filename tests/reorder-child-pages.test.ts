import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const notionStub = {
  blocks: { children: { list: vi.fn() } },
  pages: { retrieveMarkdown: vi.fn(), updateMarkdown: vi.fn() },
};

vi.mock("../src/services/notion.js", () => ({ getClient: async () => notionStub }));

import { dispatch } from "../src/dispatch/index.js";
import { initOperations } from "../src/operations/index.js";
import { planChildPageReorder } from "../src/operations/reorder-child-pages.js";

const PARENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

const paragraph = (id = "99999999-9999-9999-9999-999999999999", text = "control") => ({
  id,
  type: "paragraph",
  parent: { type: "page_id", page_id: PARENT },
  paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
});
const child = (id: string, title: string) => ({
  id,
  type: "child_page",
  parent: { type: "page_id", page_id: PARENT },
  child_page: { title },
});
const tag = (id: string, title: string) => `<page url="https://app.notion.com/p/${id.replace(/-/g, "")}">${title}</page>`;
const MARKDOWN = `Before\n\n${tag(A, "A")}\n${tag(B, "B")}\n${tag(C, "C")}\n\nAfter`;
const BLOCKS = [paragraph(), child(A, "A"), child(B, "B"), child(C, "C"), paragraph("88888888-8888-8888-8888-888888888888", "after")];

function hostedImage(path: string, signature: string, expiry: string, version = "stable", checksumMode = "ENABLED") {
  return {
    id: "77777777-7777-7777-7777-777777777777",
    type: "image",
    parent: { type: "page_id", page_id: PARENT },
    image: {
      type: "file",
      file: {
        url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/${path}?versionId=${version}&X-Amz-Checksum-Mode=${checksumMode}&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${signature}&X-Amz-Expires=3600`,
        expiry_time: expiry,
      },
      caption: [],
    },
  };
}

function externalImage(url: string) {
  return {
    id: "77777777-7777-7777-7777-777777777777",
    type: "image",
    parent: { type: "page_id", page_id: PARENT },
    image: { type: "external", external: { url }, caption: [] },
  };
}

function markdownResponse(markdown = MARKDOWN) {
  return { markdown, truncated: false, unknown_block_ids: [] };
}

function listPage(results = BLOCKS) {
  return { results, has_more: false, next_cursor: null };
}

beforeAll(async () => initOperations());
beforeEach(() => {
  notionStub.blocks.children.list.mockReset();
  notionStub.pages.retrieveMarkdown.mockReset();
  notionStub.pages.updateMarkdown.mockReset();
});

describe("reorder_child_pages planner", () => {
  it("permutes exact page tags without changing their attributes or titles", () => {
    const plan = planChildPageReorder(BLOCKS, MARKDOWN, [C, A, B]);
    expect(plan).toMatchObject({ ok: true, supported: true, changed: true });
    if (!plan.ok || !plan.supported) throw new Error("expected supported plan");
    expect(plan.old_str).toBe(`${tag(A, "A")}\n${tag(B, "B")}\n${tag(C, "C")}`);
    expect(plan.new_str).toBe(`${tag(C, "C")}\n${tag(A, "A")}\n${tag(B, "B")}`);
  });

  it("rejects duplicate, missing, and foreign IDs", () => {
    expect(planChildPageReorder(BLOCKS, MARKDOWN, [A, A, C])).toMatchObject({ ok: false, code: "duplicate_page_id" });
    expect(planChildPageReorder(BLOCKS, MARKDOWN, [A, B])).toMatchObject({ ok: false, code: "invalid_child_page_permutation" });
    expect(planChildPageReorder(BLOCKS, MARKDOWN, [A, B, "44444444-4444-4444-4444-444444444444"])).toMatchObject({ ok: false, code: "invalid_child_page_permutation" });
  });

  it("marks separated child pages and unsupported Markdown representations unsupported", () => {
    const separated = [child(A, "A"), paragraph(), child(B, "B"), child(C, "C")];
    expect(planChildPageReorder(separated, MARKDOWN, [C, B, A])).toMatchObject({ ok: true, supported: false });
    expect(planChildPageReorder(BLOCKS, MARKDOWN.replace(tag(B, "B"), "[B](url)"), [C, B, A])).toMatchObject({ ok: true, supported: false });
  });
});

describe("reorder_child_pages handler", () => {
  it("defaults to dry-run and fully paginates without writing", async () => {
    notionStub.blocks.children.list
      .mockResolvedValueOnce({ results: BLOCKS.slice(0, 3), has_more: true, next_cursor: "next" })
      .mockResolvedValueOnce({ results: BLOCKS.slice(3), has_more: false, next_cursor: null });
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, A, B] });
    expect(result).toMatchObject({ ok: true, data: { supported: true, changed: true } });
    expect(notionStub.blocks.children.list).toHaveBeenNthCalledWith(2, { block_id: PARENT, page_size: 100, start_cursor: "next" });
    expect(notionStub.pages.updateMarkdown).not.toHaveBeenCalled();
  });

  it("avoids a write for an unchanged order", async () => {
    notionStub.blocks.children.list.mockResolvedValue(listPage());
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [A, B, C], dry_run: false });
    expect(result).toMatchObject({ ok: true, data: { supported: true, changed: false } });
    expect(notionStub.pages.updateMarkdown).not.toHaveBeenCalled();
  });

  it("sends one exact update_content replacement and verifies the result", async () => {
    notionStub.blocks.children.list
      .mockResolvedValueOnce(listPage())
      .mockResolvedValueOnce(listPage())
      .mockResolvedValueOnce(listPage([BLOCKS[0], child(C, "C"), child(A, "A"), child(B, "B"), BLOCKS[4]]));
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: PARENT });
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, A, B], dry_run: false });
    expect(result).toMatchObject({ ok: true, data: { actual_order: [C.replace(/-/g, ""), A.replace(/-/g, ""), B.replace(/-/g, "")] } });
    expect(notionStub.pages.updateMarkdown).toHaveBeenCalledTimes(1);
    expect(notionStub.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: PARENT,
      type: "update_content",
      update_content: {
        content_updates: [{
          old_str: `${tag(A, "A")}\n${tag(B, "B")}\n${tag(C, "C")}`,
          new_str: `${tag(C, "C")}\n${tag(A, "A")}\n${tag(B, "B")}`,
        }],
        allow_deleting_content: false,
      },
    });
  });

  it("refuses incomplete Markdown and incomplete pagination", async () => {
    notionStub.blocks.children.list.mockResolvedValue(listPage());
    notionStub.pages.retrieveMarkdown.mockResolvedValue({ ...markdownResponse(), truncated: true });
    expect(await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false })).toMatchObject({ ok: false, error: { code: "incomplete_page_state" } });

    notionStub.blocks.children.list.mockReset().mockResolvedValue({ results: BLOCKS, has_more: true, next_cursor: null });
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    expect(await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false })).toMatchObject({ ok: false, error: { code: "incomplete_page_state" } });
    expect(notionStub.pages.updateMarkdown).not.toHaveBeenCalled();
  });

  it("detects a concurrent change before writing", async () => {
    notionStub.blocks.children.list
      .mockResolvedValueOnce(listPage())
      .mockResolvedValueOnce(listPage([paragraph(undefined, "changed"), ...BLOCKS.slice(1)]));
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: false, error: { code: "concurrent_page_change" } });
    expect(notionStub.pages.updateMarkdown).not.toHaveBeenCalled();
  });

  it("accepts refreshed Notion file signatures before and after the write", async () => {
    const initial = [hostedImage("space/file.png", "old", "2026-09-23T10:00:00Z"), ...BLOCKS.slice(1)];
    const latest = [hostedImage("space/file.png", "new", "2026-09-23T11:00:00Z"), ...BLOCKS.slice(1)];
    const after = [hostedImage("space/file.png", "newer", "2026-09-23T12:00:00Z"), child(C, "C"), child(B, "B"), child(A, "A"), BLOCKS[4]];
    notionStub.blocks.children.list
      .mockResolvedValueOnce(listPage(initial))
      .mockResolvedValueOnce(listPage(latest))
      .mockResolvedValueOnce(listPage(after));
    notionStub.pages.retrieveMarkdown
      .mockResolvedValueOnce(markdownResponse(`![file](https://signed/old)\n${MARKDOWN}`))
      .mockResolvedValueOnce(markdownResponse(`![file](https://signed/new)\n${MARKDOWN}`));
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: PARENT });
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: true });
  });

  it("detects an actual Notion-hosted file change", async () => {
    const initial = [hostedImage("space/file.png", "old", "2026-09-23T10:00:00Z"), ...BLOCKS.slice(1)];
    const changed = [hostedImage("space/other.png", "new", "2026-09-23T11:00:00Z"), ...BLOCKS.slice(1)];
    notionStub.blocks.children.list.mockResolvedValueOnce(listPage(initial)).mockResolvedValueOnce(listPage(changed));
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: false, error: { code: "concurrent_page_change" } });
    expect(notionStub.pages.updateMarkdown).not.toHaveBeenCalled();
  });

  it("keeps non-signature hosted-file query parameters identity-relevant", async () => {
    const initial = [hostedImage("space/file.png", "old", "2026-09-23T10:00:00Z", "v1"), ...BLOCKS.slice(1)];
    const changed = [hostedImage("space/file.png", "new", "2026-09-23T11:00:00Z", "v2"), ...BLOCKS.slice(1)];
    notionStub.blocks.children.list.mockResolvedValueOnce(listPage(initial)).mockResolvedValueOnce(listPage(changed));
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: false, error: { code: "concurrent_page_change" } });
    expect(notionStub.pages.updateMarkdown).not.toHaveBeenCalled();
  });

  it("keeps non-authentication X-Amz parameters identity-relevant", async () => {
    const initial = [hostedImage("space/file.png", "old", "2026-09-23T10:00:00Z", "stable", "ENABLED"), ...BLOCKS.slice(1)];
    const changed = [hostedImage("space/file.png", "new", "2026-09-23T11:00:00Z", "stable", "DISABLED"), ...BLOCKS.slice(1)];
    notionStub.blocks.children.list.mockResolvedValueOnce(listPage(initial)).mockResolvedValueOnce(listPage(changed));
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: false, error: { code: "concurrent_page_change" } });
    expect(notionStub.pages.updateMarkdown).not.toHaveBeenCalled();
  });

  it("detects a changed external file URL", async () => {
    const initial = [externalImage("https://example.com/file.png"), ...BLOCKS.slice(1)];
    const changed = [externalImage("https://example.com/other.png"), ...BLOCKS.slice(1)];
    notionStub.blocks.children.list.mockResolvedValueOnce(listPage(initial)).mockResolvedValueOnce(listPage(changed));
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: false, error: { code: "concurrent_page_change" } });
    expect(notionStub.pages.updateMarkdown).not.toHaveBeenCalled();
  });

  it("surfaces API write errors without claiming success", async () => {
    notionStub.blocks.children.list.mockResolvedValue(listPage());
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    notionStub.pages.updateMarkdown.mockRejectedValue(new Error("write rejected"));
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: false });
  });

  it("reports post-write mismatch and post-write verification errors as already mutated", async () => {
    notionStub.blocks.children.list
      .mockResolvedValueOnce(listPage())
      .mockResolvedValueOnce(listPage())
      .mockResolvedValueOnce(listPage());
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: PARENT });
    let result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: false, error: { code: "post_write_verification_failed" } });
    expect((result as { error: { message: string } }).error.message).toContain("write already occurred");

    notionStub.blocks.children.list.mockReset()
      .mockResolvedValueOnce(listPage())
      .mockResolvedValueOnce(listPage())
      .mockRejectedValueOnce(new Error("read failed"));
    result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: false, error: { code: "post_write_verification_failed" } });
    expect((result as { error: { message: string } }).error.message).toContain("write already occurred");
  });

  it("rejects a post-write child-title change even when the ID order is correct", async () => {
    notionStub.blocks.children.list
      .mockResolvedValueOnce(listPage())
      .mockResolvedValueOnce(listPage())
      .mockResolvedValueOnce(listPage([BLOCKS[0], child(C, "changed"), child(B, "B"), child(A, "A"), BLOCKS[4]]));
    notionStub.pages.retrieveMarkdown.mockResolvedValue(markdownResponse());
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: PARENT });
    const result = await dispatch("reorder_child_pages", { page_id: PARENT, ordered_page_ids: [C, B, A], dry_run: false });
    expect(result).toMatchObject({ ok: false, error: { code: "post_write_verification_failed" } });
  });
});
