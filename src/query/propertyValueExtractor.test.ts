import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPropertyValue, extractRowValues } from "./propertyValueExtractor.js";

test("extractPropertyValue returns compact primitive values", () => {
  assert.equal(
    extractPropertyValue({
      type: "title",
      title: [{ plain_text: "Feature Step" }],
    }),
    "Feature Step"
  );

  assert.equal(
    extractPropertyValue({
      type: "status",
      status: { name: "Ready" },
    }),
    "Ready"
  );

  assert.deepEqual(
    extractPropertyValue({
      type: "multi_select",
      multi_select: [{ name: "PO" }, { name: "UX" }],
    }),
    ["PO", "UX"]
  );
});

test("extractRowValues resolves selected property names", () => {
  const values = extractRowValues(
    {
      properties: {
        Task: { type: "title", title: [{ plain_text: "Review scope" }] },
        Done: { type: "checkbox", checkbox: false },
      },
    },
    {
      Task: { id: "title-id", type: "title" },
      Done: { id: "done-id", type: "checkbox" },
    },
    ["Task", "done-id"]
  );

  assert.deepEqual(values, {
    Task: "Review scope",
    Done: false,
  });
});
