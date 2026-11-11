# Formpilot backbone patches

This fork carries a small set of fixes on top of upstream `steel-dev/steel-browser`
at commit `c8aebf9` (2026-11-09). Everything here is intended to go upstream; the
patch set exists so the backbone is reproducible until it does.

## Why

Self-hosted Steel 0.5.x starts, accepts sessions, and the Commands API works, but the
**live viewer never connects**. Three independent defects stack on each other, so each
one hides the next:

1. `modules/sessions/sessions.controller.ts` builds the cast WebSocket URL as
   `v1/sessions/cast`, while the handler parses a session id out of
   `/v1/sessions/{id}/cast`. The URL therefore carries no session id.
2. `plugins/browser-socket/handlers/cast.handler.ts` registers `path: "/v1/sessions/cast"`,
   but `WebSocketRegistryService.matchHandler` uses `url.startsWith(path)`. A
   session-scoped URL never matches, so the socket opens and nothing consumes it.
   The user sees "Session connecting..." forever with no server error.
3. `plugins/browser-socket/casting.handler.ts` connects with
   `browserWSEndpoint: ws://${env.HOST}:${env.PORT}` — Steel's own API address, not
   Chrome's DevTools endpoint. It dials itself and gets `ECONNRESET`.

A fourth, unrelated defect prevents startup in production mode: `services/file.service.ts`
hardcodes `/files` at the filesystem root, which fails with `EACCES` for a normal user.

## Patches

| File | Change |
|---|---|
| `api/src/modules/sessions/sessions.controller.ts` | cast WS URL includes the active session id |
| `api/src/plugins/browser-socket/handlers/cast.handler.ts` | handler matches `/v1/sessions/` |
| `api/src/plugins/browser-socket/casting.handler.ts` | connect to `CDP_DOMAIN` / `CDP_REDIRECT_PORT`, not the API port |
| `api/src/services/websocket-registry.service.ts` | longest-prefix match so `/logs` and `/pageId` still win |
| `api/src/services/file.service.ts` | file storage under `tmpdir()` instead of `/files` |
| `package.json` | `allowScripts` so npm 11 runs esbuild/duckdb/classic-level postinstalls |

## Verify

```bash
npm install
npm run smoke:viewer
```

`smoke/viewer.mjs` starts Steel, serves a local form, opens the live viewer in a real
browser, and asserts that:

- the viewer receives live page metadata (frames are rendering),
- the canvas has painted a frame and a non-zero size,
- a real click focuses a field and real keystrokes land in the page,
- the viewer logged no page errors.

Set `CHROME_PATH` if Chrome is not at `/usr/bin/google-chrome` or `/opt/google/chrome/chrome`.

## Known limitations (not patched here)

- **Single session.** `SessionService.activeSession` is a singleton; creating a second
  session releases the first. Acceptable for a single-user local tool, not for
  multi-agent or multi-tenant use.
- **No authentication.** Ports `3000` and `9222` are unauthenticated. Bind to loopback
  and never expose them.
- **React UI asset base.** The UI is built for `/` but mounted at `/ui`, so `/ui` serves
  HTML whose `/assets/*` requests 404. This fork uses the server-rendered
  `/v1/sessions/debug` viewer instead and does not patch the UI build.

## License

Upstream is Apache-2.0. This fork keeps the upstream `LICENSE` unchanged (there is no
`NOTICE` file); modified files are identified by the commits on this branch.
