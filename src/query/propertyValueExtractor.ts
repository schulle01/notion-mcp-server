import { getTitlePropertyName, resolvePropertyName } from "./schemaInspector.js";

export interface ExtractOptions {
  maxStringLength?: number;
}

function truncate(value: string, maxStringLength: number): string {
  if (value.length <= maxStringLength) return value;
  return `${value.slice(0, maxStringLength)}...`;
}

function richTextToString(items: any[], maxStringLength: number): string {
  return truncate(items.map((item) => item?.plain_text ?? "").join(""), maxStringLength);
}

function formulaValue(formula: any, maxStringLength: number): unknown {
  switch (formula?.type) {
    case "string":
      return formula.string === null ? null : truncate(String(formula.string), maxStringLength);
    case "number":
      return formula.number;
    case "boolean":
      return formula.boolean;
    case "date":
      return formula.date;
    default:
      return null;
  }
}

function rollupValue(rollup: any, maxStringLength: number): unknown {
  switch (rollup?.type) {
    case "number":
      return rollup.number;
    case "date":
      return rollup.date;
    case "array":
      return Array.isArray(rollup.array)
        ? rollup.array.map((item: any) => extractPropertyValue(item, { maxStringLength }))
        : [];
    case "unsupported":
    case "incomplete":
    default:
      return null;
  }
}

export function extractPropertyValue(property: any, options: ExtractOptions = {}): unknown {
  const maxStringLength = options.maxStringLength ?? 500;
  if (!property) return null;

  switch (property.type) {
    case "title":
      return richTextToString(property.title ?? [], maxStringLength);
    case "rich_text":
      return richTextToString(property.rich_text ?? [], maxStringLength);
    case "number":
      return property.number;
    case "select":
      return property.select?.name ?? null;
    case "status":
      return property.status?.name ?? null;
    case "multi_select":
      return Array.isArray(property.multi_select) ? property.multi_select.map((item: any) => item.name) : [];
    case "date":
      return property.date ? { start: property.date.start, end: property.date.end ?? null } : null;
    case "people":
      return Array.isArray(property.people)
        ? property.people.map((person: any) => person.name ?? person.id).filter(Boolean)
        : [];
    case "files":
      return Array.isArray(property.files)
        ? property.files.map((file: any) => file.name ?? file.external?.url ?? file.file?.url).filter(Boolean)
        : [];
    case "checkbox":
      return property.checkbox;
    case "url":
      return property.url ?? null;
    case "email":
      return property.email ?? null;
    case "phone_number":
      return property.phone_number ?? null;
    case "formula":
      return formulaValue(property.formula, maxStringLength);
    case "relation":
      return Array.isArray(property.relation) ? property.relation.map((item: any) => item.id) : [];
    case "rollup":
      return rollupValue(property.rollup, maxStringLength);
    case "created_time":
      return property.created_time;
    case "created_by":
      return property.created_by?.name ?? property.created_by?.id ?? null;
    case "last_edited_time":
      return property.last_edited_time;
    case "last_edited_by":
      return property.last_edited_by?.name ?? property.last_edited_by?.id ?? null;
    case "unique_id":
      return property.unique_id?.number ?? null;
    default:
      return null;
  }
}

export function extractRowValues(
  page: any,
  databaseProperties: Record<string, any>,
  selectedProperties: string[] | undefined,
  options: ExtractOptions = {}
): Record<string, unknown> {
  const names = selectedProperties?.length ? selectedProperties : Object.keys(databaseProperties);
  const values: Record<string, unknown> = {};

  for (const requestedName of names) {
    const propertyName = resolvePropertyName(databaseProperties, requestedName);
    if (!propertyName) continue;
    values[propertyName] = extractPropertyValue(page?.properties?.[propertyName], options);
  }

  return values;
}

export function extractTitle(page: any, databaseProperties: Record<string, any>): string | null {
  const titleProperty = getTitlePropertyName(databaseProperties);
  if (!titleProperty) return null;
  const title = extractPropertyValue(page?.properties?.[titleProperty], { maxStringLength: 200 });
  return typeof title === "string" && title.length > 0 ? title : null;
}
