#!/usr/bin/env node

// Small stable entrypoint for npm's `bin`.
// The actual MCP server lives in `dist/server.js` (built on publish).
// CLI helpers live in `dist/cli.js`.

const argv = process.argv.slice(2);
const subcommand = argv[0];

if (subcommand === "cdp" || subcommand === "cdp-launch") {
  const mod = await import(new URL("../dist/cli.js", import.meta.url).href);
  await mod.main(argv);
} else {
  await import(new URL("../dist/server.js", import.meta.url).href);
}
