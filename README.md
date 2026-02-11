# OpenClaw Chrome Extension (Browser Relay)

Purpose: attach OpenClaw to all Chrome tabs automatically so the Gateway can automate them (via the local CDP relay server).

## Dev / load unpacked

1. Build/run OpenClaw Gateway with browser control enabled.
2. Ensure the relay server is reachable at `http://127.0.0.1:18792/` (default).
3. Chrome → `chrome://extensions` → enable "Developer mode".
4. "Load unpacked" → select this directory.
5. Done. The extension auto-enables and attaches to all tabs. No clicks needed.

## Behavior

- **Auto-enabled on install**: connects to relay and attaches debugger to all tabs automatically.
- **Auto-reconnect**: if the relay is down, retries every 3 seconds until it comes back.
- **Auto re-attach**: if a tab's debugger is detached (e.g. DevTools), re-attaches with backoff retry.
- **New tabs**: automatically attached when opened or navigated.
- **Toggle off**: click the toolbar icon to disable. State persists across browser restarts.

## Options

- `Relay port`: defaults to `18792`.
