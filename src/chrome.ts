import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

export type ChromeProfileChoice = { dir: string; label: string };

export function chromeUserDataDirDefault(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
  }
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error("LOCALAPPDATA not set");
    return path.join(local, "Google", "Chrome", "User Data");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

export function chromeBinaryDefault(): string {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "google-chrome";
}

function safeReadJson(filePath: string): any | null {
  try {
    const txt = fs.readFileSync(filePath, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

export function discoverProfiles(userDataDir: string): ChromeProfileChoice[] {
  let dirents: fs.Dirent[] = [];
  try {
    dirents = fs.readdirSync(userDataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const localState = safeReadJson(path.join(userDataDir, "Local State"));
  const infoCache: Record<string, { name?: string }> =
    (localState?.profile?.info_cache as Record<string, { name?: string }> | undefined) ??
    {};

  const candidates = dirents
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
    .filter((name) => fs.existsSync(path.join(userDataDir, name, "Preferences")));

  const out: ChromeProfileChoice[] = candidates.map((dir) => {
    const friendly = infoCache[dir]?.name;
    const label = friendly ? `${dir} (${friendly})` : dir;
    return { dir, label };
  });

  out.sort((a, b) => {
    if (a.dir === "Default" && b.dir !== "Default") return -1;
    if (b.dir === "Default" && a.dir !== "Default") return 1;
    const na = a.dir.startsWith("Profile ") ? Number(a.dir.slice("Profile ".length)) : NaN;
    const nb = b.dir.startsWith("Profile ") ? Number(b.dir.slice("Profile ".length)) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a.dir.localeCompare(b.dir);
  });
  return out;
}

export function launchChromeCDP(opts: {
  chromePath?: string;
  userDataDir: string;
  profileDir: string;
  port: number;
}): { pid: number | null; cdpUrl: string; command: string; args: string[] } {
  const chromePath = opts.chromePath ?? chromeBinaryDefault();
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.userDataDir}`,
    `--profile-directory=${opts.profileDir}`,
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return {
    pid: child.pid ?? null,
    cdpUrl: `http://127.0.0.1:${opts.port}`,
    command: chromePath,
    args,
  };
}

export async function quitChrome(opts: {
  pid?: number | null;
  force?: boolean;
}): Promise<{ ok: true; method: string; pid?: number | null }> {
  const pid = opts.pid ?? null;
  const force = !!opts.force;

  if (pid) {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      return { ok: true, method: force ? "kill(SIGKILL)" : "kill(SIGTERM)", pid };
    } catch {
      // fall through to best-effort app quit
    }
  }

  if (process.platform === "darwin") {
    await new Promise<void>((resolve) => {
      const p = spawn(
        "osascript",
        ["-e", 'tell application "Google Chrome" to quit'],
        { stdio: "ignore" },
      );
      p.on("exit", () => resolve());
      p.on("error", () => resolve());
    });
    return { ok: true, method: "osascript quit" };
  }

  // Generic fallback: attempt to kill all chrome-ish processes is too risky.
  return { ok: true, method: "noop" };
}
