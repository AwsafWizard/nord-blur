# Nord Blur

Dark frosted-glass styling for **Pop!_OS 22.04 / GNOME Shell 42 on X11**,
with Nord cyan (`#88C0D0`) accents and 75% black glass app windows. It adds a
live background blur to:

- the system menu, the date/notification panel and every other shell popup menu
- the dock (Dash to Dock / Pop's dock) and notification banners
- Pop's Super-key launcher and other shell modal dialogs
- the volume/brightness OSD
- whole GTK app windows with client-side title bars (Files, Settings, gedit,
  System Monitor, Extensions, GNOME Terminal…)

GNOME Shell's CSS can't blur, so this is a shell extension plus a few
stylesheets rather than a plain theme.

> **Compatibility:** written and tested only on GNOME Shell 42.9, X11,
> Pop!_OS 22.04 (`metadata.json` declares `"shell-version": ["42"]`). It uses
> the GNOME 42 `imports.*` extension API, so it will **not** load on GNOME 45+
> (ES modules) without a port. Wayland is untested.

## Quick start

```bash
git clone https://github.com/AwsafWizard/nord-blur.git
cd nord-blur
./install.sh
```

Then restart GNOME Shell (X11: <kbd>Alt</kbd>+<kbd>F2</kbd>, type `r`,
<kbd>Enter</kbd>; Wayland: log out and back in) and reopen apps so they pick
up the GTK stylesheets.

Undo everything with:

```bash
./uninstall.sh
```

Optional: the top bar isn't blurred by this extension. The author uses
[Blur my Shell](https://github.com/aunetx/blur-my-shell) (v47, panel blur
only, brightness 0.6) alongside it.

## What `install.sh` changes

All files are **symlinked** from the clone, so edits in the repo apply
directly (see [Edit → reload loop](#edit--reload-loop)).

| Target | Change | Undone by `uninstall.sh` |
| --- | --- | --- |
| `~/.local/share/gnome-shell/extensions/nord-blur@awsaf` | symlink to `nord-blur@awsaf/`, added to `org.gnome.shell enabled-extensions` | yes (disabled + unlinked) |
| `~/.config/gtk-3.0/gtk.css` | symlink to `gtk-3.0/gtk.css` (an existing real file is moved to `gtk.css.bak`) | yes (`.bak` restored) |
| `~/.config/gtk-4.0/gtk.css` | symlink to `gtk-4.0/gtk.css` (same `.bak` handling) | yes |
| `org.gnome.shell.extensions.dash-to-dock` | `background-color '#121212'`, `background-opacity 0.55`, fixed transparency | yes, from `.dock-settings-backup` |
| GNOME Terminal default profile | `#121212` background, 25% transparency | yes, from `.terminal-settings-backup` |

The two `.…-backup` files are written into the repo directory on first
install and hold the user's previous values. They are git-ignored; don't
delete them while installed, or `uninstall.sh` can't restore those settings.

## Repository layout

```
nord-blur@awsaf/
  extension.js     # the blur engine (GJS, GNOME 42 legacy imports API)
  stylesheet.css   # shell CSS: translucent menus, calendar, sliders, toggles, banners
  metadata.json    # uuid nord-blur@awsaf, shell-version 42
  assets/          # toggle and calendar-event SVGs referenced by stylesheet.css
gtk-3.0/gtk.css    # GTK3 (Pop theme) overrides: glass windows/headerbars
gtk-4.0/gtk.css    # GTK4/libadwaita overrides via @define-color named colours
install.sh / uninstall.sh
```

## How it works

### Shell extension (`nord-blur@awsaf/extension.js`)

`Extension.enable()` starts six independent parts; each has `enable()` /
`disable()` and fully undoes its own patching:

| Class | Hooks | Puts glass under |
| --- | --- | --- |
| `MenuBlur` | patches `PopupMenu.PopupMenu.prototype.open` | every popup menu's box |
| `DockBlur` | `Main.uiGroup` `'actor-added'` (finds the dock container) | the dock background |
| `BannerBlur` | `Main.messageTray._bannerBin` `'actor-added'` | notification banners |
| `DialogBlur` | patches `ModalDialog.ModalDialog.prototype.open` | Pop launcher and other modal dialogs |
| `OsdBlur` | patches `OsdWindow.OsdWindow.prototype.show` | volume/brightness OSD |
| `WindowBlur` | `global.window_manager` `'map'` signal | client-decorated GTK windows |

The core is the `Glass` widget (an `St.Widget`). It does **not** read the
screen back. Instead it builds its own offscreen copy of what's behind it,
blurs that, and masks it:

1. `Clutter.Clone` of `Main.layoutManager._backgroundGroup` (the wallpaper),
   plus one `Clutter.Clone` per window actor that is stacked below the target.
2. `Shell.BlurEffect` in **ACTOR** mode on that copy, `sigma = SIGMA × scale`.
3. `RoundedMask`, a `Clutter.ShaderEffect` that cuts it to a rounded rect
   (radius from the target's CSS `border-radius`, clamped to half the short
   side, so `999px` pills work).

`GlassTracker` re-syncs every live glass on stage `before-update` /
`after-update`, so glasses follow windows and menus as they move.
`glassUnder()` positions a glass under a shell actor with
`FollowConstraint`.

### GTK stylesheets

- Window backgrounds are a `linear-gradient(rgba(0,0,0,0.75)…)` image over a
  transparent colour. An opaque `background-color` would make GTK mark the
  window opaque, and the compositor would skip drawing what's behind it.
- libadwaita/libhandy windows paint under their headerbar, so the gradient
  starts at 47px and the headerbar paints its own glass.
- Views, sidebars, lists and tabs are transparent; in-app menus and popovers
  are opaque `#0A0A0A` (nothing blurs under them).

## Tweaking

| What | Where |
| --- | --- |
| Blur strength | `SIGMA` (default 28) in `extension.js` |
| App window corner radius of the blur | `WINDOW_CORNER` (default 10) in `extension.js` |
| Shell menu glass opacity | alpha in `.popup-menu-content { background-color: rgba(18,18,18,0.62) }` in `stylesheet.css` |
| App window and title bar opacity | every `rgba(0, 0, 0, 0.75)` in both `gtk.css` files |
| In-app popover/menu colour | `#0A0A0A` in both `gtk.css` files |
| Accent colour | `#88C0D0` (and hover `#8FBCBB`) in `stylesheet.css` |
| Dock opacity | `gsettings set org.gnome.shell.extensions.dash-to-dock background-opacity 0.55` |
| Which windows get blur | `WindowBlur._wants()` in `extension.js` |

## Edit → reload loop

| You changed | To apply |
| --- | --- |
| `stylesheet.css` | `gnome-extensions disable nord-blur@awsaf && gnome-extensions enable nord-blur@awsaf` |
| `gtk-*/gtk.css` | close and reopen the app |
| `extension.js` / `metadata.json` | restart GNOME Shell (X11: Alt+F2 → `r`) |

Logs: `journalctl -f -o cat /usr/bin/gnome-shell`.

## Notes for AI agents working on this repo

Read this section before changing `extension.js`.

**Don't drive the user's live desktop.** Don't use `xdotool` or similar to
type into Alt+F2, Looking Glass or dialogs: if the prompt doesn't open, the
keystrokes land in whatever window has focus (possibly your own chat). Don't
`pkill` processes you didn't start. Prefer read-only checks (`journalctl`,
`gnome-extensions info`, screenshots, `xprop`), ask the user to restart the
shell, or test in a sandbox (below).

**GNOME 42 facts that cost real debugging time:**

- `Shell.BlurMode.BACKGROUND` ghosts and leaves stale stripes after partial
  redraws. ACTOR-mode blur on clones is the working approach. Don't switch back.
- A `Clutter.Clone` of `global.window_group` draws nothing. Clone
  `_backgroundGroup` and each window actor separately.
- Window glasses paint inside `global.window_group`, where Mutter's culling
  (`meta-cullable.c`) clips the wallpaper and windows to the redraw clip minus
  opaque windows, so the clones would cache holes. The fix is the
  pass-through `NoCull` `Clutter.Effect` on `_backgroundGroup` and on windows
  behind a window glass: meta-cullable skips actors that have effects.
  Menus, dock, banners and OSD paint in `uiGroup` after culling is reset and
  don't need it.
- Window glass is added on the WM `'map'` signal itself. Don't add a
  "settle" delay; it only made blur appear late.
- `glassUnder` must use `FollowConstraint`, not `BindConstraint`: a source that
  is still due a layout reports its preferred size *including margins* (Pop's
  OSD has `margin-bottom: 150px`), which stretched the glass into a blob.
- GJS turns whole numbers into int GValues, which float shader uniforms
  ignore; pass them through `asFloat()`.
- gnome-terminal's top-level CSS node is `terminal-window`, not `window`, so
  GTK selectors use `.csd`.
- GTK3 user CSS beats the theme regardless of selector specificity (it's a
  higher-priority provider), so overrides must exclude `:selected`, `:focus`,
  `.flat`, `.osd` etc. or they flatten those states. Pop's GTK3 theme
  hard-codes colours; libadwaita 1.1 follows `@define-color` names.

**Testing without touching the live session.** A headless shell in a
sandbox reproduces most bugs:

- Wrap everything in `bwrap` (`--ro-bind / /`, `--dev-bind /dev /dev`,
  `--tmpfs /run`, `--tmpfs /tmp`, `--unshare-net`, `--unshare-pid`,
  `--clearenv`, a throwaway `HOME`) with private `dbus-daemon --session`
  instances for the session and system buses, each with its own `HOME`.
  Bind the runtime dir somewhere short like `/run/nt`: Unix socket paths are
  capped at 108 bytes.
- Menus, OSD, banners (anything in `uiGroup`):
  `gnome-shell --headless --wayland --virtual-monitor 1280x800` is enough.
  `mkdir -m1777 /tmp/.X11-unix` first or Xwayland aborts the shell.
- Partial-redraw bugs (app window blur): the headless virtual monitor never
  does clipped redraws, so nest instead. Run a headless host shell, then a
  rootful `Xwayland :7 -geometry 1280x800` inside it, then
  `gnome-shell --display=:7` with this extension, and screenshot the host.
- A tiny helper extension that sets `global.context.unsafe_mode = true`
  unlocks `org.gnome.Shell.Eval` and the Screenshot D-Bus API. Call
  `Main.overview.hide()` after startup (the shell starts in the overview).
  Show the OSD with
  `Main.osdWindowManager.show(-1, Gio.ThemedIcon.new('audio-volume-high-symbolic'), 'Headset', 0.6, 1.5)`.
- Test windows: a small Python GTK3 app with CSS `rgba(0,0,0,0.75)`. Regression
  check: capture settled frames (open, move, focus change, maximize/restore)
  in both builds and diff pixels, ignoring the clock.
- Some bugs only show with Pop's session mode: run with `--mode=pop` and a
  copy of the user's dconf and extensions.

## Known limits

- Only GTK apps with client-side title bars get window glass. Chrome,
  Electron (VS Code, Discord, Spotify), Firefox and Qt apps draw their own
  title bars and stay opaque.
- The GTK stylesheets assume 47px headerbars (Pop's GTK3 theme and
  libadwaita); other heights show a thin seam.
- A window's blur only includes windows stacked below it.
- To keep each copy complete, the wallpaper and windows under a glass are
  always drawn in full, even where an opaque window hides them.
- Apps that paint their own opaque content (gedit's text area, web views)
  stay opaque there.
- Live blur costs GPU/CPU whenever what's behind a blurred area changes, e.g.
  a video playing under the dock or behind an app window.

## License

[MIT](LICENSE)
