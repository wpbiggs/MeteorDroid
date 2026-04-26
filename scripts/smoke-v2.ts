// Smoke test for the v0.2 multi-tab + pause/resume features (ephemeral mode).
import { spawn } from "node:child_process";

const proc = spawn("npx", ["tsx", "src/server.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    MINI_COMET_MODE: "ephemeral",
    MINI_COMET_HEADLESS: "1",
  },
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
const call = (method: string, params: unknown): Promise<any> =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const notify = (method: string, params: unknown = {}) =>
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
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
    clientInfo: { name: "smoke-v2", version: "0" },
  });
  notify("notifications/initialized");

  step("1. open example.com (active tab)");
  const open1 = json(await tool("browser_open_url", { url: "https://example.com" }));
  expect(open1.ok && open1.title === "Example Domain", "opened example.com");

  step("2. open a second reference tab");
  const newTab = json(await tool("browser_new_tab", { url: "https://example.org" }));
  expect(newTab.ok && newTab.index === 1, `new_tab @ index ${newTab.index}`);

  step("3. list tabs");
  const list = json(await tool("browser_list_tabs"));
  expect(list.tabs.length === 2, `${list.tabs.length} tabs visible`);
  expect(list.tabs[1].isActive, "tab 1 is active (write target)");
  expect(list.tabs.every((t: any) => t.isAgent), "both tabs carry [mc] marker");

  step("4. read non-active tab (multi-tab read)");
  const readT0 = json(await tool("browser_read_tab", { index: 0, max_chars: 200 }));
  expect(readT0.index === 0 && readT0.title === "Example Domain", "read tab 0 OK");

  step("5. switch active tab back to 0 (cross-origin → needs confirm)");
  const switchNoConfirm = await tool("browser_set_active_tab", { index: 0 });
  expect(
    switchNoConfirm.result.isError === true,
    "cross-origin switch refused without confirm",
  );
  const switchOk = json(
    await tool("browser_set_active_tab", { index: 0, confirm: true }),
  );
  expect(switchOk.ok && switchOk.activeIndex === 0, "switched with confirm=true");

  step("6. dangerous click → auto-pause");
  const dangerous = json(await tool("browser_click", { selector_or_text: "Register" }));
  expect(dangerous.paused === true, `auto-paused: ${dangerous.reason}`);

  step("7. status reflects pause");
  const status1 = json(await tool("browser_status"));
  expect(status1.paused === true, "status: paused=true");

  step("8. write tools blocked while paused");
  const blockedType = json(await tool("browser_type", { selector_or_text: "input", text: "x" }));
  expect(blockedType.paused === true, "type blocked: " + blockedType.reason);

  step("9. read tools STILL WORK while paused");
  const pageWhilePaused = json(await tool("browser_get_page_text", { max_chars: 100 }));
  expect(
    pageWhilePaused.title === "Example Domain",
    "get_page_text works while paused",
  );
  const listWhilePaused = json(await tool("browser_list_tabs"));
  expect(listWhilePaused.tabs.length === 2, "list_tabs works while paused");

  step("10. resume");
  const resumed = json(await tool("browser_resume", { note: "user did the thing" }));
  expect(resumed.resumed === true, "resumed");
  const status2 = json(await tool("browser_status"));
  expect(status2.paused === false, "status: paused=false");

  step("11. writes work again post-resume");
  const reopened = json(await tool("browser_open_url", { url: "https://example.com" }));
  expect(reopened.ok, "open_url succeeds after resume");

  step("12. close");
  const closed = json(await tool("browser_close"));
  expect(closed.ok && closed.closed, "closed cleanly");

  console.log("\nALL CHECKS PASSED");
  proc.kill();
  process.exit(0);
})().catch((e) => {
  console.error("smoke FAILED:", e);
  proc.kill();
  process.exit(1);
});
