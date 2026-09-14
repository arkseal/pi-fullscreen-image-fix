# pi-fullscreen-image-fix

A standalone Pi package / extension that fixes Kitty graphics protocol image display and scrolling in Pi's fullscreen TUI mode (`--tui-mode fullscreen`).

## The Problem

When running Pi in fullscreen TUI mode (`"tuiMode": "fullscreen"` or `--tui-mode fullscreen`) in a terminal that supports the Kitty graphics protocol (such as Ghostty, Kitty, or WezTerm), reading an image (e.g. 64x64) only displays the top 2 rows of pixels. When scrolling down, the next 2 rows of pixels appear, creating a "slit-scan / scanner" effect where only 1 terminal cell row is visible at any time.

### Why This Happens

1. **Layout placeholder rows**: The `Image` component calculates the terminal height for the image (e.g. 30 rows for a 64x64 image scaled to 60 columns). It emits the Kitty escape sequence on row 1 and returns 29 empty placeholder strings (`""`) so the scroll layout allocates 30 rows of space.
2. **Line erase in redraw loop**: In `TuiAltScreen.doRender()`, Pi loops through every line of the screen and writes:
   ```ts
   buffer += `\x1b[${row + 1};1H\x1b[2K${lines[row] ?? ""}`;
   ```
3. **Graphic destruction**: When row 1 is rendered, the terminal draws the 30-row graphic. But on row 2, the loop moves down to render the empty placeholder line and issues `\x1b[2K` (Erase Line) or `\x1b[<N>X` (Erase Character from `pi-sidebar-tui`). In the Kitty graphics protocol, clearing cells erases the graphic slice occupying those cells. As the loop iterates over rows 2 through 30, it erases the graphic row-by-row, leaving only the first terminal row intact (~2 vertical pixels for 64px across 30 rows).
4. **Scrolling artifact**: When scrolling down by 1 line, Pi's `cropKittyImageLine` calculates `sourceY = Math.floor(64 * hiddenRows / 30) = 2` and places the cropped graphic at the top of the viewport. The loop then erases all subsequent lines again, showing only the next 2 rows of pixels.

## The Solution

This extension hooks into Pi's fullscreen TUI renderer:
1. When an image sequence with `r > 1` is detected on row $N$, it **pre-clears** rows $N \dots N + r - 1$ *before* emitting the graphic.
2. It repositions the cursor to row $N$ and emits the Kitty graphic sequence.
3. It **suppresses subsequent line erases** on the empty placeholder rows $N+1 \dots N + r - 1$.
4. Real text lines or overlay content are never suppressed.
5. Fully compatible with `pi-sidebar-tui` (supports width-limited erase `\x1b[<N>X` as well as standard `\x1b[2K`).

## Installation

### Option 1: Via Pi Settings `packages` (Recommended)

Add the plugin to `~/.pi/agent/settings.json` under `"packages"`:

```json
{
  "packages": [
    "../../code/pi_plugins/pi-fullscreen-image-fix"
  ]
}
```

Or from within Pi, run:
```
/package add ../../code/pi_plugins/pi-fullscreen-image-fix
```

### Option 2: Copy to Global Extensions

Copy or symlink `index.ts` (along with `hook.ts` and `patch.ts`) to `~/.pi/agent/extensions/pi-fullscreen-image-fix/`:

```bash
mkdir -p ~/.pi/agent/extensions/pi-fullscreen-image-fix
cp -r ~/code/pi_plugins/pi-fullscreen-image-fix/* ~/.pi/agent/extensions/pi-fullscreen-image-fix/
```

## Commands

- `/image-fix`: Display diagnostic statistics (installed status, frames processed, images protected).
- `/image-fix test` or `/image-fix generate-test`: Generate a 64x64 color checkerboard test PNG (`test-pattern-64x64.png`) in the current directory so you can test reading it immediately with `read test-pattern-64x64.png`.

## Running Tests

```bash
cd ~/code/pi_plugins/pi-fullscreen-image-fix
npm test
```

Runs 23 automated unit and integration tests using Node's built-in test runner.

## License

MIT
