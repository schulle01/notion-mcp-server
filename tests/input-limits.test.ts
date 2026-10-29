import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import http from "node:http";

const { dispatchStub } = vi.hoisted(() => ({ dispatchStub: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock("../src/dispatch/index.js", () => ({ dispatch: dispatchStub }));
vi.mock("../src/services/notion.js", () => ({ getClient: async () => ({ users: { me: async () => ({ id: "test" }) } }) }));
import { initOperations } from "../src/operations/index.js";
import { createServer } from "../src/server/index.js";
import { startHttp } from "../src/server/http.js";
import { parseHttpConfig } from "../src/config/http.js";
import { maxToolInputElements } from "../src/config/input-limits.js";

beforeAll(initOperations);
afterEach(() => { vi.unstubAllEnvs(); dispatchStub.mockClear(); });

it("uses positive integer defaults and rejects invalid explicit settings", () => {
  expect(maxToolInputElements({})).toBe(100_000);
  expect(parseHttpConfig({}).maxRequestBodySize).toBe(1_048_576);
  expect(maxToolInputElements({ MCP_MAX_TOOL_INPUT_ELEMENTS: "123" })).toBe(123);
  expect(parseHttpConfig({ MCP_MAX_REQUEST_BODY_SIZE: "2048" }).maxRequestBodySize).toBe(2048);
  for (const raw of ["", "0", "-1", "1.5", "Infinity", "NaN", "123abc", "9007199254740992"]) {
    expect(() => maxToolInputElements({ MCP_MAX_TOOL_INPUT_ELEMENTS: raw })).toThrow(/MCP_MAX_TOOL_INPUT_ELEMENTS/);
    expect(() => parseHttpConfig({ MCP_MAX_REQUEST_BODY_SIZE: raw })).toThrow(/MCP_MAX_REQUEST_BODY_SIZE/);
  }
  vi.stubEnv("MCP_MAX_TOOL_INPUT_ELEMENTS", "0");
  expect(createServer).toThrow(/MCP_MAX_TOOL_INPUT_ELEMENTS/);
});

for (const modern of [false, true]) describe(`shared stdio factory (${modern ? "2026" : "2025"})`, () => {
  async function connect() {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport, legacy: "serve" });
    const client = new Client({ name: "limits", version: "0" }, modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
    await client.connect(clientTransport);
    return { client, close: async () => { await client.close(); await handle.close(); } };
  }

  it("accepts the exact element boundary and refuses one more before dispatch", async () => {
    vi.stubEnv("MCP_MAX_TOOL_INPUT_ELEMENTS", "10");
    const c = await connect();
    try {
      // Two argument keys + one payload key + seven array items = ten.
      const args = { operation: "append_blocks", payload: { items: Array(7).fill(null) } };
      expect((await c.client.callTool({ name: "notion_write", arguments: args })).isError).not.toBe(true);
      expect(dispatchStub).toHaveBeenCalledTimes(1);
      const refused = await c.client.callTool({ name: "notion_write", arguments: { ...args, payload: { items: Array(8).fill(null) } } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("maximum of 10 elements");
      expect(dispatchStub).toHaveBeenCalledTimes(1);
    } finally { await c.close(); }
  });

  it("allows a legitimate deeply nested two-item block batch under the default", async () => {
    const rich_text = Array.from({ length: 100 }, () => ({ type: "text", text: { content: "x" } }));
    const children = Array.from({ length: 100 }, () => ({ object: "block", type: "paragraph", paragraph: { rich_text } }));
    const c = await connect();
    try {
      const payload = { items: [{ block_id: "page-a", children }, { block_id: "page-b", children }] };
      const result = await c.client.callTool({ name: "notion_write", arguments: { operation: "append_blocks", payload } });
      expect(result.isError).not.toBe(true);
      expect(dispatchStub).toHaveBeenCalledWith("append_blocks", payload);
    } finally { await c.close(); }
  });
});

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "limit", version: "0" } } };
const modernList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "limit", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } } };
function post(port: number, body: string, contentLength: boolean) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(body.includes("io.modelcontextprotocol/protocolVersion") ? { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" } : {}),
      ...(contentLength ? { "content-length": Buffer.byteLength(body) } : {}),
    } }, res => { let text = ""; res.on("data", c => text += c); res.on("end", () => resolve({ status: res.statusCode!, text })); });
    req.on("error", reject);
    req.write(body.slice(0, body.length / 2));
    req.end(body.slice(body.length / 2));
  });
}
it.each([true, false])("caps native HTTP bytes before parsing with content-length=%s in both eras", async contentLength => {
  const cap = 1024;
  const server = await startHttp(parseHttpConfig({ MCP_TRANSPORT: "http", PORT: "0", MCP_MAX_REQUEST_BODY_SIZE: String(cap) }));
  try {
    for (const body of [init, modernList]) {
      const raw = JSON.stringify(body);
      const exact = raw + " ".repeat(cap - Buffer.byteLength(raw));
      const allowed = await post(server.port, exact, contentLength);
      expect(allowed.status).toBe(200);
      const refused = await post(server.port, exact + " ", contentLength);
      expect(refused.status).toBe(413);
      expect(JSON.parse(refused.text).error.message).toBe("Request body too large");
    }
  } finally { await server.close(); }
});

it.each([true, false])("answers 413 before an oversized upload ends (content-length=%s)", async contentLength => {
  const cap = 1024;
  const server = await startHttp(parseHttpConfig({ MCP_TRANSPORT: "http", PORT: "0", MCP_MAX_REQUEST_BODY_SIZE: String(cap) }));
  try {
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.port, path: "/mcp", method: "POST", headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(contentLength ? { "content-length": cap + 1 } : {}),
      } }, res => {
        let text = "";
        res.on("data", chunk => text += chunk);
        res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode!, text }); });
      });
      const timer = setTimeout(() => { req.destroy(); reject(new Error("413 waited for request.end()")); }, 1500);
      req.on("error", err => { clearTimeout(timer); reject(err); });
      // Intentionally no req.end(): declared size alone must reject; chunked
      // streaming must reject as soon as the actual bytes cross the limit.
      req.write(contentLength ? "{" : "x".repeat(cap + 1));
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.text).error.message).toBe("Request body too large");
  } finally { await server.close(); }
});
