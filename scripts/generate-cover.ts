// Generate FamConomy Facebook cover (1640×924) inspired by the logo.
// Renders an HTML page in Playwright and screenshots it.
import { chromium } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs";

const OUT = "/Users/will/projects/minicomet/assets";
const LOGO_PATH = path.join(OUT, "profile-pic.png");
fs.mkdirSync(OUT, { recursive: true });

const logoB64 = fs.readFileSync(LOGO_PATH).toString("base64");
const logoDataUrl = `data:image/png;base64,${logoB64}`;

// FB cover safe zones: profile pic (lower-left, ~200×200) + page name overlay
// (lower-left). Keep the right 60% clean for content; left 25% reserved.
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1640px;height:924px;overflow:hidden;font-family:-apple-system,"SF Pro Display","Inter","Segoe UI",sans-serif;}
  .bg{
    position:absolute;inset:0;
    background:
      radial-gradient(circle at 85% 25%, rgba(255,170,60,0.30), transparent 55%),
      radial-gradient(circle at 18% 80%, rgba(60,150,255,0.30), transparent 55%),
      linear-gradient(135deg,#0b1f44 0%,#15306b 45%,#1d4f9e 100%);
  }
  /* Subtle grid */
  .grid{position:absolute;inset:0;opacity:0.07;
    background-image:linear-gradient(rgba(255,255,255,0.6) 1px,transparent 1px),
                      linear-gradient(90deg,rgba(255,255,255,0.6) 1px,transparent 1px);
    background-size:80px 80px;}
  .content{
    position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;
    padding:0 100px 0 110px;gap:56px;
  }
  /* On Facebook, profile pic sits at lower-left (~24px from left, ~24px above bottom).
     We keep the LEFT 25% lighter on content and put the wordmark RIGHT of center. */
  .text{color:white;flex:1;max-width:760px;}
  .word{
    font-size:138px;font-weight:900;letter-spacing:-3px;line-height:0.95;
    background:linear-gradient(90deg,#3aa0ff 0%,#5fd06b 35%,#ffd23a 65%,#ff7a2e 100%);
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
    filter:drop-shadow(0 6px 30px rgba(0,0,0,0.35));
  }
  .tag{
    font-size:42px;font-weight:600;color:#dfe9ff;margin-top:24px;letter-spacing:-0.5px;
    text-shadow:0 2px 16px rgba(0,0,0,0.4);
  }
  .pills{display:flex;gap:16px;margin-top:32px;flex-wrap:wrap;}
  .pill{
    padding:12px 24px;border:2px solid rgba(255,255,255,0.55);border-radius:999px;
    color:white;font-size:26px;font-weight:600;backdrop-filter:blur(6px);
    background:rgba(255,255,255,0.08);
  }
  .logo-wrap{
    width:500px;height:500px;flex-shrink:0;margin-left:24px;
    display:flex;align-items:center;justify-content:center;
    background:radial-gradient(circle,rgba(255,255,255,0.14),transparent 70%);
    border-radius:50%;
  }
  .logo{width:460px;height:460px;object-fit:contain;
    filter:drop-shadow(0 18px 60px rgba(0,0,0,0.5));}
  /* FB-safe-zone reserve for profile pic (lower-left ~200px circle) */
  .reserve{position:absolute;left:24px;bottom:24px;width:240px;height:240px;}
</style></head><body>
  <div class="bg"></div>
  <div class="grid"></div>
  <div class="content">
    <div class="text">
      <div class="word">FamConomy</div>
      <div class="tag">Turn family life into a fun economy.</div>
      <div class="pills">
        <span class="pill">Chores</span>
        <span class="pill">Goals</span>
        <span class="pill">Rewards</span>
        <span class="pill">Money habits</span>
      </div>
    </div>
    <div class="logo-wrap"><img class="logo" src="${logoDataUrl}"/></div>
  </div>
  <div class="reserve"></div>
</body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1640, height: 924 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForTimeout(200);
  const out = path.join(OUT, "cover.png");
  await page.screenshot({
    path: out,
    clip: { x: 0, y: 0, width: 1640, height: 924 },
  });
  console.log("✓ cover →", out, fs.statSync(out).size, "bytes");
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
