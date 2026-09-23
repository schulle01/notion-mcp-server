import { z } from "zod";
import { getClient } from "../services/notion.js";
import { notionId, normalizeNotionId } from "../schema/id.js";
import { asSdk, type UpdatePageMarkdownBody } from "../utils/notion-types.js";
import { tryHandler } from "../utils/handler.js";
import { register } from "./registry.js";

type DirectBlock = Record<string, unknown> & { id: string; type: string };

type PageTag = {
  id: string;
  tag: string;
  start: number;
  end: number;
};

export type ReorderPlan =
  | {
      ok: true;
      supported: true;
      changed: boolean;
      current_order: string[];
      desired_order: string[];
      old_str?: string;
      new_str?: string;
    }
  | {
      ok: true;
      supported: false;
      changed: boolean;
      current_order: string[];
      desired_order: string[];
      reason: string;
    }
  | { ok: false; code: string; message: string };

class IncompleteChildrenError extends Error {}

function canonicalId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

function pageIdFromUrl(value: string): string | undefined {
  const normalized = normalizeNotionId(value);
  if (typeof normalized !== "string" || !/^[0-9a-f]{32}$/i.test(canonicalId(normalized))) return undefined;
  return canonicalId(normalized);
}

function topLevelPageTags(markdown: string): PageTag[] {
  const tags: PageTag[] = [];
  const pattern = /^<page\b[^>]*\burl="([^"]+)"[^>]*>[^\n]*<\/page>[ \t]*$/gm;
  for (const match of markdown.matchAll(pattern)) {
    const id = pageIdFromUrl(match[1]);
    if (!id || match.index === undefined) continue;
    tags.push({ id, tag: match[0].trimEnd(), start: match.index, end: match.index + match[0].trimEnd().length });
  }
  return tags;
}

function stableNotionFileUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("x-amz-") || lower === "awsaccesskeyid" || lower === "signature" || lower === "expires") {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

function stableBlockValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableBlockValue);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const hostedFile = object.type === "file" && object.file && typeof object.file === "object"
    ? object.file as Record<string, unknown>
    : undefined;
  if (hostedFile && typeof hostedFile.url === "string") {
    const normalizedFile = Object.fromEntries(
      Object.entries(hostedFile)
        .filter(([key]) => key !== "expiry_time")
        .map(([key, item]) => [key, key === "url" ? stableNotionFileUrl(item as string) : stableBlockValue(item)])
    );
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, key === "file" ? normalizedFile : stableBlockValue(item)])
    );
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, stableBlockValue(item)]));
}

function blockSnapshot(block: DirectBlock): unknown {
  return {
    id: canonicalId(block.id),
    type: block.type,
    parent: stableBlockValue(block.parent ?? null),
    content: stableBlockValue(block[block.type] ?? null),
  };
}

function snapshots(blocks: DirectBlock[]): string {
  return JSON.stringify(blocks.map(blockSnapshot));
}

function childPageIds(blocks: DirectBlock[]): string[] {
  return blocks.filter((block) => block.type === "child_page").map((block) => canonicalId(block.id));
}

function expectedBlocksAfterReorder(blocks: DirectBlock[], desiredOrder: string[]): DirectBlock[] {
  const pagesById = new Map(
    blocks
      .filter((block) => block.type === "child_page")
      .map((block) => [canonicalId(block.id), block])
  );
  let pageIndex = 0;
  return blocks.map((block) =>
    block.type === "child_page" ? pagesById.get(desiredOrder[pageIndex++])! : block
  );
}

export function planChildPageReorder(
  blocks: DirectBlock[],
  markdown: string,
  orderedPageIds: string[]
): ReorderPlan {
  const current = childPageIds(blocks);
  const desired = orderedPageIds.map(canonicalId);
  if (new Set(desired).size !== desired.length) {
    return { ok: false, code: "duplicate_page_id", message: "ordered_page_ids must contain each direct child page exactly once; duplicate IDs were provided." };
  }
  if (current.length !== desired.length || current.some((id) => !desired.includes(id))) {
    return {
      ok: false,
      code: "invalid_child_page_permutation",
      message: `ordered_page_ids must be a complete permutation of all direct child pages. Current direct child pages: ${current.join(", ") || "none"}.`,
    };
  }

  const childIndexes = blocks.flatMap((block, index) => block.type === "child_page" ? [index] : []);
  if (childIndexes.some((index, offset) => offset > 0 && index !== childIndexes[offset - 1] + 1)) {
    return {
      ok: true,
      supported: false,
      changed: current.join() !== desired.join(),
      current_order: current,
      desired_order: desired,
      reason: "Direct child pages are separated by other blocks. Only one contiguous child_page region can be reordered without touching intervening content.",
    };
  }

  const tags = topLevelPageTags(markdown);
  const uniqueTagIds = new Set(tags.map((tag) => tag.id));
  if (tags.length !== current.length || uniqueTagIds.size !== tags.length || tags.some((tag, index) => tag.id !== current[index])) {
    return {
      ok: true,
      supported: false,
      changed: current.join() !== desired.join(),
      current_order: current,
      desired_order: desired,
      reason: "Enhanced Markdown does not contain one unique, unchanged top-level <page> tag for each direct child page in the actual block order.",
    };
  }

  if (tags.length > 1) {
    for (let index = 1; index < tags.length; index += 1) {
      if (!/^\s*$/.test(markdown.slice(tags[index - 1].end, tags[index].start))) {
        return {
          ok: true,
          supported: false,
          changed: current.join() !== desired.join(),
          current_order: current,
          desired_order: desired,
          reason: "The direct child-page tags are not one contiguous Markdown region; content appears between them.",
        };
      }
    }
  }

  const changed = current.some((id, index) => id !== desired[index]);
  if (!changed) {
    return { ok: true, supported: true, changed: false, current_order: current, desired_order: desired };
  }
  const separators = tags.slice(1).map((tag, index) => markdown.slice(tags[index].end, tag.start));
  const tagById = new Map(tags.map((tag) => [tag.id, tag.tag]));
  const oldStr = markdown.slice(tags[0].start, tags[tags.length - 1].end);
  const newStr = desired.map((id, index) => `${index ? separators[index - 1] : ""}${tagById.get(id)}`).join("");
  return {
    ok: true,
    supported: true,
    changed: true,
    current_order: current,
    desired_order: desired,
    old_str: oldStr,
    new_str: newStr,
  };
}

