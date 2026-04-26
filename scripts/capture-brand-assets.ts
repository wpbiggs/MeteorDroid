// Capture FamConomy brand assets:
//   - profile-pic.png   (square crop of header logo + wordmark, ~640×640)
//   - cover.png         (1640×924 hero region screenshot)
// Saves to /Users/will/projects/minicomet/assets/
import { chromium } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs";

const OUT = "/Users/will/projects/minicomet/assets";
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ---- Cover: 1640×924 hero ----
  const ctxCover = await browser.newContext({
    viewport: { width: 1640, height: 924 },
    deviceScaleFactor: 2,
  });
  const pCover = await ctxCover.newPage();
  await pCover.goto("https://famconomy.com", { waitUntil: "networkidle" });
  // Hide everything below the hero so the screenshot is pure brand.
  await pCover.evaluate(() => {
    const nav = document.querySelector("header, nav");
    if (nav) (nav as HTMLElement).style.display = "none";
    // Remove feature sections — keep only first <section> / first hero block
    const main = document.querySelector("main") || document.body;
    const kids = Array.from(main.children) as HTMLElement[];
    let kept = 0;
    for (const k of kids) {
      // Keep the first ~2 children (hero block); hide the rest.
      if (kept >= 1) {
        k.style.display = "none";
      }
      kept++;
    }
    // Stretch hero vertically so it fills 924px nicely
    const hero = main.firstElementChild as HTMLElement | null;
    if (hero) {
      hero.style.minHeight = "924px";
      hero.style.display = "flex";
      hero.style.alignItems = "center";
    }
  }).catch(() => {});
  // Wait a beat for layout to settle after nav-hide.
  await pCover.waitForTimeout(300);
  const coverPath = path.join(OUT, "cover.png");
  await pCover.screenshot({
    path: coverPath,
    clip: { x: 0, y: 0, width: 1640, height: 924 },
  });
  console.log("✓ cover →", coverPath, fs.statSync(coverPath).size, "bytes");
  await ctxCover.close();

  // ---- Profile pic: tight crop of "FamConomy" logo + wordmark ----
  const ctxLogo = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 3, // very high DPI for crisp upscale
  });
  const pLogo = await ctxLogo.newPage();
  await pLogo.goto("https://famconomy.com", { waitUntil: "networkidle" });

  // Find the brand mark — locate the logo IMAGE itself, then build a square
  // crop that includes both the icon and the wordmark next to it.
  const brandHandle = await pLogo.evaluateHandle(() => {
    const imgs = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
    // Pick the first image in the top 200px of the viewport (the header logo).
    const headerImg = imgs.find((i) => {
      const r = i.getBoundingClientRect();
      return r.top < 200 && r.width > 16 && r.height > 16;
    });
    return headerImg ?? null;
  });
  const brandEl = brandHandle.asElement();
  if (!brandEl) throw new Error("Could not locate logo <img>");
  const imgBox = await brandEl.boundingBox();
  if (!imgBox) throw new Error("No bounding box for logo <img>");

  // Profile pic: tight square crop on JUST the logo icon (laptop+wordmark
  // graphic). It's already self-contained — text + icon — and renders
  // better than icon+wordmark in a 170px circular avatar.
  const padding = 12;
  const size = Math.max(imgBox.width, imgBox.height) + padding * 2;
  const cx = imgBox.x + imgBox.width / 2;
  const cy = imgBox.y + imgBox.height / 2;
  const clip = {
    x: Math.max(0, cx - size / 2),
    y: Math.max(0, cy - size / 2),
    width: size,
    height: size,
  };

  const profilePath = path.join(OUT, "profile-pic.png");
  await pLogo.screenshot({ path: profilePath, clip });
  console.log("✓ profile-pic →", profilePath, fs.statSync(profilePath).size, "bytes");
  console.log("  imgBox:", imgBox, "→ clip:", clip);

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
