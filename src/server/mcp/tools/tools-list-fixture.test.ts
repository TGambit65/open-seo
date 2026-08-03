import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import fixture from "@/server/mcp/fixtures/tools-list.brutal-audit.json";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

import { registerOpenSeoMcpTools } from "@/server/mcp/server";

const AUDIT_TOOL_NAMES = fixture.tools.map((tool) => tool.name);

function keys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).toSorted();
}

it("matches the checked-in Brutal audit tools/list fixture", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server: McpServer = new McpServer({ name: "fixture", version: "1" });
  registerOpenSeoMcpTools(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "1" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const result = await client.listTools();
  const normalized = result.tools
    .filter((tool) => AUDIT_TOOL_NAMES.includes(tool.name))
    .map((tool) => ({
      name: tool.name,
      inputProperties: keys(tool.inputSchema.properties),
      inputRequired: [...(tool.inputSchema.required ?? [])].toSorted(),
      outputProperties: keys(tool.outputSchema?.properties),
      outputRequired: [...(tool.outputSchema?.required ?? [])].toSorted(),
      annotations: {
        readOnlyHint: tool.annotations?.readOnlyHint ?? false,
        destructiveHint: tool.annotations?.destructiveHint ?? true,
        openWorldHint: tool.annotations?.openWorldHint ?? true,
      },
    }));

  expect(normalized).toEqual(fixture.tools);
  await client.close();
});
