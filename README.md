# pi-fullscreen-image-fix

A standalone Pi extension that fixes Kitty graphics protocol image display, scrolling, and cell-clearing artifacts in Pi's fullscreen TUI mode (`"tuiMode": "fullscreen"`).

Compatible across all terminals supporting Kitty graphics (Kitty, Ghostty, WezTerm) and fully cooperative with `pi-sidebar-tui`.

## The Problem

When running Pi in fullscreen TUI mode (`"tuiMode": "fullscreen"`) in a terminal that supports the Kitty graphics protocol:
1. **Slit-Scan Collapse**: Pi renders an image on row $N$, and returns empty strings on rows $N+1 \dots N+r-1$ to reserve vertical layout height. In `TuiAltScreen.doRender()`, Pi sequentially clears every row from top to bottom (`\x1b[2K` or `\x1b[118X`). As each placeholder row is erased, the terminal deletes the intersecting horizontal slice of the graphic, collapsing the image into a 1–2 row slit.
2. **Text Hole-Punching (Notch Artifact)**: In cell-anchored terminals like WezTerm, character cells reside beneath graphics. If placeholder row clearing is skipped or suppressed to avoid erasing the graphic, stale text characters from previous turns remain in those cells and punch holes through the texture.
3. **Sidebar Erasure**: Naive line-erasing (`\x1b[K` or `\x1b[2K`) extends across the full terminal width, wiping out docked sidebars (such as `pi-sidebar-tui`).

## The Solution: End-of-Frame Deferred Placement

Instead of trying to interleave cell erases row-by-row while an image is actively on screen:
1. **Normal Frame Clearing**: Pi and sidebar compositors render all terminal rows (1..rows) normally with width-limited line clears (`\x1b[118X`). Every cell underneath the graphic is cleanly blanked, all text adjacent to images is drawn, and sidebars remain untouched.
2. **End-of-Frame Placement**: Any Kitty graphics sequences in the buffer are extracted and deferred to the very end of the synchronized output block (`\x1b[?2026h ... \x1b[?2026l`), wrapped in VT100 save (`\x1b7` DECSC) and restore cursor (`\x1b8` DECRC).

### Guarantees:
- **No graphic erasure**: Because image placement occurs after all line clears have executed, no clear command ever touches the graphic.
- **No hole-punching**: All cells under the image are freshly blanked before placement.
- **Native 60 FPS scrolling**: Scrolled `a=p` placements are handled cleanly without heavy payload retransmissions.
- **Zero sidebar conflicts**: Sidebar columns are never overwritten or cleared.

## Installation

Add to `~/.pi/agent/settings.json` under `"packages"`:

```json
{
  "packages": [
    "../../code/pi_plugins/pi-fullscreen-image-fix"
  ]
}
```

Or copy/symlink to `~/.pi/agent/extensions/pi-fullscreen-image-fix`.

## Commands

- `/image-fix`: Display diagnostic stats (`framesProcessed`, `framesPatched`, `imagesPatched`).
- `/image-fix test`: Generate `test-pattern-64x64.png` in the current working directory to test image display.
- `/image-fix reset`: Reset counter stats.

## Testing

```bash
npm test
```

Runs the test suite using Node's built-in test runner:
- Buffer patching and idempotency tests (`tests/patch.test.ts`)
- Stdout write hook tests (`tests/hook.test.ts`)
- PNG generation tests (`tests/png.test.ts`)
- Fullscreen TUI integration tests (`tests/integration.test.ts`)
- Sidebar compatibility & scroll tests (`tests/sidebar-compatibility.test.ts`)
- Extension command registration tests (`tests/index.test.ts`)

## License

MIT
