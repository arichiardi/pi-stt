# Contributing

Thanks for helping. This package is **alpha** and **Linux-only** on the active path.

## Before you start

For any change bigger than a small bug, open an issue before you write code. This avoids wasted work.

## Run the tests

Needs Node 24 (or 22.6+ with `--experimental-strip-types`).

```bash
npm install
npm run test:unit        # blocking in CI
npm test                 # includes integration (pending, see below)
```

The integration tests do not run against the current code: they expect dependency injection in `index.ts` that does not exist. Contributions that add this seam are welcome.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

## Pull requests

- One topic per PR.
- The unit test CI must pass.
- Audio changes and realtime protocol changes must explain how you verified them. Simulated tests do not prove audible audio.
- Never commit `voice.json`, `auth.json`, environment files, or API keys.

## Security

Do not open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

When you contribute, you agree that your contribution is licensed under MIT.
