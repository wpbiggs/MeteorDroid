# Contributing

Thanks for helping improve MeteorDroid.

## Development

Requirements:

- Node >= 18.17

Setup:

```bash
npm install
npm run typecheck
```

Run locally:

```bash
npm run dev
```

Smoke tests:

```bash
npm run smoke
npm run smoke:v4
```

## Pull Requests

- Keep changes small and focused.
- If you change tool behavior, add/adjust a smoke test in `scripts/`.
- Update `README.md` when you add env vars or new tools.