async function listAllChildren(notion: Awaited<ReturnType<typeof getClient>>, pageId: string): Promise<DirectBlock[]> {
  const results: DirectBlock[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await notion.blocks.children.list({ block_id: pageId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    results.push(...(page.results as DirectBlock[]));
    if (!page.has_more) return results;
    if (!page.next_cursor || seen.has(page.next_cursor)) {
      throw new IncompleteChildrenError("Notion returned an incomplete or repeating child-block cursor; no write was attempted.");
    }
    seen.add(page.next_cursor);
    cursor = page.next_cursor;
  }
}

async function readPlanningState(notion: Awaited<ReturnType<typeof getClient>>, pageId: string) {
  const [blocks, markdownResponse] = await Promise.all([
    listAllChildren(notion, pageId),
    notion.pages.retrieveMarkdown({ page_id: pageId }),
  ]);
  const response = markdownResponse as { markdown?: unknown; truncated?: unknown; unknown_block_ids?: unknown };
  if (typeof response.markdown !== "string" || response.truncated !== false || !Array.isArray(response.unknown_block_ids) || response.unknown_block_ids.length > 0) {
    throw new IncompleteChildrenError("The page Markdown is truncated, incomplete, or contains unknown blocks; no write was attempted.");
  }
  return { blocks, markdown: response.markdown };
}

const Params = z.object({
  page_id: notionId(),
  ordered_page_ids: z.array(notionId()).min(1),
  dry_run: z.boolean().default(true),
});

register({
  name: "reorder_child_pages",
  access: "write",
  domain: "pages",
  description: "Reorder one contiguous region containing all direct child pages under the same parent. Defaults to a dry run and never rewrites the full page.",
  batchable: false,
  schema: Params,
  example: { page_id: "<parent-page-id>", ordered_page_ids: ["<child-page-2>", "<child-page-1>"], dry_run: true },
  handler: tryHandler(async ({ page_id, ordered_page_ids, dry_run }) => {
    const notion = await getClient();
    let initial;
    try {
      initial = await readPlanningState(notion, page_id);
    } catch (error) {
      if (error instanceof IncompleteChildrenError) return { ok: false, error: { code: "incomplete_page_state", message: error.message } };
      throw error;
    }
    const plan = planChildPageReorder(initial.blocks, initial.markdown, ordered_page_ids);
    if (!plan.ok) return { ok: false, error: { code: plan.code, message: plan.message } };
    if (dry_run) return { ok: true, data: plan };
    if (!plan.supported) return { ok: false, error: { code: "unsupported_child_page_layout", message: plan.reason } };
    if (!plan.changed) return { ok: true, data: plan };

    let latest;
    try {
      latest = await readPlanningState(notion, page_id);
    } catch (error) {
      if (error instanceof IncompleteChildrenError) return { ok: false, error: { code: "incomplete_page_state", message: error.message } };
      throw error;
    }
    const latestPlan = planChildPageReorder(latest.blocks, latest.markdown, ordered_page_ids);
    if (
      !latestPlan.ok ||
      !latestPlan.supported ||
      !latestPlan.changed ||
      latestPlan.old_str !== plan.old_str ||
      latestPlan.new_str !== plan.new_str ||
      snapshots(initial.blocks) !== snapshots(latest.blocks)
    ) {
      return { ok: false, error: { code: "concurrent_page_change", message: "The parent page or its direct children changed after planning; no write was attempted. Retry from the current state." } };
    }

    await notion.pages.updateMarkdown(asSdk<UpdatePageMarkdownBody>({
      page_id,
      type: "update_content",
      update_content: {
        content_updates: [{ old_str: plan.old_str, new_str: plan.new_str }],
        allow_deleting_content: false,
      },
    }));

    try {
      const after = await listAllChildren(notion, page_id);
      const actualOrder = childPageIds(after);
      const expectedAfter = expectedBlocksAfterReorder(initial.blocks, plan.desired_order);
      if (actualOrder.join() !== plan.desired_order.join() || snapshots(after) !== snapshots(expectedAfter)) {
        return {
          ok: false,
          error: {
            code: "post_write_verification_failed",
            message: "Notion accepted the reorder write, but the resulting child-page order or another direct block did not match the verified plan. The write already occurred; inspect the page before retrying.",
          },
        };
      }
      return { ok: true, data: { ...plan, actual_order: actualOrder } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "post_write_verification_failed",
          message: `Notion accepted the reorder write, but verification could not complete. The write already occurred; inspect the page before retrying. ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }),
});
