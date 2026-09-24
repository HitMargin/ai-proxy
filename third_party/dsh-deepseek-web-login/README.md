# Third-party source: dsh-deepseek-web-login

This directory contains a Deno-compatible derivative of:

- Project: `dsh-deepseek-web-login`
- Upstream: https://github.com/cv-superding/dsh-deepseek-web-login
- Copyright: 2026 cv-superding (Ding Li)
- License: Apache License 2.0 (see `LICENSE`)
- Upstream notice: see `NOTICE`

The copied `src/protocol.ts` provides the prompting-based tool-call bridge used by
`src/deepseek-web.ts`. It was modified for this project to remove Node-only
imports, use Web Crypto UUIDs, and use a local error class. No credentials are
included here.
