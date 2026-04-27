#!/usr/bin/env node

// Small stable entrypoint for npm's `bin`.
// The actual MCP server lives in `dist/server.js` (built on publish).
await import(new URL("../dist/server.js", import.meta.url).href);
