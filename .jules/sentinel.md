## 2025-04-25 - Prevent External Links from Opening in Electron Main Window
**Vulnerability:** External links (e.g., from Markdown rendering) could open in the main Electron app window instead of the default browser, potentially leading to untrusted content running in a context with nodeIntegration or preload access.
**Learning:** Default Electron configuration allows window.open and top-level navigation, which is unsafe for an app that renders arbitrary user/agent-provided Markdown.
**Prevention:** Implement `window.webContents.setWindowOpenHandler` and `window.webContents.on("will-navigate", ...)` in the main process to intercept and route http/https requests to `shell.openExternal()`.
