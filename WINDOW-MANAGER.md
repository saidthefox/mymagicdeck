# Deck OS window manager — architecture

The mobile shell grew "one window at a time" (the site is *the* window; minimize reveals the desktop;
programs are centered modals with a scaled draggable mini). That model collides with itself on desktop,
where you want **several real windows at once**. The fix was a second presentation layer — a real
desktop window manager (`wm*`) — over the **shared program registry** (`MGW_APPS`). This is the
**as-built, blessed architecture**; the "phased migration" framing below it grew out of is done where it
needed to be, and the one remaining phase is deliberately *not* planned (see the end).

## The shape (what's actually true today)

**One registry, two form-factor shells:**

- **`MGW_APPS`** — the single registry every program is declared in (`{overlay, win, title, icon,
  open, close}`). Used by both shells; this is where a new program is added.
- **`mgw*` — the MOBILE shell.** Full / mini-drag / minimized states + a desktop-tray button, driven
  off `pc-deskmode` / `site-windowed` / `mgw-mini`. This is genuine, load-bearing mobile logic.
- **`wm*` — THE desktop window manager** (active when `body.wm-on`). Real floating, resizable windows
  with a Win95 title bar (`_ ▢ ✕`), a persistent taskbar, and a monotonic z-counter for focus. It has
  **no registry of its own** — it reads `MGW_APPS` for each program's title/icon/open/close.

**Desktop delegation.** On desktop the `mgw*` lifecycle functions are thin pass-throughs: each opens
with `if (wmEligible(key)) { wm…(key); return; }` (`mgwToFull`/`mgwMin`/`mgwToggleMini`/`mgwRestore`/
`mgwClose`, plus the CGG handlers `mgMinimize`/`mgMaxToggle`/`mgClose`/`mgLaunch`). So **`wm*` owns
every window on desktop** and `mgw*` only does real work on mobile. `wmEligible(key)` = `wmDesktop()
&& (it's a .modal program || it's in WM_SPECIAL)`; the builder/site has its own path
(`wmOpenSite`/`wmReleaseSite`), and `WM_SPECIAL = ['cgg','splash']` covers the two overlay-based
non-modal programs.

This replaced the `pc-deskmode` / `site-windowed` / `mgw-mini` class machinery **on desktop** (the
source of state collisions like "windowing a program closed the site window") with one consistent
`wm*` window lifecycle. On mobile that machinery is still the shell, by design.

## A WM window (the `wm*` model)

A window is a floating frame with a Win95 title bar, a body, and these behaviors:

- **drag** by the title bar, **resize** from the corner handle,
- **focus** = clicking brings it to front (single monotonic z-counter, `wmZ`),
- **minimize** → hidden, lives in the taskbar; **maximize** → fills the work area; **restore** → back to its floating rect,
- **close** → hidden + the program's `MGW_APPS[key].close()` runs.

A **persistent taskbar** (`#wm-taskbar`, fixed at the bottom, a direct child of `<body>` — *not*
inside the desktop) holds: Start · a button per open window (click = focus/restore, click active =
minimize) · Show-Desktop · a clock. A **desktop** (`#pc-desktop`) sits behind everything.

The builder (the site) is just another window (`#site-window`, via `wmOpenSite`); CGG, Splash, Share,
Storage, HUD, Recycle Bin, System Settings, About, Card Duel, and the rest are siblings.

### State (single source of truth)
`wmWins[key] = { el, state:'normal|max|min', rect:{x,y,w,h} }`, with focus tracked by `wmFocusedKey`
and z by `wmZ`. Geometry persists per key in `DeckOS.store` (`wm:rect:<key>`) so windows reopen where
you left them.

### Mode-aware (one WM, two layouts)
- **Desktop** (wide, `body.wm-on`): free-floating, overlapping, resizable windows.
- **Mobile** (`max-width:900px`, not `wm-on`): the `mgw*` shell — windows open maximized, one
  foreground at a time, switched via the taskbar + desktop.

## How we got here (history, for context)

The original plan was a phased migration toward a *single* WM for both form factors:

1. **WM core** — the desktop frame (drag/resize/min/max/restore/focus) + persistent taskbar + Start. **Done.**
2. **Builder + CGG + Splash as WM windows** — host the site/`#app`, CGG, and Splash in `wm*`, retiring
   the `#site-window` / `pc-deskmode` / `site-windowed` path **on desktop**. **Done.**
3. **Unify mobile** — route mobile through `wm*` (maximized mode) and retire the `mgw*` overlay/mini
   shell entirely. **Deliberately not planned** — see below.

## Why phase 3 is parked (and that's the call)

Converging mobile onto `wm*` is the high-risk, low-reward third of the migration. The value of the
migration — killing the desktop state-collision bugs — is **already banked** by phases 1–2. Mobile
already feels right (the Boox/iPhone path), and rewriting it onto `wm*` risks regressing that for no
user-visible gain. So the **end state is the as-built design**: shared `MGW_APPS` registry + a
form-factor shell each, with desktop's `mgw*` delegating into `wm*`. It's coherent and intentional,
not debt. If mobile ever needs richer multi-window behavior, phase 3 is the path — until then it stays parked.

## Invariants (keep these true)
- The **Classic toggle** always returns the plain three-panel builder (WM off, `body` clean).
- `tests/run.sh` green after every change; `frontend-check` ids stay valid.
- Mobile keeps its current feel (maximized windows + taskbar) via the `mgw*` shell.
- A new program is one `MGW_APPS` entry (or `DeckOS.registerProgram`) — it must work in both shells.
- No window can be dragged fully off-screen (clamp so the title bar stays reachable).

---
*Created 2026-06-16 by Claude (Opus 4.8) — Level-B desktop WM design.*
*Updated 2026-06-18 by Claude (Opus 4.8, via Claude Code) — rewritten to describe the as-built,
blessed architecture (phases 1–2 done, phase 3 parked) after confirming the desktop mgw*→wm*
delegation in code, per the architecture call.*
