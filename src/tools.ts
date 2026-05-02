import { z } from "zod";
import { PausedError, type BrowserSession } from "./browser.js";
import {
  chromeUserDataDirDefault,
  discoverProfiles,
  launchChromeCDP,
  quitChrome,
} from "./chrome.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

const ok = (obj: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }],
});

const err = (message: string): ToolResult => ({
  content: [{ type: "text", text: `ERROR: ${message}` }],
  isError: true,
});

const paused = (reason: string, hint?: string): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        paused: true,
        reason,
        hint:
          hint ??
          "Tell the user to complete this step in the visible browser, then ask them to say 'resume'. Then call browser_resume.",
      }),
    },
  ],
});

/* ------------------------------------------------------------------ */
/* Safety guardrails                                                   */
/* ------------------------------------------------------------------ */

const DANGEROUS_PATTERNS: RegExp[] = [
  /\bplace\s*(the)?\s*order\b/i,
  /\bbuy\s*now\b/i,
  /\bpay\s*now\b/i,
  /\bconfirm\s*(and\s*)?(pay|purchase|order)\b/i,
  /\bcomplete\s*(purchase|order|payment)\b/i,
  /\bsubmit\s*(payment|order)\b/i,
  /\bcheckout\b.*\bnow\b/i,
  /\bsign\s*(in|up)\b/i,
  /\blog\s*in\b/i,
  /\bcreate\s*account\b/i,
  /\bregister\b/i,
  /\bsubmit\b/i,
  /\bdelete\s*(account|repository|repo|project|everything)\b/i,
  /\bremove\s*account\b/i,
  /\bwipe\b/i,
  /\bdestroy\b/i,
];
const DANGEROUS_KEYS = new Set(["Enter"]);

function dangerousMatch(s: string): string | null {
  for (const re of DANGEROUS_PATTERNS) if (re.test(s)) return re.source;
  return null;
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

export const schemas = {
  // Chrome / CDP lifecycle helpers
  chrome_list_profiles: z.object({
    userDataDir: z.string().min(1).optional(),
  }),
  chrome_launch_cdp: z.object({
    port: z.number().int().positive().max(65535).optional(),
    userDataDir: z.string().min(1).optional(),
    profileDir: z.string().min(1),
    chromePath: z.string().min(1).optional(),
  }),
  chrome_quit: z.object({
    pid: z.number().int().positive().optional(),
    force: z.boolean().optional(),
    confirm: z.boolean().optional(),
  }),
  browser_connect_cdp: z.object({
    cdpUrl: z.string().url(),
  }),

  browser_open_url: z.object({ url: z.string().url() }),
  browser_get_page_text: z.object({
    max_chars: z.number().int().positive().max(20_000).optional(),
  }),
  browser_click: z.object({
    selector_or_text: z.string().min(1),
    confirm: z.boolean().optional(),
  }),
  browser_type: z.object({
    selector_or_text: z.string().min(1),
    text: z.string(),
  }),
  browser_press: z.object({
    key: z.string().min(1),
    confirm: z.boolean().optional(),
  }),
  browser_type_into_focused: z.object({
    text: z.string(),
    delay_ms: z.number().int().min(0).max(500).optional(),
  }),
  browser_focus_next: z.object({
    times: z.number().int().min(1).max(50).optional(),
  }),
  browser_focus_prev: z.object({
    times: z.number().int().min(1).max(50).optional(),
  }),
  browser_evaluate: z.object({
    expression: z.string().min(1),
    confirm: z.boolean().optional(),
  }),
  browser_upload_file: z.object({
    selector_or_text: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1).max(20),
  }),
  browser_wait_for: z.object({
    selector_or_text: z.string().min(1),
    timeout_ms: z.number().int().positive().max(60_000).optional(),
    state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
  }),
  browser_dom_summary: z.object({
    max_items: z.number().int().positive().max(300).optional(),
  }),
  browser_screenshot: z.object({}),
  browser_close: z.object({}),
  // Multi-tab
  browser_list_tabs: z.object({}),
  browser_read_tab: z.object({
    index: z.number().int().nonnegative(),
    max_chars: z.number().int().positive().max(20_000).optional(),
  }),
  browser_set_active_tab: z.object({
    index: z.number().int().nonnegative(),
    confirm: z.boolean().optional(),
  }),
  browser_new_tab: z.object({
    url: z.string().url().optional(),
  }),
  // Pause / resume
  browser_request_human: z.object({
    reason: z.string().min(1),
    hint: z.string().optional(),
  }),
  browser_resume: z.object({
    note: z.string().optional(),
  }),
  browser_status: z.object({}),
} as const;

