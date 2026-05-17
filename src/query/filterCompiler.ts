import { resolvePropertyName } from "./schemaInspector.js";
import { DatabaseWhere, OrderBy, SimpleFilter } from "./types.js";

const TEXT_TYPES = new Set(["title", "rich_text", "url", "email", "phone_number"]);
const OPTION_TYPES = new Set(["select", "status"]);
const TIME_TYPES = new Set(["created_time", "last_edited_time"]);

export interface ValidationFinding {
  level: "error" | "warning";
  message: string;
}

function isCompound(where: DatabaseWhere): where is { and?: DatabaseWhere[]; or?: DatabaseWhere[] } {
  return typeof where === "object" && where !== null && ("and" in where || "or" in where);
}

function compileSimpleFilter(properties: Record<string, any>, filter: SimpleFilter): any {
  const propertyName = resolvePropertyName(properties, filter.property);
  if (!propertyName) {
    throw new Error(`Unknown database property: ${filter.property}`);
  }

  const propertyType = properties[propertyName]?.type;
  const op = filter.op;
  const value = filter.value;

  if (op === "is_empty" || op === "is_not_empty") {
    return { property: propertyName, [propertyType]: { [op]: true } };
  }

  if (TEXT_TYPES.has(propertyType)) {
    if (!["equals", "does_not_equal", "contains", "does_not_contain", "starts_with", "ends_with"].includes(op)) {
      throw new Error(`Operator ${op} is not supported for ${propertyType} property ${propertyName}`);
    }
    return { property: propertyName, [propertyType]: { [op]: String(value ?? "") } };
  }

  if (OPTION_TYPES.has(propertyType)) {
    if (!["equals", "does_not_equal"].includes(op)) {
      throw new Error(`Operator ${op} is not supported for ${propertyType} property ${propertyName}`);
    }
    return { property: propertyName, [propertyType]: { [op]: String(value ?? "") } };
  }

  if (propertyType === "multi_select") {
    if (!["contains", "does_not_contain"].includes(op)) {
      throw new Error(`Operator ${op} is not supported for multi_select property ${propertyName}`);
    }
    return { property: propertyName, multi_select: { [op]: String(value ?? "") } };
  }

  if (propertyType === "checkbox") {
    if (!["equals", "does_not_equal"].includes(op)) {
      throw new Error(`Operator ${op} is not supported for checkbox property ${propertyName}`);
    }
    return { property: propertyName, checkbox: { [op]: Boolean(value) } };
  }

  if (propertyType === "number") {
    if (!["equals", "does_not_equal", "greater_than", "less_than", "greater_than_or_equal_to", "less_than_or_equal_to"].includes(op)) {
      throw new Error(`Operator ${op} is not supported for number property ${propertyName}`);
    }
    return { property: propertyName, number: { [op]: Number(value) } };
  }

  if (propertyType === "date") {
    if (!["equals", "before", "after", "on_or_before", "on_or_after"].includes(op)) {
      throw new Error(`Operator ${op} is not supported for date property ${propertyName}`);
    }
    return { property: propertyName, date: { [op]: String(value ?? "") } };
  }

  if (TIME_TYPES.has(propertyType)) {
    if (!["before", "after", "on_or_before", "on_or_after"].includes(op)) {
      throw new Error(`Operator ${op} is not supported for timestamp property ${propertyName}`);
    }
    return { timestamp: propertyType, [propertyType]: { [op]: String(value ?? "") } };
  }

  throw new Error(`Filtering for property type ${propertyType} is not supported yet: ${propertyName}`);
}

export function compileWhere(properties: Record<string, any>, where: DatabaseWhere | undefined): any | undefined {
  if (!where) return undefined;

  if (isCompound(where)) {
    if (where.and) return { and: where.and.map((item) => compileWhere(properties, item)) };
    if (where.or) return { or: where.or.map((item) => compileWhere(properties, item)) };
  }

  return compileSimpleFilter(properties, where as SimpleFilter);
}

export function compileSorts(properties: Record<string, any>, orderBy: OrderBy[] | undefined): any[] | undefined {
  if (!orderBy?.length) return undefined;

  return orderBy.map((sort) => {
    if (sort.timestamp) {
      return { timestamp: sort.timestamp, direction: sort.direction };
    }

    if (!sort.property) throw new Error("order_by entries require either property or timestamp");
    const propertyName = resolvePropertyName(properties, sort.property);
    if (!propertyName) throw new Error(`Unknown database property in order_by: ${sort.property}`);
    return { property: propertyName, direction: sort.direction };
  });
}

export function validateQueryInput(
  properties: Record<string, any>,
  where: DatabaseWhere | undefined,
  orderBy: OrderBy[] | undefined,
  selectedProperties: string[] | undefined
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  try {
    compileWhere(properties, where);
  } catch (error) {
    findings.push({ level: "error", message: error instanceof Error ? error.message : String(error) });
  }

  try {
    compileSorts(properties, orderBy);
  } catch (error) {
    findings.push({ level: "error", message: error instanceof Error ? error.message : String(error) });
  }

  for (const property of selectedProperties ?? []) {
    if (!resolvePropertyName(properties, property)) {
      findings.push({ level: "error", message: `Unknown selected property: ${property}` });
    }
  }

  if (!where) {
    findings.push({ level: "warning", message: "No where filter provided. This may scan the full database." });
  }

  return findings;
}
