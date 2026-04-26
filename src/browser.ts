import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import * as os from "node:os";
import * as path from "node:path";

export type SessionMode = "ephemeral" | "persistent" | "cdp";

export interface SessionConfig {
  mode: SessionMode;
  headless: boolean;
  profileDir: string; // used in persistent mode
  cdpUrl: string; // used in cdp mode
  tabMarker: string; // title prefix that brands "agent-controlled" tabs
}

export class PausedError extends Error {
  constructor(public reason: string) {
    super(`PAUSED: ${reason}`);
  }
}

/**
 * Default config built from env vars. opencode.jsonc passes these via
 * the MCP `environment` block.
 */
export function configFromEnv(): SessionConfig {
  const mode = (process.env.MINI_COMET_MODE ?? "ephemeral") as SessionMode;
  if (!["ephemeral", "persistent", "cdp"].includes(mode)) {
    throw new Error(
      `MINI_COMET_MODE must be one of ephemeral|persistent|cdp (got "${mode}")`,
    );
  }
  return {
    mode,
    headless:
      process.env.MINI_COMET_HEADLESS === "1" ||
      process.env.MINI_COMET_HEADLESS === "true",
    profileDir:
      process.env.MINI_COMET_PROFILE_DIR ??
      path.join(os.homedir(), ".minicomet", "profile"),
    cdpUrl: process.env.MINI_COMET_CDP_URL ?? "http://localhost:9222",
    tabMarker: process.env.MINI_COMET_TAB_MARKER ?? "[mc]",
  };
}

interface TabInfo {
  index: number;
  title: string;
  url: string;
  isActive: boolean;
  isAgent: boolean; // does its title carry the marker?
}