/* ------------------------------------------------------------------ */
/* Tool descriptors                                                    */
/* ------------------------------------------------------------------ */

export interface ToolDescriptor {
  name: keyof typeof schemas;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const toolDescriptors: ToolDescriptor[] = [
  {
    name: "chrome_list_profiles",
    description:
      "List Chrome profile directories in the given user-data-dir (Default, Profile 1, ...), including friendly names when available.",
    inputSchema: {
      type: "object",
      properties: {
        userDataDir: { type: "string", description: "Chrome user data dir (optional; default is OS-specific)." },
      },
    },
  },
  {
    name: "chrome_launch_cdp",
    description:
      "Launch Google Chrome in the background with --remote-debugging-port using an existing profile directory.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535 },
        userDataDir: { type: "string" },
        profileDir: { type: "string", description: "Profile directory name (e.g. Default, Profile 1)." },
        chromePath: { type: "string", description: "Optional Chrome binary path." },
      },
      required: ["profileDir"],
    },
  },
  {
    name: "chrome_quit",
    description:
      "Quit Chrome (best-effort). If pid is provided, sends SIGTERM (or SIGKILL with force=true). Requires confirm=true or the agent will pause and ask the user.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer", minimum: 1 },
        force: { type: "boolean" },
        confirm: { type: "boolean" },
      },
    },
  },
  {
    name: "browser_connect_cdp",
    description:
      "Switch the current session to CDP mode by connecting to an already-running Chrome at cdpUrl (no MCP restart). Creates a new agent-marked tab.",
    inputSchema: {
      type: "object",
      properties: { cdpUrl: { type: "string" } },
      required: ["cdpUrl"],
    },
  },
  {
    name: "browser_open_url",
    description:
      "Navigate the active agent tab to a URL. The active tab is marked in its title with the agent prefix (e.g. '[mc]') so the user can see at a glance which tab the agent controls.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL." } },
      required: ["url"],
    },
  },
  {
    name: "browser_get_page_text",
    description:
      "Return readable text of the ACTIVE tab (scripts/styles stripped, whitespace collapsed, truncated to max_chars; default 4000).",
    inputSchema: {
      type: "object",
      properties: {
        max_chars: { type: "integer", minimum: 1, maximum: 20000 },
      },
    },
  },
  {
    name: "browser_click",
    description:
      "Click on the active tab by CSS/XPath selector OR by visible text. AUTO-PAUSES the agent when the target matches purchase/payment/login/signup/destructive patterns — the user must complete the action and then call browser_resume. Use confirm=true ONLY when the user has explicitly authorized this specific click.",
    inputSchema: {
      type: "object",
      properties: {
        selector_or_text: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["selector_or_text"],
    },
  },
  {
    name: "browser_type",
    description:
      "Replace the value of a field on the active tab (by selector or label/placeholder).",
    inputSchema: {
      type: "object",
      properties: {
        selector_or_text: { type: "string" },
        text: { type: "string" },
      },
      required: ["selector_or_text", "text"],
    },
  },
  {
    name: "browser_press",
    description:
      "Press a keyboard key on the active tab. 'Enter' AUTO-PAUSES (likely form submit) unless confirm=true is supplied with explicit user authorization.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, confirm: { type: "boolean" } },
      required: ["key"],
    },
  },
  {
    name: "browser_type_into_focused",
    description:
      "Type text into whatever element currently has focus on the active tab. Uses real keystrokes (good for autocomplete fields, contenteditables, and anywhere a stable selector is hard to find). PREFER this after Tab-navigating to a field.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        delay_ms: { type: "integer", minimum: 0, maximum: 500, description: "Per-keystroke delay in ms (default 0)." },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_focus_next",
    description:
      "Press Tab one or more times to advance keyboard focus on the active tab. Effective for filling forms without selectors. Pair with browser_type_into_focused.",
    inputSchema: {
      type: "object",
      properties: { times: { type: "integer", minimum: 1, maximum: 50 } },
    },
  },
  {
    name: "browser_focus_prev",
    description: "Press Shift+Tab one or more times to move keyboard focus backward.",
    inputSchema: {
      type: "object",
      properties: { times: { type: "integer", minimum: 1, maximum: 50 } },
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Evaluate a JavaScript expression in the active tab's page context and return the result (truncated to 4KB). Treated as a write op (respects pause/STOP). Use this for one-off DOM probing — e.g. listing inputs, reading aria-labels, or testing selectors. The expression should be a single expression or a function literal like '() => document.querySelectorAll(\"input\").length'.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["expression"],
    },
  },
  {
    name: "browser_upload_file",
    description:
      "Upload one or more local file paths to a file input on the active tab. The selector_or_text can target the <input type=file> directly OR a nearby drop-zone / button (the tool walks up to find the closest hidden file input). Paths must be absolute. Use this for profile-pic uploads, attachments, image inputs, etc.",
    inputSchema: {
      type: "object",
      properties: {
        selector_or_text: { type: "string", description: "Selector, label, or visible text near the upload control." },
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: "Absolute filesystem paths to upload.",
        },
      },
      required: ["selector_or_text", "paths"],
    },
  },
  {
    name: "browser_wait_for",
    description:
      "Wait until an element matching selector_or_text reaches a state (default 'visible'). Use after clicks that trigger SPA transitions, modal opens, or async content loads. Default timeout 10s. States: visible | hidden | attached | detached.",
    inputSchema: {
      type: "object",
      properties: {
        selector_or_text: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1, maximum: 60000 },
        state: { type: "string", enum: ["visible", "hidden", "attached", "detached"] },
      },
      required: ["selector_or_text"],
    },
  },
  {
    name: "browser_dom_summary",
    description:
      "Compact JSON summary of visible interactive elements (links, buttons, inputs, role-tagged widgets) on the active tab. Much cheaper than browser_get_page_text when you need to know 'what can I click or fill?'. Returns {count, total, items: [{tag, role, name, type?, id?, placeholder?, offscreen?}]}.",
    inputSchema: {
      type: "object",
      properties: { max_items: { type: "integer", minimum: 1, maximum: 300 } },
    },
  },
  {
    name: "browser_screenshot",
    description: "PNG screenshot of the ACTIVE tab viewport.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_close",
    description:
      "Close the agent-controlled tabs. In cdp mode the user's Chrome is left running.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_list_tabs",
    description:
      "List every tab in the current browser context. Returns index, title, url, isActive (the write-target), and isAgent (whether the tab carries the agent marker). Use this to see what reference tabs the user has open.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_read_tab",
    description:
      "Read-only: return the readable text of any tab by index (does NOT change the active tab). Use this to gather information from reference tabs the user has opened.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0 },
        max_chars: { type: "integer", minimum: 1, maximum: 20000 },
      },
      required: ["index"],
    },
  },
  {
    name: "browser_set_active_tab",
    description:
      "Switch which tab the agent will write to next. Cross-origin switches require confirm=true so the agent cannot silently start typing into an unrelated logged-in tab.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0 },
        confirm: { type: "boolean" },
      },
      required: ["index"],
    },
  },
  {
    name: "browser_new_tab",
    description: "Open a new agent-marked tab (optionally navigated to a URL) and make it active.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
    },
  },
  {
    name: "browser_request_human",
    description:
      "Pause the agent and ask the user to take over the browser to complete a sensitive step (login, 2FA, CAPTCHA, payment, etc.). The agent CANNOT perform any write action until the user/agent calls browser_resume. Read tools (list_tabs, read_tab, get_page_text, screenshot) still work so the agent can verify the new state on resume.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What the user needs to do." },
        hint: { type: "string", description: "Optional extra guidance shown to the user." },
      },
      required: ["reason"],
    },
  },
  {
    name: "browser_resume",
    description:
      "Clear an active pause. Call this after the user confirms (in chat) that they have completed the manual step. The agent should typically follow this with browser_get_page_text to verify the new state before proceeding.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
    },
  },
  {
    name: "browser_status",
    description:
      "Return current session status: mode, paused state and reason, active tab index/url. Cheap to call; useful to check before a write action.",
    inputSchema: { type: "object", properties: {} },
  },
];

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

