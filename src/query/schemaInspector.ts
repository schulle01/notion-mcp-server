import { CompactDatabaseInfo, DatabasePropertyInfo } from "./types.js";

const WRITABLE_TYPES = new Set([
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "date",
  "people",
  "files",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "relation",
  "status",
]);

export function getDatabaseTitle(database: any): string {
  const title = database?.title;
  if (Array.isArray(title)) {
    return title.map((item) => item?.plain_text ?? "").join("");
  }
  return "";
}

export function getDatabaseProperties(database: any): Record<string, any> {
  return database?.properties ?? {};
}

export function getTitlePropertyName(properties: Record<string, any>): string | undefined {
  return Object.entries(properties).find(([, property]) => property?.type === "title")?.[0];
}

export function resolvePropertyName(properties: Record<string, any>, nameOrId: string): string | undefined {
  if (properties[nameOrId]) return nameOrId;

  return Object.entries(properties).find(([, property]) => property?.id === nameOrId)?.[0];
}

export function compactPropertyInfo(name: string, property: any): DatabasePropertyInfo {
  const type = property?.type ?? "unknown";
  const info: DatabasePropertyInfo = {
    name,
    id: property?.id,
    type,
    writable: WRITABLE_TYPES.has(type),
  };

  if (type === "select" && Array.isArray(property?.select?.options)) {
    info.options = property.select.options.map((option: any) => option.name);
  } else if (type === "multi_select" && Array.isArray(property?.multi_select?.options)) {
    info.options = property.multi_select.options.map((option: any) => option.name);
  } else if (type === "status" && Array.isArray(property?.status?.options)) {
    info.options = property.status.options.map((option: any) => option.name);
  }

  return info;
}

export function inspectCompactDatabase(database: any): CompactDatabaseInfo {
  const properties = getDatabaseProperties(database);
  return {
    database_id: database.id,
    title: getDatabaseTitle(database),
    properties: Object.entries(properties).map(([name, property]) => compactPropertyInfo(name, property)),
  };
}