/**
 * BrowserSession — owns one BrowserContext and tracks one "active" page
 * (the only page the agent is allowed to write to). Read tools can address
 * any page by index.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private active: Page | null = null;
  private launching: Promise<void> | null = null;
  paused = false;
  pauseReason: string | null = null;
  /** Flipped to true when the page-side STOP button is clicked. Polled by
   *  assertNotPaused so the next write op self-pauses. */
  userStopRequested = false;

  constructor(private cfg: SessionConfig = configFromEnv()) {}

  /* -------------------- lifecycle -------------------- */

  async ensure(): Promise<Page> {
    if (this.active && !this.active.isClosed()) return this.active;
    if (this.launching) {
      await this.launching;
      if (this.active && !this.active.isClosed()) return this.active;
    }
    this.launching = this.launchByMode();
    try {
      await this.launching;
    } finally {
      this.launching = null;
    }
    return this.active!;
  }

  private async launchByMode(): Promise<void> {
    const { mode, headless, profileDir, cdpUrl } = this.cfg;
    if (mode === "ephemeral") {
      this.browser = await chromium.launch({ headless });
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      this.active = await this.context.newPage();
    } else if (mode === "persistent") {
      // launchPersistentContext returns a BrowserContext directly; there is
      // no separate Browser handle in this API.
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: { width: 1280, height: 800 },
      });
      // Persistent context starts with one blank page — reuse it.
      const existing = this.context.pages();
      this.active = existing[0] ?? (await this.context.newPage());
    } else {
      // cdp
      this.browser = await chromium.connectOverCDP(cdpUrl);
      // CDP gives back the existing browser. We use the first context (your
      // default profile) and create a NEW dedicated tab that we mark.
      const ctxs = this.browser.contexts();
      this.context = ctxs[0] ?? (await this.browser.newContext());
      this.active = await this.context.newPage();
    }
    this.active.setDefaultTimeout(15_000);
    await this.markPageAsAgent(this.active);
  }

  /** Stamp a page with the "[mc]" title marker AND inject the safety
   *  overlay + fake cursor. Uses addInitScript so it survives navigations. */
  private async markPageAsAgent(page: Page): Promise<void> {
    const marker = this.cfg.tabMarker;
    const alreadyMarked = (page as any).__mcMarked as boolean | undefined;
    if (!alreadyMarked) {
      try {
        // Pass as raw JS string (not a TS function) so esbuild's __name
        // helper doesn't leak into the page-world serialized source.
        await page.addInitScript({
          content: `(${INJECT_SRC})(${JSON.stringify({ marker })});`,
        });
        (page as any).__mcMarked = true;
      } catch {
        /* not fatal */
      }
      // Expose a Node-side handler the page calls when STOP is clicked.
      try {
        await page.exposeFunction("__mcOnStop", () => {
          this.userStopRequested = true;
          this.pause("User pressed STOP in the browser overlay.");
        });
      } catch {
        /* already exposed (re-mark) */
      }
    }
    // Apply immediately to whatever is loaded right now (covers about:blank
    // and pages that loaded before the init script was attached).
    try {
      await page.evaluate(
        `(${INJECT_SRC})(${JSON.stringify({ marker })});`,
      );
    } catch (e) {
      console.error("[mini-comet] injectAgentChrome failed:", (e as Error)?.message ?? e);
    }
  }

  /** Push a transient action label into the overlay ("clicking…", "typing…"). */
  private async setOverlayState(
    state: "idle" | "clicking" | "typing" | "navigating" | "paused",
    detail = "",
  ): Promise<void> {
    const page = this.active;
    if (!page || page.isClosed()) return;
    try {
      await page.evaluate(
        ({ s, d }: { s: string; d: string }) => {
          const w = window as any;
          if (typeof w.__mcSetState === "function") w.__mcSetState(s, d);
        },
        { s: state, d: detail },
      );
    } catch {
      /* page might be navigating */
    }
  }

  /** Animate the fake cursor to a viewport-relative point (CSS px). */
  private async moveCursorTo(x: number, y: number): Promise<void> {
    const page = this.active;
    if (!page || page.isClosed()) return;
    try {
      await page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          const w = window as any;
          if (typeof w.__mcMoveCursor === "function") w.__mcMoveCursor(x, y);
        },
        { x, y },
      );
    } catch {}
  }

  page_(): Page | null {
    return this.active && !this.active.isClosed() ? this.active : null;
  }

  /* -------------------- pause / resume gates -------------------- */

  /** Throws if paused or if the user pressed STOP. Used by every write tool. */
  private assertNotPaused(): void {
    if (this.userStopRequested) {
      // exposeFunction already paused us; this is belt-and-braces.
      this.paused = true;
      if (!this.pauseReason) {
        this.pauseReason = "User pressed STOP in the browser overlay.";
      }
    }
    if (this.paused) {
      throw new PausedError(
        this.pauseReason ?? "Agent is paused awaiting human input",
      );
    }
  }

  pause(reason: string): void {
    this.paused = true;
    this.pauseReason = reason;
    this.setOverlayState("paused", reason).catch(() => {});
  }

  resume(note?: string): { resumed: true; previousReason: string | null; note?: string } {
    const prev = this.pauseReason;
    this.paused = false;
    this.pauseReason = null;
    this.userStopRequested = false;
    // Reset overlay so the user sees the agent is back in control.
    this.setOverlayState("idle").catch(() => {});
    return { resumed: true, previousReason: prev, ...(note ? { note } : {}) };
  }

  status(): { paused: boolean; reason: string | null } {
    return { paused: this.paused, reason: this.pauseReason };
  }

  /* -------------------- tab management -------------------- */

  async listTabs(): Promise<TabInfo[]> {
    if (!this.context) return [];
    const pages = this.context.pages();
    const out: TabInfo[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (p.isClosed()) continue;
      let title = "";
      try {
        title = await p.title();
      } catch {}
      out.push({
        index: i,
        title,
        url: p.url(),
        isActive: p === this.active,
        isAgent: title.startsWith(this.cfg.tabMarker),
      });
    }
    return out;
  }

  async readTab(index: number, maxChars = 4000) {
    const pages = this.context?.pages() ?? [];
    const p = pages[index];
    if (!p || p.isClosed()) {
      throw new Error(`No tab at index ${index}`);
    }
    return this.extractText(p, maxChars, index);
  }

  /** Make a different tab the active (write-target) tab. */
  async setActiveTab(
    index: number,
    confirm: boolean,
  ): Promise<{ activeIndex: number; url: string; title: string; markerApplied: boolean }> {
    this.assertNotPaused();
    const pages = this.context?.pages() ?? [];
    const target = pages[index];
    if (!target || target.isClosed()) {
      throw new Error(`No tab at index ${index}`);
    }
    const prevOrigin = this.active ? safeOrigin(this.active.url()) : null;
    const newOrigin = safeOrigin(target.url());
    if (prevOrigin && newOrigin && prevOrigin !== newOrigin && !confirm) {
      throw new Error(
        `Cross-origin active-tab switch (${prevOrigin} → ${newOrigin}). ` +
          `Re-call with confirm=true to proceed.`,
      );
    }
    this.active = target;
    let markerApplied = false;
    try {
      await this.markPageAsAgent(target);
      markerApplied = true;
    } catch {}
    await target.bringToFront().catch(() => {});
    return {
      activeIndex: index,
      url: target.url(),
      title: this.stripMarker(await target.title().catch(() => "")),
      markerApplied,
    };
  }

  async newTab(url?: string): Promise<{ index: number; url: string; title: string }> {
    this.assertNotPaused();
    if (!this.context) await this.ensure();
    const page = await this.context!.newPage();
    page.setDefaultTimeout(15_000);
    this.active = page;
    // Install marker BEFORE navigation.
    await this.markPageAsAgent(page);
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    await this.markPageAsAgent(page);
    const idx = this.context!.pages().indexOf(page);
    return {
      index: idx,
      url: page.url(),
      title: this.stripMarker(await page.title().catch(() => "")),
    };
  }

  /* -------------------- write actions (all gated on pause) -------------------- */

  async openUrl(
    url: string,
  ): Promise<{ url: string; title: string; status: number | null }> {
    this.assertNotPaused();
    await this.setOverlayState("navigating", url);
    const page = await this.ensure();
    await this.markPageAsAgent(page);
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 5_000 });
    } catch {}
    await this.markPageAsAgent(page);
    await this.setOverlayState("idle");
    return {
      url: page.url(),
      title: this.stripMarker(await page.title()),
      status: response?.status() ?? null,
    };
  }

  private stripMarker(title: string): string {
    return title.startsWith(this.cfg.tabMarker)
      ? title.slice(this.cfg.tabMarker.length).trim()
      : title;
  }

  async getPageText(maxChars = 4000) {
    const page = await this.ensure();
    return this.extractText(page, maxChars);
  }

  private async extractText(page: Page, maxChars: number, index?: number) {
    const raw = await page.evaluate(() => {
      const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
      if (!clone) return "";
      for (const el of Array.from(
        clone.querySelectorAll("script, style, noscript, svg, iframe"),
      )) {
        el.remove();
      }
      return (clone.innerText || "").replace(/\s+\n/g, "\n");
    });
    const collapsed = raw
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const truncated = collapsed.length > maxChars;
    let title = "";
    try {
      title = await page.title();
    } catch {}
    const cleanTitle = this.stripMarker(title);
    return {
      ...(index !== undefined ? { index } : {}),
      url: page.url(),
      title: cleanTitle,
      text: truncated ? collapsed.slice(0, maxChars) + "\n…[truncated]" : collapsed,
      truncated,
      fullLength: collapsed.length,
    };
  }

  /** Strategy name returned alongside the resolved locator so callers can
   *  report (and one day record) which lookup style won. */
  async resolveLocator(
    selectorOrText: string,
  ): Promise<{ locator: Locator; strategy: string }> {
    const page = await this.ensure();
    // Explicit selector syntax wins immediately.
    const looksLikeSelector =
      /^(\.|#|\[|\/|xpath=|css=|text=|role=)/.test(selectorOrText) ||
      /^[a-zA-Z][a-zA-Z0-9-]*(\[|\.|#|>)/.test(selectorOrText);
    if (looksLikeSelector) {
      return { locator: page.locator(selectorOrText).first(), strategy: "selector" };
    }
    // Fallback chain: role+name → label → placeholder → text → loose CSS.
    const tries: Array<{ name: string; loc: Locator }> = [
      { name: "role:button", loc: page.getByRole("button", { name: selectorOrText, exact: false }) },
      { name: "role:link", loc: page.getByRole("link", { name: selectorOrText, exact: false }) },
      { name: "role:textbox", loc: page.getByRole("textbox", { name: selectorOrText, exact: false }) },
      { name: "role:checkbox", loc: page.getByRole("checkbox", { name: selectorOrText, exact: false }) },
      { name: "role:tab", loc: page.getByRole("tab", { name: selectorOrText, exact: false }) },
      { name: "role:menuitem", loc: page.getByRole("menuitem", { name: selectorOrText, exact: false }) },
      { name: "label", loc: page.getByLabel(selectorOrText, { exact: false }) },
      { name: "placeholder", loc: page.getByPlaceholder(selectorOrText, { exact: false }) },
      { name: "alt", loc: page.getByAltText(selectorOrText, { exact: false }) },
      { name: "title", loc: page.getByTitle(selectorOrText, { exact: false }) },
      { name: "text", loc: page.getByText(selectorOrText, { exact: false }) },
    ];
    for (const t of tries) {
      try {
        if ((await t.loc.count()) > 0) {
          return { locator: t.loc.first(), strategy: t.name };
        }
      } catch {
        /* selector engine errors — skip */
      }
    }
    return {
      locator: page.getByText(selectorOrText, { exact: false }).first(),
      strategy: "text:fallback",
    };
  }

  async click(selectorOrText: string) {
    this.assertNotPaused();
    const page = await this.ensure();
    const { locator: loc, strategy } = await this.resolveLocator(selectorOrText);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    // Animate cursor to target before clicking.
    try {
      const box = await loc.boundingBox();
      if (box) {
        await this.moveCursorTo(box.x + box.width / 2, box.y + box.height / 2);
      }
    } catch {}
    await this.setOverlayState("clicking", selectorOrText);
    await loc.click({ timeout: 10_000 });
    await this.setOverlayState("idle");
    return { clicked: selectorOrText, strategy, url: page.url() };
  }

  async type(selectorOrText: string, text: string) {
    this.assertNotPaused();
    const { locator: loc, strategy } = await this.resolveLocator(selectorOrText);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    try {
      const box = await loc.boundingBox();
      if (box) {
        await this.moveCursorTo(box.x + box.width / 2, box.y + box.height / 2);
      }
    } catch {}
    await this.setOverlayState("typing", `${selectorOrText}: "${preview(text)}"`);
    await loc.click({ timeout: 10_000 });
    await loc.fill(text);
    await this.setOverlayState("idle");
    return { typedInto: selectorOrText, strategy, chars: text.length };
  }

  /** Type a string into whatever element currently has focus. Useful when
   *  the field has no stable selector but you've Tab-navigated to it. Uses
   *  keyboard.type so it triggers proper input/keydown events. */
  async typeIntoFocused(text: string, delayMs = 0) {
    this.assertNotPaused();
    const page = await this.ensure();
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        ariaLabel: el.getAttribute("aria-label"),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      };
    });
    if (!focused) {
      throw new Error(
        "No focused element. Click or Tab to a field first, then call browser_type_into_focused.",
      );
    }
    await this.moveCursorTo(focused.x, focused.y);
    await this.setOverlayState("typing", `(focused ${focused.tag}): "${preview(text)}"`);
    await page.keyboard.type(text, delayMs ? { delay: delayMs } : undefined);
    await this.setOverlayState("idle");
    return { typedIntoFocused: focused, chars: text.length };
  }

  /** Convenience wrappers for keyboard-only form navigation. */
  async focusNext(times = 1) {
    this.assertNotPaused();
    const page = await this.ensure();
    for (let i = 0; i < Math.max(1, Math.min(50, times)); i++) {
      await page.keyboard.press("Tab");
    }
    return { advanced: times };
  }
  async focusPrev(times = 1) {
    this.assertNotPaused();
    const page = await this.ensure();
    for (let i = 0; i < Math.max(1, Math.min(50, times)); i++) {
      await page.keyboard.press("Shift+Tab");
    }
    return { rewound: times };
  }

  /** Evaluate an expression in the page context. Treated as a write op (it
   *  can mutate the page), so it respects pause/STOP. The expression must
   *  be a single JS expression OR a "() => ..." style function literal. */
  async evaluateExpr(expression: string) {
    this.assertNotPaused();
    const page = await this.ensure();
    // Wrap as `(0, eval)(expr)` so we don't leak local scope. If the user
    // passes a function literal, call it.
    const result = await page.evaluate((src: string) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`"use strict"; return (${src});`);
      const v = fn();
      return typeof v === "function" ? v() : v;
    }, expression);
    // Truncate big results so we don't blow the agent context.
    let serialized: unknown = result;
    try {
      const s = JSON.stringify(result);
      if (s && s.length > 4000) serialized = s.slice(0, 4000) + "…[truncated]";
    } catch {
      serialized = String(result);
    }
    return { result: serialized };
  }

  async press(key: string) {
    this.assertNotPaused();
    const page = await this.ensure();
    await this.setOverlayState("typing", `key: ${key}`);
    await page.keyboard.press(key);
    await this.setOverlayState("idle");
    return { pressed: key, url: page.url() };
  }

  /** Upload one or more local file paths to a file input. The locator can
   *  point at the <input type=file> directly OR at a drop-zone / button
   *  near a hidden input — we walk up to the closest container and search
   *  inside for the input. */
  async uploadFile(selectorOrText: string, paths: string[]) {
    this.assertNotPaused();
    if (!paths.length) throw new Error("uploadFile requires at least one path");
    const page = await this.ensure();
    const { locator: loc, strategy } = await this.resolveLocator(selectorOrText);
    let target = loc;
    let resolution: "direct" | "nearest-input" = "direct";
    const isFileInput = await loc
      .evaluate((el) => el instanceof HTMLInputElement && el.type === "file")
      .catch(() => false);
    if (!isFileInput) {
      // Walk up to a likely container and find a hidden file input within.
      const handle = await loc.elementHandle().catch(() => null);
      if (!handle) throw new Error(`Could not resolve element for "${selectorOrText}"`);
      const inputHandle = await handle.evaluateHandle((el) => {
        let node: Element | null = el as Element;
        for (let i = 0; i < 6 && node; i++) {
          const found = node.querySelector('input[type="file"]');
          if (found) return found;
          node = node.parentElement;
        }
        // Last resort: any file input on the page (only if exactly one).
        const all = document.querySelectorAll('input[type="file"]');
        return all.length === 1 ? all[0] : null;
      });
      const asElement = inputHandle.asElement();
      if (!asElement) {
        throw new Error(
          `No <input type="file"> found near "${selectorOrText}". Try targeting the input directly.`,
        );
      }
      target = page.locator("input[type=file]").first(); // placeholder
      // Use the element handle directly via setInputFiles on the handle.
      await this.setOverlayState("clicking", `upload: ${paths.length} file(s)`);
      await (asElement as any).setInputFiles(paths);
      await this.setOverlayState("idle");
      resolution = "nearest-input";
      return {
        uploaded: paths,
        strategy,
        resolution,
        count: paths.length,
      };
    }
    await this.setOverlayState("clicking", `upload: ${paths.length} file(s)`);
    await target.setInputFiles(paths);
    await this.setOverlayState("idle");
    return { uploaded: paths, strategy, resolution, count: paths.length };
  }

  /** Wait until an element matching the selector or text is visible (or
   *  hidden, if state==="hidden"). Returns when condition is met or throws
   *  on timeout. */
  async waitFor(
    selectorOrText: string,
    timeoutMs = 10_000,
    state: "visible" | "hidden" | "attached" | "detached" = "visible",
  ) {
    this.assertNotPaused();
    const { locator: loc, strategy } = await this.resolveLocator(selectorOrText);
    const t0 = Date.now();
    await loc.first().waitFor({ state, timeout: timeoutMs });
    return {
      matched: selectorOrText,
      strategy,
      state,
      elapsedMs: Date.now() - t0,
    };
  }

  /** Compact summary of interactive elements on the page. Much cheaper than
   *  raw page text for "what can I click?" reasoning. */
  async domSummary(maxItems = 80) {
    const page = await this.ensure();
    const items = await page.evaluate((max: number) => {
      const SEL = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "select",
        "textarea",
        "[role=button]",
        "[role=link]",
        "[role=tab]",
        "[role=menuitem]",
        "[role=checkbox]",
        "[role=radio]",
        "[role=textbox]",
        "[contenteditable=true]",
      ].join(",");
      const out: any[] = [];
      const seen = new Set<Element>();
      const nodes = Array.from(document.querySelectorAll(SEL));
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        const r = (el as HTMLElement).getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0 && (el as HTMLElement).offsetParent !== null;
        const inViewport =
          r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
        if (!visible) continue;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || tag;
        const aria = el.getAttribute("aria-label") || "";
        const labelled = el.getAttribute("aria-labelledby");
        let labelText = "";
        if (labelled) {
          labelText = (document.getElementById(labelled)?.textContent || "").trim();
        }
        const placeholder = (el as HTMLInputElement).placeholder || "";
        const value = (el as HTMLInputElement).value || "";
        const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const name = (aria || labelText || text || placeholder || value || "").slice(0, 80);
        out.push({
          tag,
          role,
          name,
          ...(placeholder ? { placeholder } : {}),
          ...((el as HTMLInputElement).type ? { type: (el as HTMLInputElement).type } : {}),
          ...(el.id ? { id: el.id } : {}),
          ...(inViewport ? {} : { offscreen: true }),
        });
        if (out.length >= max) break;
      }
      return { count: out.length, total: nodes.length, items: out };
    }, maxItems);
    return items;
  }

  async screenshot() {
    const page = await this.ensure();
    const buf = await page.screenshot({ type: "png", fullPage: false });
    return {
      base64: buf.toString("base64"),
      mimeType: "image/png" as const,
      bytes: buf.byteLength,
    };
  }

  async close(): Promise<void> {
    // In CDP mode we connected to *your* Chrome — never close the browser,
    // just disconnect and close any agent-owned tabs.
    if (this.cfg.mode === "cdp") {
      try {
        // close only tabs we marked
        const pages = this.context?.pages() ?? [];
        for (const p of pages) {
          if (p.isClosed()) continue;
          const t = await p.title().catch(() => "");
          if (t.startsWith(this.cfg.tabMarker)) await p.close().catch(() => {});
        }
        await this.browser?.close().catch(() => {}); // disconnects, doesn't kill remote
      } catch {}
    } else {
      try {
        await this.context?.close();
      } catch {}
      try {
        await this.browser?.close();
      } catch {}
    }
    this.active = null;
    this.context = null;
    this.browser = null;
  }

  modeInfo(): { mode: SessionMode; headless: boolean; tabMarker: string } {
    return {
      mode: this.cfg.mode,
      headless: this.cfg.headless,
      tabMarker: this.cfg.tabMarker,
    };
  }
}