export async function dispatch(
  session: BrowserSession,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "chrome_list_profiles": {
        const { userDataDir } = schemas.chrome_list_profiles.parse(rawArgs ?? {});
        const dir = userDataDir ?? chromeUserDataDirDefault();
        const profiles = discoverProfiles(dir);
        return ok({ userDataDir: dir, profiles });
      }

      case "chrome_launch_cdp": {
        const { port, userDataDir, profileDir, chromePath } =
          schemas.chrome_launch_cdp.parse(rawArgs ?? {});
        const dir = userDataDir ?? chromeUserDataDirDefault();
        const r = launchChromeCDP({
          chromePath,
          userDataDir: dir,
          profileDir,
          port: port ?? 9222,
        });
        session.lastLaunchedChromePid = r.pid;
        session.lastLaunchedChromeCdpUrl = r.cdpUrl;
        return ok({ ok: true, ...r });
      }

      case "chrome_quit": {
        const { pid, force, confirm } = schemas.chrome_quit.parse(rawArgs ?? {});
        if (!confirm) {
          const target = pid ?? session.lastLaunchedChromePid;
          const reason = `Quitting Chrome is destructive. Please confirm you want to quit Chrome${target ? ` (pid ${target})` : ""}.`;
          session.pause(reason);
          return paused(reason);
        }
        const targetPid = pid ?? session.lastLaunchedChromePid;
        const r = await quitChrome({ pid: targetPid, force });
        // r already contains ok: true.
        return ok({ ...r, confirmed: true });
      }

      case "browser_connect_cdp": {
        const { cdpUrl } = schemas.browser_connect_cdp.parse(rawArgs ?? {});
        const r = await session.connectCDP(cdpUrl);
        return ok({ ok: true, ...r });
      }

      case "browser_open_url": {
        const { url } = schemas.browser_open_url.parse(rawArgs ?? {});
        const r = await session.openUrl(url);
        return ok({ ok: true, ...r });
      }

      case "browser_get_page_text": {
        const { max_chars } = schemas.browser_get_page_text.parse(rawArgs ?? {});
        if (!session.page_()) return err("No page open. Call browser_open_url first.");
        return ok(await session.getPageText(max_chars));
      }

      case "browser_click": {
        const { selector_or_text, confirm } = schemas.browser_click.parse(rawArgs ?? {});
        const danger = dangerousMatch(selector_or_text);
        if (danger && !confirm) {
          const reason = `Click "${selector_or_text}" matches sensitive pattern /${danger}/. Human takeover required.`;
          session.pause(reason);
          return paused(reason);
        }
        const r = await session.click(selector_or_text);
        return ok({ ok: true, ...r, confirmed: !!confirm });
      }

      case "browser_type": {
        const { selector_or_text, text } = schemas.browser_type.parse(rawArgs ?? {});
        const r = await session.type(selector_or_text, text);
        return ok({ ok: true, ...r });
      }

      case "browser_press": {
        const { key, confirm } = schemas.browser_press.parse(rawArgs ?? {});
        if (DANGEROUS_KEYS.has(key) && !confirm) {
          const reason = `Pressing "${key}" likely submits a form. Human takeover required.`;
          session.pause(reason);
          return paused(reason);
        }
        const r = await session.press(key);
        return ok({ ok: true, ...r, confirmed: !!confirm });
      }

      case "browser_type_into_focused": {
        const { text, delay_ms } = schemas.browser_type_into_focused.parse(rawArgs ?? {});
        const r = await session.typeIntoFocused(text, delay_ms ?? 0);
        return ok({ ok: true, ...r });
      }

      case "browser_focus_next": {
        const { times } = schemas.browser_focus_next.parse(rawArgs ?? {});
        const r = await session.focusNext(times ?? 1);
        return ok({ ok: true, ...r });
      }

      case "browser_focus_prev": {
        const { times } = schemas.browser_focus_prev.parse(rawArgs ?? {});
        const r = await session.focusPrev(times ?? 1);
        return ok({ ok: true, ...r });
      }

      case "browser_evaluate": {
        const { expression, confirm } = schemas.browser_evaluate.parse(rawArgs ?? {});
        const danger = dangerousMatch(expression);
        if (danger && !confirm) {
          const reason = `Expression contains sensitive pattern /${danger}/. Human takeover required.`;
          session.pause(reason);
          return paused(reason);
        }
        const r = await session.evaluateExpr(expression);
        return ok({ ok: true, ...r });
      }

      case "browser_upload_file": {
        const { selector_or_text, paths } = schemas.browser_upload_file.parse(rawArgs ?? {});
        const r = await session.uploadFile(selector_or_text, paths);
        return ok({ ok: true, ...r });
      }

      case "browser_wait_for": {
        const { selector_or_text, timeout_ms, state } = schemas.browser_wait_for.parse(rawArgs ?? {});
        const r = await session.waitFor(selector_or_text, timeout_ms ?? 10_000, state ?? "visible");
        return ok({ ok: true, ...r });
      }

      case "browser_dom_summary": {
        const { max_items } = schemas.browser_dom_summary.parse(rawArgs ?? {});
        return ok(await session.domSummary(max_items ?? 80));
      }

      case "browser_screenshot": {
        schemas.browser_screenshot.parse(rawArgs ?? {});
        const shot = await session.screenshot();
        return {
          content: [
            { type: "image", data: shot.base64, mimeType: shot.mimeType },
            { type: "text", text: JSON.stringify({ ok: true, bytes: shot.bytes }) },
          ],
        };
      }

      case "browser_close": {
        schemas.browser_close.parse(rawArgs ?? {});
        await session.close();
        return ok({ ok: true, closed: true });
      }

      case "browser_list_tabs": {
        schemas.browser_list_tabs.parse(rawArgs ?? {});
        return ok({ tabs: await session.listTabs() });
      }

      case "browser_read_tab": {
        const { index, max_chars } = schemas.browser_read_tab.parse(rawArgs ?? {});
        return ok(await session.readTab(index, max_chars));
      }

      case "browser_set_active_tab": {
        const { index, confirm } = schemas.browser_set_active_tab.parse(rawArgs ?? {});
        return ok({ ok: true, ...(await session.setActiveTab(index, !!confirm)) });
      }

      case "browser_new_tab": {
        const { url } = schemas.browser_new_tab.parse(rawArgs ?? {});
        return ok({ ok: true, ...(await session.newTab(url)) });
      }

      case "browser_request_human": {
        const { reason, hint } = schemas.browser_request_human.parse(rawArgs ?? {});
        session.pause(reason);
        return paused(reason, hint);
      }

      case "browser_resume": {
        const { note } = schemas.browser_resume.parse(rawArgs ?? {});
        return ok(session.resume(note));
      }

      case "browser_status": {
        schemas.browser_status.parse(rawArgs ?? {});
        const s = session.status();
        const info = session.modeInfo();
        const active = session.page_();
        return ok({
          ...info,
          paused: s.paused,
          pauseReason: s.reason,
          activeUrl: active?.url() ?? null,
        });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e: any) {
    if (e instanceof PausedError) {
      return paused(e.reason);
    }
    if (e?.issues) {
      return err(`Invalid arguments: ${JSON.stringify(e.issues)}`);
    }
    return err(e?.message ?? String(e));
  }
}
