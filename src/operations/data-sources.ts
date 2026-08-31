import { z } from "zod";
import { isFullDatabase } from "@notionhq/client";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimDataSource } from "../utils/slim.js";
import { DATA_SOURCE_PROPERTY_UPDATE_SCHEMA } from "../schema/database.js";
import { asSdk, type UpdateDataSourceBody } from "../utils/notion-types.js";

const VERBOSE = z.boolean().optional();

const ListDataSourcesParams = z.object({
  database_id: z.string().describe("Database ID to list data sources for."),
  verbose: VERBOSE,
});

register({
  name: "list_data_sources",
  access: "read",
  domain: "data_sources",
  description: "List data sources under a database. Use this before query_database when targeting multi-source databases.",
  batchable: false,
  schema: ListDataSourcesParams,
  example: { database_id: "<database-id>" },
  handler: tryHandler(async ({ database_id, verbose }) => {
    const notion = await getClient();
    const db = await notion.databases.retrieve({ database_id });
    const sources = isFullDatabase(db) ? db.data_sources : [];
    return {
      ok: true,
      data: verbose
        ? { database_id, data_sources: sources }
        : {
            database_id,
            data_sources: sources.map((s) => ({ id: s.id, name: s.name })),
          },
    };
  }),
});

const GetDataSourceParams = z.object({
  data_source_id: z.string(),
  verbose: VERBOSE,
});

