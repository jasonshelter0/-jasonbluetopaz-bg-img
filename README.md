# Jason Blue Topaz BG

One-command wallpaper updater for the Blue Topaz fork. Pick a picture → done.

## One-time setup

1. **GitHub PAT** — GitHub → Settings → Developer settings → Personal access tokens.
   Create a token with `repo` scope, paste it into *Settings → Jason Blue Topaz BG → GitHub PAT*.
2. **Theme toggle** — in the Blue Topaz theme, leave the *Activate Image Background*
   toggle ON. The plugin overrides the image via a `--theme-background` CSS snippet.

## Daily workflow

1. Drop wallpapers into the `Wallpapers/` folder (configurable in settings).
2. Run the **"Update wallpaper"** command.
3. Pick **Light** or **Dark**, then pick an image.

The plugin uploads to GitHub (`wallpaper-light.jpg` / `wallpaper-dark.jpg`), purges
jsDelivr, bumps `?v=N`, writes and enables the `qa-wallpaper.css` snippet, and reloads —
with every step logged to the console under `[JBT-BG]`.

## Notes

- The PAT is stored in the OS keychain (Obsidian secret storage, 1.11.4+) when
  available, otherwise base64-obfuscated in `data.json`. Never logged.
- Both the CDN purge (12 h) *and* the `?v=` bump (7-day browser cache) are required.
- The snippet lives outside `theme.css`, so it survives theme updates.
