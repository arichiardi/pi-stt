# Contributing

Thanks for helping. This package is **alpha** and **Linux-only** on the active path.

## Before you start

For any change bigger than a small bug, open an issue before you write code. This avoids wasted work.

## Run the tests

Needs Node 24 (or 22.6+ with `--experimental-strip-types`).

```bash
npm install
npm test                 # blocking in CI (same command CI runs)
```

CI is the single source of truth for the test command. It runs `npm test`
(`node --test "test/**/*.test.ts"`), and that command passes against the current
code. There is no separate unit-only script.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

## Pull requests

- One topic per PR.
- The test suite (`npm test`) must pass.
- Audio changes and realtime protocol changes must explain how you verified them. Simulated tests do not prove audible audio.
- Never commit `voice.json`, `auth.json`, environment files, or API keys.

## Security

Do not open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

When you contribute, you agree that your contribution is licensed under MIT.
