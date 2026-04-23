# oh-my-pi icons

Generate the full icon set from a single source image (1024×1024 PNG preferred):

```
pnpm --filter @pi-gui/oh-my-pi exec tauri icon path/to/source.png
```

This produces `32x32.png`, `128x128.png`, `[email protected]`, `icon.icns`,
and platform-specific variants in this directory. The paths in
`src-tauri/tauri.conf.json` under `bundle.icon` reference the generated files.

Until the real source asset is provided, `cargo build` / `tauri build` will
fail with "icon file not found" — that's expected for the Slice 3 scaffold.
