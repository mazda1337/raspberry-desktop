import { BrowserWindow, Display, Rectangle, screen } from 'electron';

export interface SavedWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
  displayId?: number;
}

interface SimpleStore {
  get(key: string, defaultValue?: unknown): unknown;
  set(key: string, value: unknown): void;
}

function isValidBounds(b: Partial<Rectangle> | null | undefined): b is Rectangle {
  return (
    !!b &&
    typeof b.x === 'number' &&
    typeof b.y === 'number' &&
    typeof b.width === 'number' &&
    typeof b.height === 'number' &&
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height) &&
    b.width >= 200 &&
    b.height >= 150
  );
}

function boundsIntersectDisplay(bounds: Rectangle, display: Display): boolean {
  const d = display.bounds;
  return (
    bounds.x < d.x + d.width &&
    bounds.x + bounds.width > d.x &&
    bounds.y < d.y + d.height &&
    bounds.y + bounds.height > d.y
  );
}

function clampToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.max(200, Math.min(bounds.width, workArea.width));
  const height = Math.max(150, Math.min(bounds.height, workArea.height));
  const x = Math.min(
    Math.max(bounds.x, workArea.x),
    workArea.x + Math.max(0, workArea.width - width),
  );
  const y = Math.min(
    Math.max(bounds.y, workArea.y),
    workArea.y + Math.max(0, workArea.height - height),
  );
  return { x, y, width, height };
}

export function findDisplayForState(state: Pick<SavedWindowState, 'x' | 'y' | 'width' | 'height' | 'displayId'>): Display {
  const displays = screen.getAllDisplays();
  if (typeof state.displayId === 'number') {
    const byId = displays.find((d) => d.id === state.displayId);
    if (byId) return byId;
  }

  const rect: Rectangle = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  };
  if (isValidBounds(rect)) {
    const matching = screen.getDisplayMatching(rect);
    if (boundsIntersectDisplay(rect, matching)) return matching;

    const center = {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
    return screen.getDisplayNearestPoint(center);
  }

  return screen.getPrimaryDisplay();
}

export function getDisplayForWindow(win: BrowserWindow | null | undefined): Display {
  if (win && !win.isDestroyed()) {
    return screen.getDisplayMatching(win.getBounds());
  }
  return screen.getPrimaryDisplay();
}

export function loadWindowState(
  store: SimpleStore,
  key: string,
  legacyBoundsKey?: string,
): SavedWindowState {
  const primary = screen.getPrimaryDisplay();
  const fallback: SavedWindowState = {
    x: primary.workArea.x,
    y: primary.workArea.y,
    width: primary.workArea.width,
    height: primary.workArea.height,
    isMaximized: true,
    displayId: primary.id,
  };

  const raw = store.get(key) as Partial<SavedWindowState> | undefined;
  if (raw && isValidBounds(raw as Rectangle)) {
    const state: SavedWindowState = {
      x: raw.x!,
      y: raw.y!,
      width: raw.width!,
      height: raw.height!,
      isMaximized: raw.isMaximized !== false,
      displayId: typeof raw.displayId === 'number' ? raw.displayId : undefined,
    };
    const display = findDisplayForState(state);
    const clamped = clampToWorkArea(state, display.workArea);
    return {
      ...clamped,
      isMaximized: state.isMaximized,
      displayId: display.id,
    };
  }

  if (legacyBoundsKey) {
    const legacy = store.get(legacyBoundsKey) as Rectangle | undefined;
    if (isValidBounds(legacy)) {
      const display = screen.getDisplayMatching(legacy);
      const clamped = clampToWorkArea(legacy, display.workArea);
      return {
        ...clamped,
        isMaximized: true,
        displayId: display.id,
      };
    }
  }

  return fallback;
}

