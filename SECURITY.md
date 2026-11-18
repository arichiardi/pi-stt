# Security policy

The extension handles OpenAI credentials (`OPENAI_API_KEY`, `auth.json`) and microphone audio.

## Report a vulnerability

**Do not open a public issue.** Use the private security advisory on this repository's GitHub (the *Security* tab → *Report a vulnerability*).

Include: the package version, steps to reproduce, and the expected impact.

## Scope

In scope: credential leaks, command execution through config, and audio recording with no clear sign to the user.

Out of scope: problems in pi, in the OpenAI Realtime API, or in PipeWire. Report those to them directly.