function decodePropertyRef(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

function getDataSourceProperties(ds: unknown): Record<string, unknown> {
  if (typeof ds !== "object" || ds === null) return {};
  const properties = (ds as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return {};
  return properties as Record<string, unknown>;
}

function propertyId(property: unknown): string | undefined {
  if (typeof property !== "object" || property === null) return undefined;
  const id = (property as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function matchesPropertyRef(currentName: string, property: unknown, ref: string): boolean {
  const decodedRef = decodePropertyRef(ref);
  const id = propertyId(property);
  return currentName === ref || currentName === decodedRef || id === ref || id === decodedRef;
}

function findPropertyByRef(
  properties: Record<string, unknown>,
  ref: string
): { currentName: string; id?: string } | undefined {
  for (const [currentName, property] of Object.entries(properties)) {
    if (matchesPropertyRef(currentName, property, ref)) {
      return { currentName, id: propertyId(property) };
    }
  }
  return undefined;
}

function collectRenameRequests(
  properties: Record<string, unknown> | undefined
): { property: string; name: string }[] {
  if (!properties) return [];
  return Object.entries(properties).flatMap(([property, config]) => {
    if (typeof config !== "object" || config === null) return [];
    const name = (config as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? [{ property, name }] : [];
  });
}

async function verifyRenameRequests(
  data_source_id: string,
  renames: { property: string; name: string }[]
): Promise<{ ok: true; dataSource: unknown } | { ok: false; property: string; name: string }> {
  const notion = await getClient();
  const ds = await notion.dataSources.retrieve({ data_source_id });
  const properties = getDataSourceProperties(ds);
  for (const rename of renames) {
    const byNewName = findPropertyByRef(properties, rename.name);
    const byOriginalRef = findPropertyByRef(properties, rename.property);
    if (byNewName && (!byOriginalRef || byOriginalRef.currentName === rename.name || byOriginalRef.id === byNewName.id)) {
      continue;
    }
    return { ok: false, ...rename };
  }
  return { ok: true, dataSource: ds };
}

register({
  name: "get_data_source",
  access: "read",
  domain: "data_sources",
  description: "Retrieve a single data source's schema (its property definitions and parent database).",
  batchable: true,
  schema: GetDataSourceParams,
  example: { data_source_id: "<data-source-id>" },
  exampleBatch: { items: [{ data_source_id: "<ds-1>" }, { data_source_id: "<ds-2>" }] },
  handler: tryHandler(async ({ data_source_id, verbose }) => {
    const notion = await getClient();
    const ds = await notion.dataSources.retrieve({ data_source_id });
    return { ok: true, data: slimDataSource(ds, verbose ?? false) };
  }),
});

const ListDataSourceTemplatesParams = z.object({
  data_source_id: z.string().describe("Data source ID to list templates for."),
  name: z.string().optional().describe("Case-insensitive substring filter on template name."),
  start_cursor: z.string().optional(),
  page_size: z.number().int().min(1).max(100).optional(),
});

register({
  name: "list_data_source_templates",
  access: "read",
  domain: "data_sources",
  description: "List the page templates available for a data source. Returns {id, name, is_default} per template. Pass a returned id as template.template_id to create_page to apply it.",
  batchable: false,
  schema: ListDataSourceTemplatesParams,
  example: { data_source_id: "<data-source-id>" },
  handler: tryHandler(async ({ data_source_id, name, start_cursor, page_size }) => {
    const notion = await getClient();
    const res = await notion.dataSources.listTemplates({
      data_source_id,
      ...(name !== undefined ? { name } : {}),
      ...(start_cursor !== undefined ? { start_cursor } : {}),
      ...(page_size !== undefined ? { page_size } : {}),
    });
    return {
      ok: true,
      data: { data_source_id, templates: res.templates },
    };
  }),
});

const UpdateDataSourceParams = z.object({
  data_source_id: z.string(),
  title: z.array(z.unknown()).optional().describe("Rich text array for the data source title."),
  properties: z.record(z.string(), DATA_SOURCE_PROPERTY_UPDATE_SCHEMA).optional(),
  icon: z.unknown().optional(),
  archived: z.boolean().optional().describe("Deprecated alias for in_trash (removed on the 2026-03-11 surface). Routed to in_trash."),
  in_trash: z.boolean().optional(),
  verbose: VERBOSE,
});

register({
  name: "update_data_source",
  access: "write",
  domain: "data_sources",
  description: "Update a data source's schema (properties, title, icon). Property updates may include name for renames. For database-level metadata use update_database.",
  batchable: true,
  schema: UpdateDataSourceParams,
  example: {
    data_source_id: "<data-source-id>",
    properties: {
      "Old property name or ID": { name: "New property name" },
      Status: { type: "status", status: { options: [] } },
    },
  },
  handler: tryHandler(async ({ data_source_id, title, properties, icon, archived, in_trash, verbose }) => {
    const notion = await getClient();
    const renames = collectRenameRequests(properties);
    // `archived` was removed on the 2026-03-11 surface; route the legacy alias
    // into `in_trash` so we never send a field the API rejects.
    const trash = in_trash ?? archived;
    const body = {
      data_source_id,
      ...(title !== undefined ? { title } : {}),
      ...(properties !== undefined ? { properties } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(trash !== undefined ? { in_trash: trash } : {}),
    };
    const response = await notion.dataSources.update(asSdk<UpdateDataSourceBody>(body));
    let data = response;
    if (renames.length > 0) {
      const verified = await verifyRenameRequests(data_source_id, renames);
      if (!verified.ok) {
        return {
          ok: false,
          error: {
            code: "rename_not_verified",
            message: `Notion accepted update_data_source, but property "${verified.property}" was not verified as "${verified.name}".`,
            fix: "Use rename_data_source_property for a focused rename, then call get_data_source with verbose:true to inspect the current schema.",
          },
        };
      }
      data = verified.dataSource as typeof response;
    }
    return { ok: true, data: slimDataSource(data, verbose ?? false) };
  }),
});

const RenameDataSourcePropertyParams = z.object({
  data_source_id: z.string(),
  property: z
    .string()
    .describe("Existing property name or property ID. Encoded Notion property IDs such as %7CcNF are accepted."),
  name: z.string().min(1).describe("New property name as it should appear in Notion."),
  verbose: VERBOSE,
});

register({
  name: "rename_data_source_property",
  access: "write",
  domain: "data_sources",
  description: "Rename one data source property by existing property name or ID, then verify the schema changed. Does not alter property type or options.",
  batchable: true,
  schema: RenameDataSourcePropertyParams,
  example: {
    data_source_id: "<data-source-id>",
    property: "Pipeline-Stufe",
    name: "Phase",
  },
  exampleBatch: {
    items: [
      { data_source_id: "<data-source-id>", property: "Pipeline-Stufe", name: "Phase" },
      { data_source_id: "<data-source-id>", property: "%7CcNF", name: "Phase" },
    ],
  },
  handler: tryHandler(async ({ data_source_id, property, name, verbose }) => {
    const notion = await getClient();
    await notion.dataSources.update(
      asSdk<UpdateDataSourceBody>({
        data_source_id,
        properties: {
          [property]: { name },
        },
      })
    );
    const verified = await verifyRenameRequests(data_source_id, [{ property, name }]);
    if (!verified.ok) {
      return {
        ok: false,
        error: {
          code: "rename_not_verified",
          message: `Notion accepted the rename request, but property "${property}" was not verified as "${name}".`,
          fix: "Call get_data_source with verbose:true and retry with the exact current property name or property ID.",
        },
      };
    }
    return {
      ok: true,
      data: verbose
        ? verified.dataSource
        : {
            data_source_id,
            property,
            name,
            verified: true,
          },
    };
  }),
});
