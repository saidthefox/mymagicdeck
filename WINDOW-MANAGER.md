# Deck OS window manager — design

The mobile shell grew "one window at a time" (the site is *the* window; minimize reveals the desktop;
programs are centered modals with a scaled draggable mini). That model collides with itself on desktop,
where you want **several real windows at once**. This is the target architecture + the phased migration.

## Target model

One window manager (`wm*`) owns every window uniformly. A **window** is a floating frame with a Win95
title bar (icon · title · `_ ▢ ✕`), a body, and these behaviors:

- **drag** by the title bar, **resize** from the edges/corner,
- **focus** = clicking brings it to front (a single monotonic z-counter),
- **minimize** → hidden, lives in the taskbar; **maximize** → fills the work area; **restore** → back to its floating rect,
- **close** → gone (program's `onClose`).

A **persistent taskbar** (`#wm-taskbar`, fixed at the bottom, **always visible** in shell mode — *not*
rendered inside the desktop) holds: Start · a button per open window (click = focus/restore, click active =
minimize) · a clock. A **desktop** (`#pc-desktop`) sits behind everything with program/deck icons.

Every feature is a window: the **builder** (the site) is just window #1; CGG, Splash, Share, Storage, HUD,
Recycle Bin, System Settings, About, Card Duel are siblings.

### Mode-aware (one WM, two layouts)
- **Desktop** (wide): free-floating, overlapping, resizable windows.
- **Mobile** (`max-width:900px`): windows open **maximized**, one foreground at a time; the taskbar +
  desktop give the "switch apps" model. Same WM, `wm.mode==='mobile'` just pins geometry to maximized.

This replaces the `pc-deskmode` / `site-windowed` / `mgw-mini` class machinery (the source of state
collisions like "windowing a program closed the site window") with one consistent window lifecycle.

## State (single source of truth)

`wm.windows[id] = { id, title, icon, el, state:'normal|max|min', rect:{x,y,w,h}, z, onClose }`.
Geometry persists per id in `DeckOS.store` (`wm:rect:<id>`) so windows reopen where you left them.

## Phased migration (each phase ships green via tests/run.sh)

1. **WM core** — the frame (drag/resize/min/max/restore/focus), the persistent taskbar + Start, the
   desktop. Build clean + self-contained. Prove with the simple programs (About, System Settings,
   Storage, HUD, Bin, Share, Splash, Card Duel) opening as floating windows on desktop. *(this phase)*
2. **Builder as a window** — host the site/`#app` in a WM window (maximized by default); retire the
   `#site-window` / `pc-deskmode` / `site-windowed` path. Keep the Classic toggle (Classic = no WM).
3. **CGG + unify mobile** — host the guess-card as a WM window; route mobile through the WM in maximized
   mode; retire the old `mgw` overlay/mini code and the bespoke mobile shell.

## Invariants (keep these true)
- The **Classic toggle** always returns the plain three-panel builder (WM off, `body` clean).
- `tests/run.sh` green after every phase; `frontend-check` ids stay valid.
- Mobile keeps the current feel (maximized windows + taskbar), just driven by the WM.
- No window can be dragged fully off-screen (clamp to keep the title bar reachable).

---
*Created 2026-06-16 by Claude (Opus 4.8, via Claude Code) — Level-B desktop WM design.*
