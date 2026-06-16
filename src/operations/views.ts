import { z } from "zod";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimList, slimView } from "../utils/slim.js";
import {
  asSdk,
  type GetViewBody,
  type ListViewsBody,
  type UpdateViewBody,
} from "../utils/notion-types.js";

const VERBOSE = z.boolean().optional();

const ViewPropertyConfig = z.object({
  property_id: z.string(),
  visible: z.boolean().optional(),
  width: z.number().min(0).optional(),
  wrap: z.boolean().optional(),
  status_show_as: z.enum(["select", "checkbox"]).optional(),
  card_property_width_mode: z.enum(["full_line", "inline"]).optional(),
  date_format: z
    .enum(["full", "short", "month_day_year", "day_month_year", "year_month_day", "relative"])
    .optional(),
  time_format: z.enum(["12_hour", "24_hour", "hidden"]).optional(),
});

type ViewPropertyConfigValue = z.infer<typeof ViewPropertyConfig>;
type ViewPropertySlot = "properties" | "table_properties";

const ConfigurableViewTypes = new Set([
  "table",
  "board",
  "list",
  "calendar",
  "timeline",
  "gallery",
  "map",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function viewType(view: unknown): string | undefined {
  const record = asRecord(view);
  const type = record?.type;
  return typeof type === "string" ? type : undefined;
}

function viewConfiguration(view: unknown): Record<string, unknown> | undefined {
  const record = asRecord(view);
  return asRecord(record?.configuration);
}

function viewProperties(config: Record<string, unknown> | undefined, slot: ViewPropertySlot): ViewPropertyConfigValue[] {
  const properties = config?.[slot];
  return Array.isArray(properties) ? (properties as ViewPropertyConfigValue[]) : [];
}

function mergeProperties(
  existing: ViewPropertyConfigValue[],
  desired: ViewPropertyConfigValue[],
  mode: "merge" | "replace"
): ViewPropertyConfigValue[] {
  if (mode === "replace") return desired;

  const desiredById = new Map(desired.map((p) => [p.property_id, p]));
  const seen = new Set<string>();
  const merged = existing.map((current) => {
    const update = desiredById.get(current.property_id);
    if (!update) return current;
    seen.add(current.property_id);
    return { ...current, ...update };
  });
  for (const update of desired) {
    if (!seen.has(update.property_id)) merged.push(update);
  }
  return merged;
}

function verifyProperties(
  actual: ViewPropertyConfigValue[],
  desired: ViewPropertyConfigValue[],
  mode: "merge" | "replace"
): { ok: true } | { ok: false; message: string } {
  if (mode === "replace") {
    const actualIds = actual.map((p) => p.property_id).join(",");
    const desiredIds = desired.map((p) => p.property_id).join(",");
    if (actualIds !== desiredIds) {
      return {
        ok: false,
        message: `Expected property order ${desiredIds}, got ${actualIds}.`,
      };
    }
  }

  const actualById = new Map(actual.map((p) => [p.property_id, p]));
  for (const expected of desired) {
    const current = actualById.get(expected.property_id);
    if (!current) {
      return { ok: false, message: `Property ${expected.property_id} is missing from the view configuration.` };
    }
    for (const key of Object.keys(expected) as (keyof ViewPropertyConfigValue)[]) {
      if (current[key] !== expected[key]) {
        return {
          ok: false,
          message: `Property ${expected.property_id} has ${String(key)}=${String(
            current[key]
          )}, expected ${String(expected[key])}.`,
        };
      }
    }
  }
  return { ok: true };
}

function slimConfiguredView(view: unknown, slot: ViewPropertySlot) {
  const config = viewConfiguration(view);
  return {
    id: asRecord(view)?.id,
    name: asRecord(view)?.name,
    type: viewType(view),
    property_slot: slot,
    properties: viewProperties(config, slot),
    verified: true,
  };
}

const ListViewsParams = z
  .object({
    database_id: z.string().optional(),
    data_source_id: z.string().optional(),
    start_cursor: z.string().optional(),
    page_size: z.number().min(1).max(100).optional(),
    verbose: VERBOSE,
  })
  .refine((v) => Boolean(v.database_id) || Boolean(v.data_source_id), {
    message: "Pass at least one of database_id or data_source_id.",
  });

register({
  name: "list_views",
  description: "List Notion database/data-source views so callers can identify the view_id to inspect or configure.",
  batchable: false,
  schema: ListViewsParams,
  example: {
    data_source_id: "<data-source-id>",
  },
  handler: tryHandler(async ({ database_id, data_source_id, start_cursor, page_size, verbose }) => {
    const notion = await getClient();
    const response = await notion.views.list(
      asSdk<ListViewsBody>({
        ...(database_id !== undefined ? { database_id } : {}),
        ...(data_source_id !== undefined ? { data_source_id } : {}),
        ...(start_cursor !== undefined ? { start_cursor } : {}),
        ...(page_size !== undefined ? { page_size } : {}),
      })
    );
    return {
      ok: true,
      data: slimList(response, (view) => slimView(view as never, verbose ?? false), verbose ?? false),
    };
  }),
});

const GetViewParams = z.object({
  view_id: z.string(),
  verbose: VERBOSE,
});

register({
  name: "get_view",
  description: "Retrieve one Notion view, including its configuration when Notion returns it.",
  batchable: false,
  schema: GetViewParams,
  example: {
    view_id: "<view-id>",
  },
  handler: tryHandler(async ({ view_id, verbose }) => {
    const notion = await getClient();
    const response = await notion.views.retrieve(asSdk<GetViewBody>({ view_id }));
    return { ok: true, data: slimView(response, verbose ?? false) };
  }),
});

const ConfigureViewPropertiesParams = z.object({
  view_id: z.string(),
  properties: z.array(ViewPropertyConfig).min(1),
  mode: z
    .enum(["merge", "replace"])
    .optional()
    .describe("merge preserves existing order; replace sets exactly this property order."),
  property_slot: z
    .enum(["properties", "table_properties"])
    .optional()
    .describe("Use table_properties only for timeline table columns. Defaults to properties."),
  verbose: VERBOSE,
});

register({
  name: "configure_view_properties",
  description: "Set visibility, widths, and ordering for properties in a Notion view, then verify the view configuration.",
  batchable: true,
  schema: ConfigureViewPropertiesParams,
  example: {
    view_id: "<view-id>",
    mode: "merge",
    properties: [
      { property_id: "prop-a", visible: false },
      { property_id: "prop-b", visible: true, width: 220 },
    ],
  },
  handler: tryHandler(async ({ view_id, properties, mode = "merge", property_slot = "properties", verbose }) => {
    const notion = await getClient();
    const current = await notion.views.retrieve(asSdk<GetViewBody>({ view_id }));
    const type = viewType(current);
    if (!type || !ConfigurableViewTypes.has(type)) {
      return {
        ok: false,
        error: {
          code: "view_properties_not_supported",
          message: `View type "${type ?? "unknown"}" does not expose configurable properties through this operation.`,
          fix: "Use get_view with verbose:true to inspect the view. Form, chart, and dashboard views do not use the same properties list.",
        },
      };
    }
    if (property_slot === "table_properties" && type !== "timeline") {
      return {
        ok: false,
        error: {
          code: "invalid_property_slot",
          message: "table_properties is only supported for timeline views.",
          fix: "Use property_slot:'properties' for table, board, list, calendar, gallery, map, and timeline card columns.",
        },
      };
    }

    const currentConfig = viewConfiguration(current) ?? { type };
    const nextProperties = mergeProperties(viewProperties(currentConfig, property_slot), properties, mode);
    await notion.views.update(
      asSdk<UpdateViewBody>({
        view_id,
        configuration: {
          ...currentConfig,
          type,
          [property_slot]: nextProperties,
        },
      })
    );

    const verifiedView = await notion.views.retrieve(asSdk<GetViewBody>({ view_id }));
    const verified = verifyProperties(viewProperties(viewConfiguration(verifiedView), property_slot), properties, mode);
    if (!verified.ok) {
      return {
        ok: false,
        error: {
          code: "view_properties_not_verified",
          message: verified.message,
          fix: "Call get_view with verbose:true to inspect the current view configuration and retry with property IDs from that response.",
        },
      };
    }

    return {
      ok: true,
      data: verbose ? verifiedView : slimConfiguredView(verifiedView, property_slot),
    };
  }),
});