function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function preview(s: string, max = 40): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/* ------------------------------------------------------------------ */
/* Page-side: title marker + safety overlay + fake cursor              */
/* ------------------------------------------------------------------ */
/* Defined as a raw JS string so that bundler helpers (esbuild __name) */
/* never leak into the page-world serialized form. The string is wrapped */
/* in IIFE form: `(${INJECT_SRC})({ marker: "[mc]" })`.                  */
const INJECT_SRC = `function ({ marker }) {
  var w = window;

  // ---- title marker (always re-apply on every call) ----
  function applyTitle() {
    if (!document.title.startsWith(marker)) {
      document.title = marker + " " + (document.title || "new tab");
    }
  }
  applyTitle();

  if (w.__mcInstalled) {
    if (typeof w.__mcReinstall === "function") w.__mcReinstall();
    return;
  }
  w.__mcInstalled = true;

  // Keep title in sync with future SPA changes.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyTitle, { once: true });
  }
  (function watchTitle() {
    var titleEl = document.querySelector("title");
    if (!titleEl) { setTimeout(watchTitle, 50); return; }
    new MutationObserver(applyTitle).observe(titleEl, { childList: true });
    applyTitle();
  })();

  // ---- styles ----
  var css = [
    "@keyframes __mcPulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.5; transform:scale(1.4); } }",
    "@keyframes __mcRing  { 0% { transform:scale(0.6); opacity:0.9; } 100% { transform:scale(2.4); opacity:0; } }",
    "@keyframes __mcFlash { 0% { box-shadow:0 0 0 0 rgba(251,191,36,0.9), 0 4px 18px rgba(0,0,0,0.35); } 100% { box-shadow:0 0 0 14px rgba(251,191,36,0), 0 4px 18px rgba(0,0,0,0.35); } }",
    "#__mc_overlay, #__mc_cursor { all:initial; position:fixed; z-index:2147483647; pointer-events:none; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; }",
    "#__mc_overlay { bottom:16px; right:16px; display:flex; align-items:center; gap:10px; padding:10px 14px; background:rgba(20,20,24,0.94); color:#fff; border-radius:999px; box-shadow:0 4px 18px rgba(0,0,0,0.35); font-size:13px; backdrop-filter:blur(8px); transition:background 0.2s ease; border:2px solid rgba(96,165,250,0.6); }",
    "#__mc_overlay.flash { animation:__mcFlash 700ms ease-out; }",
    "#__mc_overlay.paused { background:rgba(180,32,32,0.96); border-color:rgba(248,113,113,0.9); }",
    "#__mc_dot { width:10px; height:10px; border-radius:50%; background:#4ade80; animation:__mcPulse 1.4s ease-in-out infinite; display:inline-block; }",
    "#__mc_overlay.paused #__mc_dot { background:#fbbf24; animation:none; }",
    "#__mc_overlay.acting #__mc_dot { background:#60a5fa; }",
    "#__mc_label { white-space:nowrap; font-weight:600; }",
    "#__mc_detail { max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:0.85; font-size:12px; }",
    "#__mc_stop { pointer-events:auto; cursor:pointer; background:#dc2626; color:#fff; border:none; border-radius:999px; padding:6px 14px; font-size:12px; font-weight:800; letter-spacing:0.06em; margin-left:6px; box-shadow:0 2px 6px rgba(220,38,38,0.5); }",
    "#__mc_stop:hover { background:#ef4444; transform:scale(1.05); }",
    "#__mc_stop:disabled { background:#6b7280; cursor:default; box-shadow:none; }",
    "#__mc_cursor { width:18px; height:18px; border-radius:50%; background:rgba(96,165,250,0.85); box-shadow:0 0 0 2px rgba(255,255,255,0.9), 0 4px 14px rgba(0,0,0,0.4); transform:translate(-50%,-50%); transition:left 280ms cubic-bezier(.2,.8,.2,1), top 280ms cubic-bezier(.2,.8,.2,1), background 200ms; left:-100px; top:-100px; }",
    "#__mc_cursor.typing  { background:rgba(251,146,60,0.9); }",
    "#__mc_cursor.clicking { background:rgba(248,113,113,0.95); }",
    "#__mc_cursor.paused  { background:rgba(250,204,21,0.95); }",
    "#__mc_ring { position:absolute; inset:-6px; border:2px solid currentColor; border-radius:50%; color:rgba(96,165,250,0.9); opacity:0; }",
    "#__mc_cursor.clicking #__mc_ring { animation:__mcRing 500ms ease-out; }"
  ].join("\\n");

  function install() {
    if (!document.documentElement) return;
    if (document.getElementById("__mc_overlay")) return;
    var style = document.getElementById("__mc_style");
    if (!style) {
      style = document.createElement("style");
      style.id = "__mc_style";
      style.textContent = css;
      document.documentElement.appendChild(style);
    }
    var overlay = document.createElement("div");
    overlay.id = "__mc_overlay";
    overlay.innerHTML =
      '<span id="__mc_dot"></span>' +
      '<span id="__mc_label">Agent controlling</span>' +
      '<span id="__mc_detail"></span>' +
      '<button id="__mc_stop" type="button" title="Pause the agent">STOP</button>';
    document.documentElement.appendChild(overlay);

    var cursor = document.createElement("div");
    cursor.id = "__mc_cursor";
    cursor.innerHTML = '<div id="__mc_ring"></div>';
    document.documentElement.appendChild(cursor);

    var stopBtn = overlay.querySelector("#__mc_stop");
    stopBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      stopBtn.disabled = true;
      stopBtn.textContent = "STOPPED";
      overlay.classList.add("paused");
      overlay.classList.remove("acting");
      cursor.className = "paused";
      var dt = overlay.querySelector("#__mc_detail");
      if (dt) dt.textContent = "User pressed STOP";
      try { if (typeof w.__mcOnStop === "function") w.__mcOnStop(); } catch (_) {}
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
  w.__mcReinstall = install;
  setInterval(function () {
    if (!document.getElementById("__mc_overlay")) install();
  }, 1500);

  w.__mcSetState = function (state, detail) {
    var overlay = document.getElementById("__mc_overlay");
    var label = document.getElementById("__mc_label");
    var det = document.getElementById("__mc_detail");
    var cursor = document.getElementById("__mc_cursor");
    if (!overlay || !label || !det || !cursor) return;
    overlay.classList.remove("paused", "acting");
    cursor.className = "";
    if (state === "idle") {
      label.textContent = "Agent controlling";
      // Keep last detail for a moment so the user can read it.
      if (w.__mcLastDetail) {
        det.textContent = "last: " + w.__mcLastDetail;
        clearTimeout(w.__mcDetailTimer);
        w.__mcDetailTimer = setTimeout(function () {
          var d = document.getElementById("__mc_detail");
          if (d) d.textContent = "";
        }, 1800);
      } else {
        det.textContent = "";
      }
    } else if (state === "paused") {
      overlay.classList.add("paused");
      cursor.classList.add("paused");
      label.textContent = "Paused — your turn";
      det.textContent = detail || "";
    } else {
      overlay.classList.add("acting");
      cursor.classList.add(state);
      label.textContent =
        state === "clicking"   ? "Clicking…"   :
        state === "typing"     ? "Typing…"     :
        state === "navigating" ? "Navigating…" : state;
      det.textContent = detail || "";
      w.__mcLastDetail = detail || "";
      // Brief amber flash so the user notices each write op.
      overlay.classList.remove("flash");
      void overlay.offsetWidth; // restart animation
      overlay.classList.add("flash");
    }
  };
  w.__mcMoveCursor = function (x, y) {
    var cursor = document.getElementById("__mc_cursor");
    if (!cursor) return;
    cursor.style.left = x + "px";
    cursor.style.top  = y + "px";
  };
}`;
