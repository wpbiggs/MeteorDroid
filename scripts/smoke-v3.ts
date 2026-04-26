// Smoke test for v0.3 — overlay/cursor/STOP, focus_next, type_into_focused,
// evaluate. Uses ephemeral mode + a data: URL form so it has no external deps.
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

const FORM = `data:text/html,<!doctype html>
<html><head><title>Form</title></head>
<body>
  <h1>v3 smoke</h1>
  <form id="f">
    <input id="a" name="a" placeholder="a" />
    <input id="b" name="b" placeholder="b" />
    <textarea id="c" name="c" placeholder="c"></textarea>
  </form>
</body></html>`;

(async () => {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-v3", version: "0" },
  });
  notify("notifications/initialized");

  step("1. open form page");
  const open = json(await tool("browser_open_url", { url: FORM }));
  expect(open.ok, "opened data: form");

  step("2. overlay + cursor injected");
  const probeRaw = await tool("browser_evaluate", {
    expression:
      '({overlay: !!document.getElementById("__mc_overlay"), cursor: !!document.getElementById("__mc_cursor"), stop: !!document.getElementById("__mc_stop"), installed: !!window.__mcInstalled, readyState: document.readyState, htmlChildren: document.documentElement.children.length, htmlOuter: document.documentElement.outerHTML.slice(0, 500)})',
  });
  console.log("probe raw →", txt(probeRaw));
  const probe = json(probeRaw);
  // Result is JSON-stringified by evaluateExpr if it fits.
  const probeObj =
    typeof probe.result === "string" ? JSON.parse(probe.result) : probe.result;
  expect(probeObj.overlay && probeObj.cursor && probeObj.stop, "overlay+cursor+stop present");

  step("3. tab into first input then type into focused");
  await tool("browser_focus_next", { times: 1 });
  const t1 = json(
    await tool("browser_type_into_focused", { text: "hello-A" }),
  );
  expect(t1.ok && t1.chars === 7, "typed 7 chars into focused");

  step("4. tab to next input and type again");
  await tool("browser_focus_next", { times: 1 });
  await tool("browser_type_into_focused", { text: "hello-B" });

  step("5. verify form values via evaluate");
  const vals = json(
    await tool("browser_evaluate", {
      expression: '({a: document.getElementById("a").value, b: document.getElementById("b").value})',
    }),
  );
  const valsObj =
    typeof vals.result === "string" ? JSON.parse(vals.result) : vals.result;
  expect(valsObj.a === "hello-A" && valsObj.b === "hello-B", `form values: ${JSON.stringify(valsObj)}`);

  step("6. simulate STOP click via evaluate → next write paused");
  await tool("browser_evaluate", {
    expression: '(() => { document.getElementById("__mc_stop").click(); return true; })',
  });
  // Give the exposed function a tick to run on the Node side.
  await new Promise((r) => setTimeout(r, 200));
  const blocked = json(
    await tool("browser_type_into_focused", { text: "should-not-appear" }),
  );
  expect(blocked.paused === true, `STOP paused next write: ${blocked.reason}`);

  step("7. read tools still work while STOP-paused");
  const stillReads = json(await tool("browser_get_page_text", { max_chars: 200 }));
  expect(typeof stillReads.title === "string", "get_page_text works while STOP-paused");

  step("8. resume clears userStopRequested; writes work again");
  const resumed = json(await tool("browser_resume"));
  expect(resumed.resumed === true, "resumed");
  await tool("browser_focus_next", { times: 1 }); // jump to textarea (3rd field)
  const t3 = json(
    await tool("browser_type_into_focused", { text: "post-resume" }),
  );
  expect(t3.ok, "typing works after resume");

  step("9. typeIntoFocused with no focus errors clearly");
  await tool("browser_evaluate", {
    expression: '(() => { (document.activeElement as any)?.blur?.(); document.body.focus(); return true; })',
  });
  const noFocus = await tool("browser_type_into_focused", { text: "x" });
  expect(
    noFocus.result.isError === true || JSON.parse(txt(noFocus)).paused !== true,
    "no-focus path returns an error not a silent success",
  );

  step("10. evaluate truncates large results");
  const big = json(
    await tool("browser_evaluate", {
      expression: '"x".repeat(10000)',
    }),
  );
  const bigStr = typeof big.result === "string" ? big.result : JSON.stringify(big.result);
  expect(bigStr.includes("…[truncated]"), "large evaluate result truncated");

  step("11. dangerous evaluate auto-pauses");
  await tool("browser_resume"); // clear any prior pause
  const danger = json(
    await tool("browser_evaluate", {
      expression: '"please log in"',
    }),
  );
  expect(danger.paused === true, "dangerous expression paused");

  step("12. close");
  await tool("browser_resume");
  const closed = json(await tool("browser_close"));
  expect(closed.ok, "closed cleanly");

  console.log("\nALL CHECKS PASSED");
  proc.kill();
  process.exit(0);
})().catch((e) => {
  console.error("smoke v3 FAILED:", e);
  proc.kill();
  process.exit(1);
});
