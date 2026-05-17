import assert from "node:assert/strict";
import { test } from "node:test";
import { compileWhere, validateQueryInput } from "./filterCompiler.js";

const properties = {
  Task: { id: "title-id", type: "title" },
  Status: { id: "status-id", type: "status" },
  Done: { id: "done-id", type: "checkbox" },
};

test("compileWhere compiles simple structured filters", () => {
  assert.deepEqual(compileWhere(properties, { property: "Status", op: "equals", value: "Ready" }), {
    property: "Status",
    status: { equals: "Ready" },
  });

  assert.deepEqual(compileWhere(properties, { property: "done-id", op: "equals", value: true }), {
    property: "Done",
    checkbox: { equals: true },
  });
});

test("validateQueryInput reports unknown properties", () => {
  const findings = validateQueryInput(
    properties,
    { property: "Missing", op: "equals", value: "x" },
    undefined,
    ["Task", "Other"]
  );

  assert.equal(findings.some((finding) => finding.level === "error"), true);
});