/** Place the window on the target display before show/maximize (critical on Linux). */
export function applyWindowState(win: BrowserWindow, state: SavedWindowState): void {
  const display = findDisplayForState(state);
  const clamped = clampToWorkArea(
    {
      x: state.x,
      y: state.y,
      width: state.width,
      height: state.height,
    },
    display.workArea,
  );

  win.setBounds(clamped);
  if (process.platform === 'linux') {
    // Some Linux WMs ignore setBounds alone for display affinity
    win.setPosition(clamped.x, clamped.y);
  }
}

/**
 * Show a window on the remembered display. Maximizes only after the window
 * is associated with that monitor — otherwise Linux often maximizes on the wrong one.
 */
export function showWindowWithState(win: BrowserWindow, state: SavedWindowState): void {
  const display = findDisplayForState(state);
  const wa = display.workArea;

  if (state.isMaximized !== false) {
    // Seed a visible frame on the target display so maximize stays there
    const seed = clampToWorkArea(
      {
        x: typeof state.x === 'number' ? state.x : wa.x,
        y: typeof state.y === 'number' ? state.y : wa.y,
        width: Math.max(800, Math.floor(wa.width * 0.85)),
        height: Math.max(600, Math.floor(wa.height * 0.85)),
      },
      wa,
    );
    win.setBounds(seed);
    if (process.platform === 'linux') {
      win.setPosition(seed.x, seed.y);
    }
    win.show();
    win.focus();

    const maximizeNow = () => {
      if (win.isDestroyed()) return;
      // Re-assert display right before maximize (Wayland/X11 race)
      if (process.platform === 'linux') {
        const current = screen.getDisplayMatching(win.getBounds());
        if (current.id !== display.id) {
          win.setBounds(seed);
          win.setPosition(seed.x, seed.y);
        }
      }
      win.maximize();
      win.focus();
    };

    if (process.platform === 'linux') {
      setTimeout(maximizeNow, 50);
    } else {
      maximizeNow();
    }
    return;
  }

  applyWindowState(win, state);
  win.show();
  win.focus();
}

export function centerBoundsOnDisplay(
  display: Display,
  width: number,
  height: number,
): Rectangle {
  const wa = display.workArea;
  return {
    x: wa.x + Math.max(0, Math.floor((wa.width - width) / 2)),
    y: wa.y + Math.max(0, Math.floor((wa.height - height) / 2)),
    width,
    height,
  };
}

export function trackWindowState(win: BrowserWindow, store: SimpleStore, key: string): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastState: SavedWindowState | null = null;

  const persist = (state: SavedWindowState) => {
    lastState = state;
    store.set(key, state);
  };

  const save = () => {
    if (win.isDestroyed()) {
      if (lastState) store.set(key, lastState);
      return;
    }
    try {
      const isMaximized = win.isMaximized();
      const isFullScreen = win.isFullScreen();
      const currentDisplay = screen.getDisplayMatching(win.getBounds());

      let bounds: Rectangle =
        (isMaximized || isFullScreen) && typeof win.getNormalBounds === 'function'
          ? win.getNormalBounds()
          : win.getBounds();

      // On Linux, normal bounds can remain on another monitor after moving while maximized
      if ((isMaximized || isFullScreen) && !boundsIntersectDisplay(bounds, currentDisplay)) {
        bounds = {
          x: currentDisplay.workArea.x,
          y: currentDisplay.workArea.y,
          width: Math.min(bounds.width, currentDisplay.workArea.width),
          height: Math.min(bounds.height, currentDisplay.workArea.height),
        };
      }

      persist({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: isMaximized || isFullScreen,
        displayId: currentDisplay.id,
      });
    } catch (e) {
      console.warn('Failed to save window state:', e);
    }
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 250);
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  // 'moved' fires after the WM finishes moving (important on Linux)
  win.on('moved', scheduleSave);
  win.on('maximize', save);
  win.on('unmaximize', save);
  win.on('enter-full-screen', save);
  win.on('leave-full-screen', save);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    save();
  });
  win.on('session-end', save);
}
