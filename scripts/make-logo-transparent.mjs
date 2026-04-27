import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

async function main() {
  const repoRoot = process.cwd();
  const inPath = path.join(repoRoot, "assets", "MeteorDroid.png");
  const inBuf = await fs.readFile(inPath);
  const inDataUrl = `data:image/png;base64,${inBuf.toString("base64")}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const outBase64 = await page.evaluate(async (url) => {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("failed to load image"));
      i.src = url;
    });

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d ctx");

    ctx.drawImage(img, 0, 0);
    const image = ctx.getImageData(0, 0, w, h);
    const data = image.data;

    // Collect background seed colors from a few border points.
    const seeds = [];
    const sample = (x, y) => {
      const i = (y * w + x) * 4;
      seeds.push([data[i], data[i + 1], data[i + 2]]);
    };
    const pts = [
      [0, 0],
      [1, 1],
      [2, 2],
      [8, 8],
      [w - 1, 0],
      [w - 2, 1],
      [0, h - 1],
      [1, h - 2],
      [w - 1, h - 1],
      [w - 2, h - 2],
    ];
    for (const [x, y] of pts) sample(x, y);

    const tol = 28; // keep tight to avoid eating bright highlights
    const isBg = (x, y) => {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a === 0) return true;

      for (const [sr, sg, sb] of seeds) {
        const dr = r - sr;
        const dg = g - sg;
        const db = b - sb;
        const d = Math.sqrt(dr * dr + dg * dg + db * db);
        if (d <= tol) return true;
      }
      return false;
    };

    // Flood fill from borders so only edge-connected background becomes transparent.
    const visited = new Uint8Array(w * h);
    const qx = new Int32Array(w * h);
    const qy = new Int32Array(w * h);
    let qh = 0;
    let qt = 0;

    const push = (x, y) => {
      const idx = y * w + x;
      if (visited[idx]) return;
      if (!isBg(x, y)) return;
      visited[idx] = 1;
      qx[qt] = x;
      qy[qt] = y;
      qt++;
    };

    for (let x = 0; x < w; x++) {
      push(x, 0);
      push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      push(0, y);
      push(w - 1, y);
    }

    while (qh < qt) {
      const x = qx[qh];
      const y = qy[qh];
      qh++;

      const i = (y * w + x) * 4;
      data[i + 3] = 0;

      if (x > 0) push(x - 1, y);
      if (x + 1 < w) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y + 1 < h) push(x, y + 1);
    }

    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  }, inDataUrl);

  await browser.close();

  await fs.writeFile(inPath, Buffer.from(outBase64, "base64"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
