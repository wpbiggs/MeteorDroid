// MVP smoke test — drives the MCP server over stdio the same way OpenCode would.
import { spawn } from "node:child_process";

const proc = spawn("npx", ["tsx", "src/server.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, MINI_COMET_HEADLESS: "1" },
});

let buf = "";
const pending = new Map<number, (msg: any) => void>();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function call(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method: string, params: unknown = {}) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

(async () => {
  // 1. initialize handshake
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mvp-smoke", version: "0" },
  });
  console.log("initialize ✓", init.result.serverInfo);
  notify("notifications/initialized");

  // 2. open https://example.com
  const open = await call("tools/call", {
    name: "browser_open_url",
    arguments: { url: "https://example.com" },
  });
  console.log("\nbrowser_open_url ✓");
  console.log(open.result.content[0].text);

  // 3. extract page text
  const text = await call("tools/call", {
    name: "browser_get_page_text",
    arguments: { max_chars: 800 },
  });
  console.log("\nbrowser_get_page_text ✓");
  const parsed = JSON.parse(text.result.content[0].text);
  console.log("title:", parsed.title);
  console.log("url:  ", parsed.url);
  console.log("len:  ", parsed.fullLength, "(truncated:", parsed.truncated + ")");
  console.log("---- text ----");
  console.log(parsed.text);
  console.log("--------------");

  // 4. test the safety guard — should refuse without confirm
  const refused = await call("tools/call", {
    name: "browser_click",
    arguments: { selector_or_text: "Place Order" },
  });
  console.log("\nsafety guard ✓ (expected refusal):");
  console.log(refused.result.content[0].text);

  // 5. close
  const closed = await call("tools/call", {
    name: "browser_close",
    arguments: {},
  });
  console.log("\nbrowser_close ✓", closed.result.content[0].text);

  proc.kill();
  process.exit(0);
})().catch((e) => {
  console.error("smoke FAILED:", e);
  proc.kill();
  process.exit(1);
});
