#!/usr/bin/env -S npx tsx
/**
 * Mini Comet — local MCP server for OpenCode.
 * Speaks MCP over stdio. Exposes Playwright-backed browser tools with
 * three session-sharing modes (ephemeral / persistent / cdp), multi-tab
 * read + single-tab write, and an auto-pause/resume handoff protocol.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { BrowserSession, configFromEnv } from "./browser.js";
import { dispatch, toolDescriptors } from "./tools.js";

async function main() {
  const cfg = configFromEnv();
  console.error(
    `[mini-comet] mode=${cfg.mode} headless=${cfg.headless} ` +
      (cfg.mode === "persistent" ? `profile=${cfg.profileDir} ` : "") +
      (cfg.mode === "cdp" ? `cdp=${cfg.cdpUrl} ` : "") +
      `marker=${cfg.tabMarker}`,
  );

  const session = new BrowserSession(cfg);

  const server = new Server(
    { name: "opencode-browser-agent", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDescriptors.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const result = await dispatch(session, name, args);
    return result as unknown as { [k: string]: unknown };
  });

  const shutdown = async (code = 0) => {
    try {
      await session.close();
    } catch {}
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (e) => {
    console.error("[mini-comet] uncaughtException:", e);
    void shutdown(1);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mini-comet] MCP server ready on stdio");
}

main().catch((e) => {
  console.error("[mini-comet] fatal:", e);
  process.exit(1);
});
