import { spawn } from "node:child_process";
import * as readline from "node:readline";

import {
  chromeBinaryDefault,
  chromeUserDataDirDefault,
  discoverProfiles,
} from "./chrome.js";

type ProfileChoice = { dir: string; label: string };

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim();
}

async function promptPickProfile(profiles: ProfileChoice[]): Promise<string> {
  if (profiles.length === 0) {
    throw new Error("No Chrome profiles found (pass --user-data-dir and --profile-directory)");
  }
  // Simple TTY prompt (keeps deps minimal).
  process.stderr.write("Pick a Chrome profile directory:\n");
  for (let i = 0; i < profiles.length; i++) {
    process.stderr.write(`  ${i + 1}. ${profiles[i]!.label}\n`);
  }
  process.stderr.write("  0. Enter manually\n\n");

  for (;;) {
    const raw = await promptLine("Selection [1]: ");
    const n = raw === "" ? 1 : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= profiles.length) return profiles[n - 1]!.dir;
    if (n === 0) {
      const manual = await promptLine("Profile directory (e.g. Default, Profile 1): ");
      if (manual) return manual;
    }
    process.stderr.write("Invalid selection. Try again.\n");
  }
}

function parseArgs(argv: string[]): {
  port: number;
  chromePath: string;
  userDataDir: string;
  profileDir?: string;
} {
  let port = 9222;
  let chromePath = chromeBinaryDefault();
  let userDataDir = chromeUserDataDirDefault();
  let profileDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a?.startsWith("--port=")) port = Number(a.split("=", 2)[1]);
    else if (a === "--chrome-path") chromePath = String(argv[++i]);
    else if (a?.startsWith("--chrome-path=")) chromePath = a.split("=", 2)[1]!;
    else if (a === "--user-data-dir") userDataDir = String(argv[++i]);
    else if (a?.startsWith("--user-data-dir=")) userDataDir = a.split("=", 2)[1]!;
    else if (a === "--profile-directory") profileDir = String(argv[++i]);
    else if (a?.startsWith("--profile-directory=")) profileDir = a.split("=", 2)[1]!;
  }
  if (!Number.isFinite(port) || port <= 0) throw new Error("Invalid --port");
  return { port, chromePath, userDataDir, profileDir };
}

function printHelp(): void {
  process.stderr.write(
    [
      "meteordroid cdp",
      "",
      "Launch Google Chrome with --remote-debugging-port using an existing profile.",
      "Prompts you to pick a profile directory (Default, Profile 1, ...), then launches in the background.",
      "",
      "Usage:",
      "  meteordroid cdp [--port 9222] [--user-data-dir <dir>] [--profile-directory <name>] [--chrome-path <path>]",
      "",
      "Notes:",
      "  You must fully quit Chrome before launching with your existing user-data-dir.",
      "",
    ].join("\n"),
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0];
  if (cmd !== "cdp" && cmd !== "cdp-launch") {
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }

  const { port, chromePath, userDataDir } = parseArgs(argv.slice(1));
  let { profileDir } = parseArgs(argv.slice(1));

  if (!profileDir) {
    const profiles = discoverProfiles(userDataDir);
    profileDir = await promptPickProfile(profiles as ProfileChoice[]);
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDir}`,
  ];

  process.stderr.write(
    `[meteordroid] launching Chrome in background:\n  ${chromePath} ${args.join(" ")}\n`,
  );

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  process.stderr.write(
    `[meteordroid] started (pid ${child.pid ?? "?"}). CDP should be at http://127.0.0.1:${port}\n`,
  );
}
