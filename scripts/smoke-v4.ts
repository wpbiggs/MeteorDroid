// Smoke test for v0.4 — upload, smart locator strategies, wait_for, dom_summary.
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "fixtures/upload-page.html");
const FIXTURE_URL = "file://" + FIXTURE;

// Make a tiny temp file we can upload.
const TMP = path.join(os.tmpdir(), `mc-v4-${Date.now()}.txt`);
fs.writeFileSync(TMP, "hello mini comet v4");

const proc = spawn("npx", ["tsx", "src/server.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    MINI_COMET_MODE: "ephemeral",
    MINI_COMET_HEADLESS: "1",
  },
});

let buf = "";
const pending = new Map<number, (m: any) => void>();
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
const call = (method: string, params: unknown): Promise<any> =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const notify = (m: string, p: unknown = {}) =>
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
const tool = (name: string, args: unknown = {}) =>
  call("tools/call", { name, arguments: args });
const txt = (r: any) => r.result.content[0].text;
const json = (r: any) => JSON.parse(txt(r));

const step = (n: string) => console.log(`\n── ${n} ──`);
const expect = (cond: boolean, label: string) => {
  console.log((cond ? "✓" : "✗") + " " + label);
  if (!cond) {
    proc.kill();
    process.exit(1);
  }
};

(async () => {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-v4", version: "0" },
  });
  notify("notifications/initialized");

  step("1. open fixture");
  const open = json(await tool("browser_open_url", { url: FIXTURE_URL }));
  expect(open.ok, "opened fixture");

  step("2. dom_summary lists interactive elements");
  const sum = json(await tool("browser_dom_summary", { max_items: 50 }));
  expect(sum.count >= 5, `found ${sum.count} interactive elements`);
  const names = sum.items.map((i: any) => i.name);
  expect(
    names.some((n: string) => /Save Draft/.test(n)),
    "summary includes Save Draft button",
  );

  step("3. smart locator: role+name (button)");
  const click1 = json(await tool("browser_click", { selector_or_text: "Save Draft" }));
  expect(click1.strategy?.startsWith("role:button"), `strategy = ${click1.strategy}`);

  step("4. smart locator: role+name (link)");
  const click2 = json(await tool("browser_click", { selector_or_text: "Help Center" }));
  expect(click2.strategy?.startsWith("role:link"), `strategy = ${click2.strategy}`);

  step("5. smart locator: label");
  const typedLabel = json(await tool("browser_type", { selector_or_text: "Email", text: "x@y.z" }));
  expect(typedLabel.strategy === "label" || typedLabel.strategy?.startsWith("role"), `strategy = ${typedLabel.strategy}`);

  step("6. smart locator: placeholder");
  const typedPh = json(await tool("browser_type", { selector_or_text: "Search anything", text: "hi" }));
  expect(typedPh.strategy === "placeholder" || typedPh.strategy === "role:textbox", `strategy = ${typedPh.strategy}`);

  step("7. smart locator: alt text");
  const altClick = json(await tool("browser_click", { selector_or_text: "Company Logo" }));
  expect(altClick.strategy === "alt" || altClick.strategy === "text", `strategy = ${altClick.strategy}`);

  step("8. smart locator: title attribute");
  const titleClick = json(await tool("browser_click", { selector_or_text: "Extra Tooltip" }));
  expect(titleClick.strategy === "title", `strategy = ${titleClick.strategy}`);

  step("9. smart locator: explicit CSS");
  const cssClick = json(await tool("browser_click", { selector_or_text: "#btn-save" }));
  expect(cssClick.strategy === "selector", `strategy = ${cssClick.strategy}`);

  step("10. upload via direct input (CSS selector)");
  const up1 = json(await tool("browser_upload_file", { selector_or_text: "#direct-file", paths: [TMP] }));
  expect(up1.ok && up1.resolution === "direct", `direct upload: ${JSON.stringify(up1)}`);
  const direct = json(await tool("browser_evaluate", {
    expression: 'document.getElementById("direct-status").textContent',
  }));
  expect(/direct mc-v4/.test(String(direct.result)), `direct status: ${direct.result}`);

  step("11. upload via nearby button (drop zone with hidden input)");
  const up2 = json(await tool("browser_upload_file", { selector_or_text: "Add photo or drag and drop", paths: [TMP] }));
  expect(up2.ok && up2.resolution === "nearest-input", `dropzone upload: ${JSON.stringify(up2)}`);
  const dropStatus = json(await tool("browser_evaluate", {
    expression: 'document.getElementById("upload-status").textContent',
  }));
  expect(/got mc-v4/.test(String(dropStatus.result)), `drop status: ${dropStatus.result}`);

  step("12. wait_for: late element appears within timeout");
  // Re-show #late by toggling display:none then re-running the timeout via reload.
  await tool("browser_open_url", { url: FIXTURE_URL });
  const wait = json(await tool("browser_wait_for", {
    selector_or_text: "Late content arrived",
    timeout_ms: 3000,
  }));
  expect(wait.ok && wait.elapsedMs >= 0, `waited ${wait.elapsedMs}ms via ${wait.strategy}`);

  step("13. wait_for: missing element times out cleanly");
  const missingResp = await tool("browser_wait_for", {
    selector_or_text: "#never-appears-xyz",
    timeout_ms: 500,
  });
  const isErr = missingResp.result.isError === true ||
    String(missingResp.result.content?.[0]?.text ?? "").startsWith("ERROR");
  expect(isErr, `missing wait should error, got: ${txt(missingResp).slice(0,120)}`);

  step("14. close");
  const closed = json(await tool("browser_close"));
  expect(closed.ok, "closed cleanly");

  console.log("\nALL CHECKS PASSED");
  fs.unlinkSync(TMP);
  proc.kill();
  process.exit(0);
})().catch((e) => {
  console.error("smoke v4 FAILED:", e);
  proc.kill();
  process.exit(1);
});
