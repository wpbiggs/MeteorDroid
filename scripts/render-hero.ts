import path from "node:path";
import { chromium } from "playwright";

// Renders assets/hero.svg (which references assets/MeteorDroid.png) into a PNG
// so it displays reliably on GitHub.
async function main() {
  const repoRoot = process.cwd();
  const svgPath = path.join(repoRoot, "assets", "hero.svg");
  const outPath = path.join(repoRoot, "assets", "hero.png");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 600 } });

  await page.goto(`file://${svgPath}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(50);
  await page.screenshot({ path: outPath });

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
