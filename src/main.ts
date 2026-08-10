import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { app, BrowserWindow, dialog, session, globalShortcut, shell, Menu, ipcMain, net } from 'electron';
import { createTorrentsWindow } from './torrents.js'
import pkg from 'electron-updater';
import path from "node:path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { appStore as store } from './app-store.js';
import { loadWindowState, showWindowWithState, trackWindowState } from './window-state.js';
import {
  DEFAULT_HOTKEYS,
  HOTKEY_META,
  loadHotkeys,
  saveHotkeys,
  type HotkeyAction,
  type HotkeyMap,
} from './hotkeys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { autoUpdater } = pkg;

const APP_NAME = `Raspberry ${app.getVersion()}`;

let mainWindow: BrowserWindow | null = null;
let appConfig: AppConfig | null = null;

const isDebug = !app.isPackaged;

const ADBLOCK_BUNDLED_PATH = path.join(__dirname, '../prebuilts/adblock.txt');
const ADBLOCK_LIST_URL =
  'https://easylist-downloads.adblockplus.org/ruadlist+easylist.txt';
const ADBLOCK_PROXY_URL = `https://starege.rte.net.ru/${ADBLOCK_LIST_URL}`;

let adblockBlocker: ElectronBlocker | null = null;
let adblockUpdating = false;

function getAdblockCachePath(): string {
  return path.join(app.getPath('userData'), 'adblock', 'ruadlist_easylist.txt');
}

function readAdblockRaw(): string {
  const cachePath = getAdblockCachePath();
  try {
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
      return fs.readFileSync(cachePath, 'utf-8');
    }
  } catch (e) {
    console.error('Failed to read adblock cache:', e);
  }
  return fs.readFileSync(ADBLOCK_BUNDLED_PATH, 'utf-8');
}

async function downloadAdblockList(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const startedAt = Date.now();
    const response = await net.fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.warn(`AdBlock download failed: HTTP ${response.status}`);
      return null;
    }
    const body = await response.text();
    if (!body || body.length < 10_000 || !body.includes('[Adblock')) {
      console.warn(`AdBlock download rejected: not a filter list (${body?.length ?? 0} bytes)`);
      return null;
    }
    console.log(
      `AdBlock downloaded ${body.length} bytes from ${url} in ${Date.now() - startedAt} ms`,
    );
    return body;
  } catch (e) {
    console.warn(`AdBlock download error from ${url}:`, e);
    return null;
  }
}

const ADBLOCK_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

function shouldUpdateAdblock(): boolean {
  const cachePath = getAdblockCachePath();
  try {
    if (!fs.existsSync(cachePath)) return true;
    const ageMs = Date.now() - fs.statSync(cachePath).mtimeMs;
    if (ageMs < ADBLOCK_UPDATE_INTERVAL_MS) {
      console.log(
        `AdBlock update skipped: last update ${Math.round(ageMs / 60_000)} min ago`,
      );
      return false;
    }
  } catch {
    return true;
  }
  return true;
}

async function updateAdblockInBackground(ses: Electron.Session): Promise<void> {
  if (adblockUpdating) return;
  if (!shouldUpdateAdblock()) return;
  adblockUpdating = true;
  try {
    const raw =
      (await downloadAdblockList(ADBLOCK_LIST_URL, 12_000)) ??
      (await downloadAdblockList(ADBLOCK_PROXY_URL, 60_000));
    if (!raw) {
      console.warn('AdBlock update failed: list unavailable');
      return;
    }

    const cachePath = getAdblockCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp`;
    fs.writeFileSync(tmp, raw, 'utf-8');
    try {
      fs.renameSync(tmp, cachePath);
    } catch {
      fs.writeFileSync(cachePath, raw, 'utf-8');
      try {
        fs.unlinkSync(tmp);
      } catch {
      }
    }

    const newBlocker = ElectronBlocker.parse(raw);
    if (adblockBlocker) {
      adblockBlocker.disableBlockingInSession(ses);
    }
    newBlocker.enableBlockingInSession(ses);
    adblockBlocker = newBlocker;
    console.log('AdBlock filters updated');
  } catch (e) {
    console.error('AdBlock update failed:', e);
  } finally {
    adblockUpdating = false;
  }
}

autoUpdater.autoInstallOnAppQuit = true;
if (process.platform === 'darwin') {
  autoUpdater.autoDownload = false;
}

const _k = 0x5A;
const _d = (h: string) => { const r: number[] = []; for (let i = 0; i < h.length; i += 2) r.push(parseInt(h.substring(i, i + 2), 16) ^ _k); return Buffer.from(r).toString(); };
let main_site_url = _d('322e2e2a29607575283b292a383f282823742a2f38');
let deep_link_data: String | null;

let cachedBase64Credentials: string | null = null;

async function fetchRemoteConfig(): Promise<void> {
  if (!cachedBase64Credentials) return;
  try {
    const response = await net.fetch(`${main_site_url}/api/config`, {
      headers: {
        'Authorization': `Basic ${cachedBase64Credentials}`
      },
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok) {
      appConfig = await response.json();
      // Keep localhost during local testing; do not override from remote config
      if (appConfig?.main_site_url && !main_site_url.includes('localhost')) {
        main_site_url = appConfig.main_site_url;
      }
      console.log('Remote config loaded successfully');
    } else {
      console.error('Failed to fetch remote config:', response.status);
    }
  } catch (error) {
    console.error('Error fetching remote config:', error);
  }
}

async function updateCachedCredentials(): Promise<void> {
  if (!mainWindow) return;
  try {
    const authData = await mainWindow.webContents.executeJavaScript(`localStorage.getItem('siteAuth')`);
    if (authData) {
      const parsed = JSON.parse(authData);
      if (parsed.credentials) {
        cachedBase64Credentials = parsed.credentials;
        if (!appConfig) {
          await fetchRemoteConfig();
        }
        return;
      }
    }
  } catch {}
  cachedBase64Credentials = null;
}

function createMacOSMenu(): Menu | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  return Menu.buildFromTemplate([
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]);
}

function setMainWindowMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(createMacOSMenu());
  }
}

const reload = (): void => {
  if (mainWindow?.webContents.getURL().includes("loader.html")) {
    mainWindow?.loadURL(main_site_url!);
  } else {
    mainWindow?.reload();
  }
};

const reloadIgnoringCache = (): void => {
  if (mainWindow?.webContents.getURL().includes("loader.html")) {
    mainWindow?.loadURL(main_site_url!);
  } else {
    mainWindow?.webContents.reloadIgnoringCache();
  }
};

const showUpdateAvailableDialog = (): void => {
  if (mainWindow != null) {
    dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'info',
      title: `Обновление загружено`,
      message: `Установить сейчас? Иначе оно автоустановится после закрытия приложения`,
      buttons: ['Позже', 'Установить', 'Список изменений'],
    }).then((result) => {
      if (result.response === 1) {
        autoUpdater.quitAndInstall();
      } else if (result.response === 2) {
        shell.openExternal('https://github.com/mazda1337/raspberry-desktop/releases');
        showUpdateAvailableDialog();
      }
    });
  }
}

async function getMetaContent(selector: string) {
  try {
    const content = await mainWindow?.webContents.executeJavaScript(
      `document.querySelector('meta[name="${selector}"]').content`
    );
    return content || '';
  } catch (error) {
    return '';
  }
}

async function openTorrents() {
  await updateCachedCredentials();
  if (!cachedBase64Credentials) {
    mainWindow?.webContents.executeJavaScript(
      `window.electronAPI.showToast('Необходимо войти в аккаунт')`
    );
    return;
  }
  if (!appConfig) {
    mainWindow?.webContents.executeJavaScript(
      `window.electronAPI.showToast('Конфигурация загружается, попробуйте снова')`
    );
    return;
  }
  const titleAndYear = await getMetaContent('title-and-year');
  const altName = await getMetaContent('original-title');

  const match = titleAndYear.match(/^(.*?)\s*\((\d{4})\)$/);
  const title = match ? match[1].trim() : titleAndYear.replace(/\s*\(.*\)$/, "");
  const year = match ? match[2] : null;

  createTorrentsWindow(title, year, altName, appConfig, cachedBase64Credentials);
}

const logout = (): void => {
  if (!mainWindow) return;
  dialog.showMessageBox(mainWindow, {
    noLink: true,
    type: 'question',
    title: 'Выйти',
    message: 'Выйти из аккаунта?',
    buttons: ['Отмена', 'Выйти'],
    defaultId: 0,
    cancelId: 0,
  }).then((result) => {
    if (result.response !== 1) return;
    mainWindow?.webContents.executeJavaScript(`localStorage.removeItem('siteAuth')`).then(() => {
      cachedBase64Credentials = null;
      mainWindow?.reload();
    });
  });
};

const switchBlurVideo = (): void => {
  // Prefer renderer toggle so manualBlurEnabled stays in sync (pause/style wipe reconcile).
  mainWindow?.webContents.executeJavaScript(`
    (function() {
      if (typeof window.toggleBlur === 'function') {
        window.toggleBlur();
        return true;
      }
      // Fallback if player page is not mounted yet
      return null;
    })()
  `).then((handled) => {
    if (handled) return;
    executeInVideoFrame(`
      (function() {
        const video = document.querySelector('video');
        if (!video) return null;
        const hasBlur = !!(video.style.filter && video.style.filter.includes('blur'));
        const prev = video.style.getPropertyValue('transition');
        const prevPri = video.style.getPropertyPriority('transition');
        video.style.setProperty('transition', 'none', 'important');
        video.style.setProperty('-webkit-transition', 'none', 'important');
        video.style.filter = hasBlur ? '' : 'blur(50px)';
        void video.offsetWidth;
        if (prev) video.style.setProperty('transition', prev, prevPri || '');
        else video.style.removeProperty('transition');
        video.style.removeProperty('-webkit-transition');
        return true;
      })()
    `).catch(() => {});
  }).catch(() => {});
};

const switchCompressor = (): void => {
  mainWindow?.webContents.executeJavaScript('window.toggleCompressor();');
};

async function executeInVideoFrame(script: string): Promise<any> {
  if (!mainWindow) return null;
  try {
    for (const frame of mainWindow.webContents.mainFrame.framesInSubtree) {
      if (frame === mainWindow.webContents.mainFrame) continue;
      try {
        const result = await frame.executeJavaScript(script);
        if (result !== null && result !== undefined) return result;
      } catch (e) {
      }
    }
  } catch (e) {}
  return null;
}

function showSpeedToast(rate: number | null): void {
  if (rate !== null && mainWindow) {
    mainWindow.webContents.executeJavaScript(
      `window.electronAPI.showToast('Текущая скорость: ${rate}x')`
    );
  }
}

const increasePlaybackSpeed = (): void => {
  executeInVideoFrame(`
    (function() {
      const video = document.querySelector('video');
      if (!video) return null;
      if (video.playbackRate < 4.0) video.playbackRate += 0.25;
      return video.playbackRate;
    })()
  `).then(showSpeedToast);
};

const decreasePlaybackSpeed = (): void => {
  executeInVideoFrame(`
    (function() {
      const video = document.querySelector('video');
      if (!video) return null;
      if (video.playbackRate > 0.25) video.playbackRate -= 0.25;
      return video.playbackRate;
    })()
  `).then(showSpeedToast);
};

const resetPlaybackSpeed = (): void => {
  executeInVideoFrame(`
    (function() {
      const video = document.querySelector('video');
      if (!video) return null;
      video.playbackRate = 1.0;
      return video.playbackRate;
    })()
  `).then(showSpeedToast);
};

const switchMirror = (): void => {
  mainWindow?.webContents.executeJavaScript('window.toggleMirror();');
};

const toggleMenu = (): void => {
  const toggleMenuScript = `
    (function() {
      try {
        const menu = document.getElementById('reyohoho-top-menu');
        if (!menu) {
          console.log('Menu not found');
          return;
        }
        
        const isCurrentlyHidden = menu.getAttribute('data-hidden') === 'true';
        
        if (isCurrentlyHidden) {
          menu.style.display = 'flex';
          menu.setAttribute('data-hidden', 'false');
          document.body.style.setProperty('padding-top', '48px', 'important');
          
          const sidePanels = document.querySelectorAll('.side-panel, aside.side-panel, .nav-component aside');
          if (sidePanels && sidePanels.length > 0) {
            sidePanels.forEach(sidePanel => {
              if (sidePanel && sidePanel.style) {
                sidePanel.style.setProperty('top', '48px', 'important');
                sidePanel.style.setProperty('height', 'calc(100vh - 48px)', 'important');
              }
            });
          }
        } else {
          menu.style.display = 'none';
          menu.setAttribute('data-hidden', 'true');
          document.body.style.setProperty('padding-top', '0', 'important');
          
          const sidePanels = document.querySelectorAll('.side-panel, aside.side-panel, .nav-component aside');
          if (sidePanels && sidePanels.length > 0) {
            sidePanels.forEach(sidePanel => {
              if (sidePanel && sidePanel.style) {
                sidePanel.style.setProperty('top', '0', 'important');
                sidePanel.style.setProperty('height', '100vh', 'important');
              }
            });
          }
        }
      } catch (error) {
        console.error('Error toggling menu:', error);
      }
    })();
  `;
  mainWindow?.webContents.executeJavaScript(toggleMenuScript).catch(err => {
    console.error('Failed to toggle menu:', err);
  });
};

if (!AbortSignal.timeout) {
  AbortSignal.timeout = function timeout(ms: number): AbortSignal {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
  };
}

export interface AppConfig {
  main_site_url: string,
  torrent_parser_url: string,
  torrent_parser_url2: string,
  alloha_origin_url: string,
  alloha_referer: string,
  alloha_cdn_filter_url: string,
  lumex_origin_url: string,
  lumex_referer: string,
  lumex_cdn_filter_url: string,
  url_handler_deny: string,
  monitor_server_url?: string,
  torr_server_urls: string[],
  torr_server_locations: string[],
  torr_server_ids?: string[],
  torr_server_speedtest_urls: string[],
}

function loadConfig(): void {
  try {
    const cacheHost = _d('283b292a383f282823742a2f38');
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
      try {
        // Auth for cache requests
        const url = new URL(details.url);
        if (url.hostname === cacheHost && url.pathname.startsWith('/cache')) {
          if (cachedBase64Credentials) {
            details.requestHeaders['Authorization'] = `Basic ${cachedBase64Credentials}`;
          }
        }

        callback({ requestHeaders: details.requestHeaders });
      } catch (e) {
        console.error('Error in onBeforeSendHeaders:', e);
        callback({ requestHeaders: details.requestHeaders });
      }
    });

    (async () => {
      await session.defaultSession.clearCache();
      createWindow();
    })();
  } catch (error) {
    console.error('Error load config:', error);
    createWindow();
  }
}

function getHotkeyActionHandler(action: HotkeyAction): (() => void) | null {
  switch (action) {
    case 'torrents':
      return openTorrents;
    case 'blur':
      return switchBlurVideo;
    case 'compressor':
      return switchCompressor;
    case 'mirror':
      return switchMirror;
    case 'reload':
      return reload;
    case 'speedDown':
      return decreasePlaybackSpeed;
    case 'speedReset':
      return resetPlaybackSpeed;
    case 'speedUp':
      return increasePlaybackSpeed;
    case 'toggleMenu':
      return toggleMenu;
    default:
      return null;
  }
}

function syncHotkeysToRenderer(map?: HotkeyMap): void {
  const hotkeys = map || loadHotkeys(store);
  const json = JSON.stringify(hotkeys);
  mainWindow?.webContents
    .executeJavaScript(
      `
      (function() {
        window.__reyoHotkeys = ${json};
        try { localStorage.setItem('reyoHotkeys', JSON.stringify(window.__reyoHotkeys)); } catch (e) {}
        window.dispatchEvent(new CustomEvent('reyo-hotkeys-changed', { detail: window.__reyoHotkeys }));
        if (typeof window.__reyoUpdateHotkeyLabels === 'function') window.__reyoUpdateHotkeyLabels();
      })();
    `,
    )
    .catch(() => {});
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const hotkeys = loadHotkeys(store);
  for (const meta of HOTKEY_META) {
    if (!meta.global) continue;
    const accel = hotkeys[meta.action];
    if (!accel) continue;
    const handler = getHotkeyActionHandler(meta.action);
    if (!handler) continue;
    try {
      const ok = globalShortcut.register(accel, handler);
      if (!ok) console.warn('Hotkey already in use:', accel, meta.action);
    } catch (e) {
      console.warn('Failed to register hotkey', accel, meta.action, e);
    }
  }
  try {
    globalShortcut.register('CommandOrControl+F5', reloadIgnoringCache);
  } catch {
    /* ignore */
  }
}


async function createWindow(): Promise<void> {
  const windowState = loadWindowState(store, 'mainWindowState', 'bounds');

  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      x: windowState.x,
      y: windowState.y,
      width: windowState.width,
      height: windowState.height,
      darkTheme: true,
      backgroundColor: "#000",
      icon: path.join(__dirname, '..', 'icons', '256x256.png'),
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        devTools: false,
      }
    });

    trackWindowState(mainWindow, store, 'mainWindowState');

    mainWindow.once('ready-to-show', () => {
      if (!mainWindow) return;
      showWindowWithState(mainWindow, windowState);
      if (isDebug) {
        mainWindow.webContents.openDevTools();
      }
    });
  } else {
    showWindowWithState(mainWindow, windowState);
  }

  if (process.platform === 'darwin') {
    setMainWindowMenu();
  } else {
    mainWindow.setMenu(null);
  }
  mainWindow?.loadFile("loader.html");

  mainWindow.setTitle(APP_NAME + ' Loading ....');
  autoUpdater.checkForUpdatesAndNotify();

  try {
    const adblockRaw = readAdblockRaw();
    adblockBlocker = ElectronBlocker.parse(adblockRaw);
  } catch (e) {
    console.log(e);
    if (mainWindow != null) {
      dialog.showMessageBox(mainWindow, {
        noLink: true,
        type: 'error',
        title: `Произошла ошибка при загрузке AdBlock`,
        message: `${e}`
      })
    }
  }

  mainWindow.webContents.on('did-start-loading', () => {
    mainWindow?.setTitle(APP_NAME + ' Loading ....');
  });

  mainWindow.webContents.on('did-stop-loading', () => {
    mainWindow?.setTitle(APP_NAME);
  });

  const webSession = mainWindow.webContents.session;
  adblockBlocker?.enableBlockingInSession(webSession);
  void updateAdblockInBackground(webSession);

  mainWindow?.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.insertCSS(`
      ::-webkit-scrollbar {
        width: 5px;
      }
      ::-webkit-scrollbar-track {
        background: #292929;
      }
      ::-webkit-scrollbar-thumb {
        background: #9f9f9f;
        border-radius: 5px;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: #d1d1d1;
      }
    `);
    
    // Inject top menu bar
    const currentUrl = mainWindow?.webContents.getURL() || '';
    if (!currentUrl.includes('loader.html') && !currentUrl.includes('magnet-input.html') && !currentUrl.includes('torrent-wizard.html')) {
      const hotkeysForMenu = loadHotkeys(store);
      const hotkeysJson = JSON.stringify(hotkeysForMenu);
      const hotkeyMetaJson = JSON.stringify(HOTKEY_META);
      mainWindow?.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('reyohoho-top-menu')) return;

          window.__reyoHotkeys = ${hotkeysJson};
          window.__reyoHotkeyMeta = ${hotkeyMetaJson};
          try { localStorage.setItem('reyoHotkeys', JSON.stringify(window.__reyoHotkeys)); } catch (e) {}

          function fmtHotkey(accel) {
            if (!accel) return '—';
            return String(accel)
              .replace(/CommandOrControl/gi, 'Ctrl')
              .replace(/Command/gi, 'Cmd')
              .replace(/Control/gi, 'Ctrl');
          }
          
          const menuBar = document.createElement('div');
          menuBar.id = 'reyohoho-top-menu';
          menuBar.innerHTML = \`
            <style>
              #reyohoho-top-menu {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                height: 48px;
                background: #0a0a0a;
                box-shadow: 0 2px 8px rgba(0,0,0,0.8);
                z-index: 2147483647 !important;
                display: flex;
                align-items: center;
                padding: 0 16px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                user-select: none;
                border-bottom: 1px solid #1a1a1a;
                overflow: hidden;
              }
              #reyohoho-top-menu .menu-logo {
                font-size: 17px;
                font-weight: 700;
                color: #ffffff;
                margin-right: 24px;
                flex-shrink: 0;
              }
              #reyohoho-top-menu .menu-items {
                display: flex;
                gap: 6px;
                flex: 1;
                align-items: center;
                overflow-x: auto;
                overflow-y: hidden;
                min-width: 0;
                padding-bottom: 2px;
              }
              #reyohoho-top-menu .menu-items::-webkit-scrollbar {
                height: 3px;
              }
              #reyohoho-top-menu .menu-items::-webkit-scrollbar-track {
                background: transparent;
              }
              #reyohoho-top-menu .menu-items::-webkit-scrollbar-thumb {
                background: #2a2a2a;
                border-radius: 3px;
              }
              #reyohoho-top-menu .menu-items::-webkit-scrollbar-thumb:hover {
                background: #3a3a3a;
              }
              #reyohoho-top-menu .menu-btn {
                background: #1a1a1a;
                border: 1px solid #2a2a2a;
                color: #b0b0b0;
                padding: 7px 12px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                transition: all 0.15s ease;
                white-space: nowrap;
                font-weight: 500;
                position: relative;
                display: flex;
                align-items: center;
                gap: 6px;
                flex-shrink: 0;
              }
              #reyohoho-top-menu .menu-btn .btn-text {
                display: inline;
              }
              #reyohoho-top-menu .menu-btn .hotkey {
                font-size: 10px;
                background: #2a2a2a;
                padding: 2px 5px;
                border-radius: 3px;
                color: #666;
                font-weight: 600;
                border: 1px solid #333;
              }
              #reyohoho-top-menu .menu-btn:hover {
                background: #2a2a2a;
                border-color: #444;
                color: #ffffff;
                transform: translateY(-1px);
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);
              }
              #reyohoho-top-menu .menu-btn:hover .hotkey {
                background: #ffffff;
                color: #000;
                border-color: #ffffff;
              }
              #reyohoho-top-menu .menu-btn:active {
                transform: translateY(0);
              }
              #reyohoho-top-menu .menu-btn.primary {
                background: #ffffff;
                border-color: #ffffff;
                color: #000;
                font-weight: 600;
              }
              #reyohoho-top-menu .menu-btn.primary .hotkey {
                background: rgba(0,0,0,0.15);
                color: #000;
                border-color: rgba(0,0,0,0.2);
              }
              #reyohoho-top-menu .menu-btn.primary:hover {
                background: #e0e0e0;
                transform: translateY(-1px);
                box-shadow: 0 2px 8px rgba(255,255,255,0.2);
              }
              #reyohoho-top-menu .menu-btn.active {
                background: #4a4a4a;
                border-color: #666;
                color: #ffffff;
              }
              #reyohoho-top-menu .menu-btn.active .hotkey {
                background: #666;
                color: #fff;
              }
              #reyohoho-top-menu .menu-divider {
                width: 1px;
                height: 28px;
                background: #2a2a2a;
                margin: 0 8px;
                flex-shrink: 0;
              }
              #reyohoho-top-menu .player-control {
                display: flex;
              }
              #reyohoho-top-menu .player-control.hidden {
                display: none !important;
              }
              #reyohoho-top-menu .auth-required.hidden {
                display: none !important;
              }
              body {
                padding-top: 48px !important;
              }
              /* Fix for site's side menu */
              .side-panel,
              aside.side-panel,
              .nav-component aside {
                top: 48px !important;
                height: calc(100vh - 48px) !important;
              }
              
              @media screen and (max-width: 1200px) {
                #reyohoho-top-menu .menu-btn .btn-text {
                  display: none;
                }
                #reyohoho-top-menu .menu-btn {
                  padding: 7px 10px;
                  gap: 0;
                }
                #reyohoho-top-menu .menu-btn i {
                  margin: 0;
                }
                #reyohoho-top-menu .menu-divider {
                  margin: 0 4px;
                }
              }
              
              @media screen and (max-width: 900px) {
                #reyohoho-top-menu .menu-logo {
                  font-size: 14px;
                  margin-right: 12px;
                }
                #reyohoho-top-menu {
                  padding: 0 8px;
                }
                #reyohoho-top-menu .menu-items {
                  gap: 4px;
                }
              }
              
              @media screen and (max-width: 600px) {
                #reyohoho-top-menu .hotkey {
                  display: none !important;
                }
                #reyohoho-top-menu .menu-logo {
                  font-size: 12px;
                  margin-right: 8px;
                }
                #reyohoho-top-menu .menu-btn {
                  padding: 6px 8px;
                }
              }
            </style>
            <div class="menu-items">
              <button class="menu-btn primary auth-required hidden" data-action="torrents" onclick="window.electronAPI.sendHotKey('torrents')">
                <i class="fas fa-film"></i> <span class="btn-text">Полка</span> <span class="hotkey" data-hotkey-for="torrents"></span>
              </button>
              <div class="menu-divider player-control"></div>
              <button id="blur-btn" class="menu-btn player-control" data-action="blur" onclick="window.electronAPI.sendHotKey('blur')">
                <i class="fas fa-eye-slash"></i> <span class="btn-text">Блюр</span> <span class="hotkey" data-hotkey-for="blur"></span>
              </button>
              <button id="compressor-btn" class="menu-btn player-control" data-action="compressor" onclick="window.electronAPI.sendHotKey('compressor')">
                <i class="fas fa-compress"></i> <span class="btn-text">Компрессор</span> <span class="hotkey" data-hotkey-for="compressor"></span>
              </button>
              <button id="mirror-btn" class="menu-btn player-control" data-action="mirror" onclick="window.electronAPI.sendHotKey('mirror')">
                <i class="fas fa-arrows-left-right"></i> <span class="btn-text">Отражение</span> <span class="hotkey" data-hotkey-for="mirror"></span>
              </button>
              <div class="menu-divider"></div>
              <button class="menu-btn" data-action="reload" onclick="location.reload()">
                <i class="fas fa-rotate"></i> <span class="btn-text">Обновить</span> <span class="hotkey" data-hotkey-for="reload"></span>
              </button>
              <div class="menu-divider player-control"></div>
              <button class="menu-btn player-control" data-action="speedDown" onclick="window.electronAPI.sendHotKey('speedDown')">
                <i class="fas fa-backward"></i> <span class="btn-text">-0.25x</span> <span class="hotkey" data-hotkey-for="speedDown"></span>
              </button>
              <button class="menu-btn player-control" data-action="speedReset" onclick="window.electronAPI.sendHotKey('speedReset')">
                <i class="fas fa-play"></i> <span class="btn-text">1.0x</span> <span class="hotkey" data-hotkey-for="speedReset"></span>
              </button>
              <button class="menu-btn player-control" data-action="speedUp" onclick="window.electronAPI.sendHotKey('speedUp')">
                <i class="fas fa-forward"></i> <span class="btn-text">+0.25x</span> <span class="hotkey" data-hotkey-for="speedUp"></span>
              </button>
              <div class="menu-divider"></div>
              <button class="menu-btn" data-action="toggleMenu" onclick="window.electronAPI.sendHotKey('toggleMenu')">
                <i class="fas fa-eye"></i> <span class="btn-text">Скрыть меню</span> <span class="hotkey" data-hotkey-for="toggleMenu"></span>
              </button>
              <div class="menu-divider"></div>
              <button class="menu-btn" id="hotkeys-settings-btn" title="Горячие клавиши">
                <i class="fas fa-keyboard"></i> <span class="btn-text">Клавиши</span>
              </button>
              <div class="menu-divider auth-required hidden"></div>
              <button class="menu-btn auth-required hidden" data-action="logout" onclick="window.electronAPI.sendHotKey('logout')">
                <i class="fas fa-right-from-bracket"></i> <span class="btn-text">Выйти</span>
              </button>
            </div>
          \`;
          
          document.body.insertBefore(menuBar, document.body.firstChild);

          window.__reyoUpdateHotkeyLabels = function() {
            const map = window.__reyoHotkeys || {};
            document.querySelectorAll('[data-hotkey-for]').forEach(function(el) {
              const action = el.getAttribute('data-hotkey-for');
              el.textContent = fmtHotkey(map[action] || '');
            });
          };
          window.__reyoUpdateHotkeyLabels();

          // Hotkeys settings modal
          if (!document.getElementById('reyo-hotkeys-modal')) {
            const modal = document.createElement('div');
            modal.id = 'reyo-hotkeys-modal';
            modal.innerHTML = \`
              <style>
                #reyo-hotkeys-modal { display:none; position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.65); align-items:center; justify-content:center; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
                #reyo-hotkeys-modal.open { display:flex; }
                #reyo-hotkeys-modal .hk-card { width:min(560px,92vw); max-height:80vh; overflow:auto; background:#121212; border:1px solid #2a2a2a; border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,0.55); color:#e8e8e8; }
                #reyo-hotkeys-modal .hk-head { display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border-bottom:1px solid #242424; position:sticky; top:0; background:#121212; }
                #reyo-hotkeys-modal .hk-head h3 { margin:0; font-size:16px; font-weight:650; }
                #reyo-hotkeys-modal .hk-close { background:#1a1a1a; border:1px solid #333; color:#ccc; border-radius:6px; padding:6px 10px; cursor:pointer; }
                #reyo-hotkeys-modal .hk-body { padding:12px 16px 16px; }
                #reyo-hotkeys-modal .hk-group { font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:#888; margin:14px 0 8px; }
                #reyo-hotkeys-modal .hk-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid #1e1e1e; }
                #reyo-hotkeys-modal .hk-label { font-size:13px; color:#ddd; }
                #reyo-hotkeys-modal .hk-bind { min-width:110px; text-align:center; background:#1a1a1a; border:1px solid #333; color:#fff; border-radius:6px; padding:7px 10px; cursor:pointer; font-size:12px; font-weight:600; }
                #reyo-hotkeys-modal .hk-bind.listening { border-color:#ff6b35; color:#ff6b35; box-shadow:0 0 0 1px rgba(255,107,53,0.35); }
                #reyo-hotkeys-modal .hk-actions { display:flex; gap:8px; margin-top:14px; }
                #reyo-hotkeys-modal .hk-actions button { flex:1; background:#1a1a1a; border:1px solid #333; color:#ddd; border-radius:6px; padding:9px 12px; cursor:pointer; font-size:13px; }
                #reyo-hotkeys-modal .hk-actions button.primary { background:#fff; color:#000; border-color:#fff; font-weight:600; }
                #reyo-hotkeys-modal .hk-hint { font-size:12px; color:#888; margin-top:10px; line-height:1.4; }
              </style>
              <div class="hk-card">
                <div class="hk-head">
                  <h3>Горячие клавиши</h3>
                  <button class="hk-close" type="button">Закрыть</button>
                </div>
                <div class="hk-body">
                  <div id="reyo-hotkeys-list"></div>
                  <div class="hk-actions">
                    <button type="button" id="reyo-hotkeys-reset">Сбросить</button>
                    <button type="button" class="primary" id="reyo-hotkeys-done">Готово</button>
                  </div>
                  <div class="hk-hint">Нажмите на сочетание, затем новую клавишу. Backspace — очистить, Esc — отмена. Конфликт снимается с другой команды автоматически.</div>
                </div>
              </div>
            \`;
            document.body.appendChild(modal);

            let listeningAction = null;
            const listEl = modal.querySelector('#reyo-hotkeys-list');

            function accelFromEvent(e) {
              const key = e.key;
              if (!key || key === 'Dead') return null;
              if (['Control','Alt','Shift','Meta','OS'].includes(key)) return null;
              if (key === 'Escape') return null;
              const parts = [];
              if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
              if (e.altKey) parts.push('Alt');
              if (e.shiftKey) parts.push('Shift');
              let main = key;
              if (/^f\\d{1,2}$/i.test(key)) main = key.toUpperCase();
              else if (key === ' ') main = 'Space';
              else if (key === 'ArrowUp') main = 'Up';
              else if (key === 'ArrowDown') main = 'Down';
              else if (key === 'ArrowLeft') main = 'Left';
              else if (key === 'ArrowRight') main = 'Right';
              else if (key === '+') main = 'Plus';
              else if (key.length === 1) main = key.toUpperCase();
              parts.push(main);
              return parts.join('+');
            }

            function renderHotkeyList() {
              const map = window.__reyoHotkeys || {};
              const meta = window.__reyoHotkeyMeta || [];
              let html = '';
              let lastGroup = '';
              meta.forEach(function(item) {
                if (item.group !== lastGroup) {
                  lastGroup = item.group;
                  html += '<div class="hk-group">' + (item.group === 'menu' ? 'Верхняя панель' : 'Кнопки под плеером') + '</div>';
                }
                html += '<div class="hk-row"><div class="hk-label">' + item.label + '</div>' +
                  '<button type="button" class="hk-bind" data-action="' + item.action + '">' + fmtHotkey(map[item.action] || '') + '</button></div>';
              });
              listEl.innerHTML = html;
              listEl.querySelectorAll('.hk-bind').forEach(function(btn) {
                btn.addEventListener('click', function() {
                  listEl.querySelectorAll('.hk-bind').forEach(function(b) { b.classList.remove('listening'); b.textContent = fmtHotkey((window.__reyoHotkeys || {})[b.getAttribute('data-action')] || ''); });
                  listeningAction = btn.getAttribute('data-action');
                  btn.classList.add('listening');
                  btn.textContent = 'Нажмите клавишу…';
                });
              });
            }

            function closeModal() {
              listeningAction = null;
              modal.classList.remove('open');
            }

            modal.querySelector('.hk-close').addEventListener('click', closeModal);
            modal.querySelector('#reyo-hotkeys-done').addEventListener('click', closeModal);
            modal.addEventListener('click', function(e) { if (e.target === modal) closeModal(); });
            modal.querySelector('#reyo-hotkeys-reset').addEventListener('click', function() {
              if (!window.electronAPI?.resetHotkeys) return;
              window.electronAPI.resetHotkeys().then(function(map) {
                window.__reyoHotkeys = map;
                try { localStorage.setItem('reyoHotkeys', JSON.stringify(map)); } catch (e) {}
                window.__reyoUpdateHotkeyLabels();
                renderHotkeyList();
                window.dispatchEvent(new CustomEvent('reyo-hotkeys-changed', { detail: map }));
                if (window.electronAPI.showToast) window.electronAPI.showToast('Клавиши сброшены');
              });
            });

            document.addEventListener('keydown', function(e) {
              if (!modal.classList.contains('open') || !listeningAction) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === 'Escape') {
                listeningAction = null;
                renderHotkeyList();
                return;
              }
              const action = listeningAction;
              let accel = '';
              if (e.key === 'Backspace' || e.key === 'Delete') {
                accel = '';
              } else {
                accel = accelFromEvent(e);
                if (!accel) return;
              }
              listeningAction = null;
              if (!window.electronAPI?.setHotkey) return;
              window.electronAPI.setHotkey(action, accel).then(function(map) {
                window.__reyoHotkeys = map;
                try { localStorage.setItem('reyoHotkeys', JSON.stringify(map)); } catch (err) {}
                window.__reyoUpdateHotkeyLabels();
                renderHotkeyList();
                window.dispatchEvent(new CustomEvent('reyo-hotkeys-changed', { detail: map }));
              }).catch(function(err) {
                console.warn(err);
                renderHotkeyList();
              });
            }, true);

            document.getElementById('hotkeys-settings-btn').addEventListener('click', function() {
              renderHotkeyList();
              modal.classList.add('open');
            });
          }
          
          // Check if iframe exists and toggle player controls visibility
          function updatePlayerControlsVisibility() {
            const hasIframe = document.querySelector('iframe.responsive-iframe') !== null;
            const playerControls = document.querySelectorAll('#reyohoho-top-menu .player-control');
            playerControls.forEach(control => {
              if (hasIframe) {
                control.classList.remove('hidden');
              } else {
                control.classList.add('hidden');
              }
            });
          }

          function updateAuthControlsVisibility() {
            let isLoggedIn = false;
            try {
              const authData = localStorage.getItem('siteAuth');
              if (authData) {
                const parsed = JSON.parse(authData);
                isLoggedIn = !!(parsed && parsed.credentials);
              }
            } catch (e) {}
            document.querySelectorAll('#reyohoho-top-menu .auth-required').forEach(function(el) {
              if (isLoggedIn) el.classList.remove('hidden');
              else el.classList.add('hidden');
            });
          }
          
          // Initial check
          updatePlayerControlsVisibility();
          updateAuthControlsVisibility();
          
          // Watch for DOM changes to detect iframe
          const observer = new MutationObserver(() => {
            updatePlayerControlsVisibility();
          });
          
          observer.observe(document.body, {
            childList: true,
            subtree: true
          });
          
          function updateButtonStates() {
            try {
              const blurBtn = document.getElementById('blur-btn');
              const compressorBtn = document.getElementById('compressor-btn');
              const mirrorBtn = document.getElementById('mirror-btn');
              
              if (!blurBtn || !compressorBtn || !mirrorBtn) return;
              
              // Check blur state via IPC to iframe
              const iframe = document.querySelector('iframe.responsive-iframe');
              if (iframe) {
                if (window.electronAPI && window.electronAPI.executeInIframe) {
                  window.electronAPI.executeInIframe(
                    "(function() { var v = document.querySelector('video'); return v ? v.style.filter.includes('blur') : false; })()"
                  ).then(function(isBlurred) {
                    if (isBlurred) {
                      blurBtn.classList.add('active');
                    } else {
                      blurBtn.classList.remove('active');
                    }
                  }).catch(function() {});
                }
                
                // Check compressor and mirror from localStorage (Pinia store persists to localStorage)
                try {
                  const playerStore = localStorage.getItem('player');
                  if (playerStore) {
                    const playerData = JSON.parse(playerStore);
                    
                    if (playerData.compressorEnabled) {
                      compressorBtn.classList.add('active');
                    } else {
                      compressorBtn.classList.remove('active');
                    }
                    
                    if (playerData.mirrorEnabled) {
                      mirrorBtn.classList.add('active');
                    } else {
                      mirrorBtn.classList.remove('active');
                    }
                  }
                } catch (e) {
                  // Error parsing localStorage
                }
              }
            } catch (error) {
              // Ignore errors
            }
          }
          
          // Update every 500ms
          setInterval(function() {
            updateButtonStates();
            updateAuthControlsVisibility();
          }, 500);
          updateButtonStates();
          updateAuthControlsVisibility();
        })();
      `);
    }

    // Update cached credentials from site's localStorage
    updateCachedCredentials();
    
    if (currentUrl.endsWith('loader.html') || currentUrl.startsWith('file://') && currentUrl.includes('loader.html')) {
      if (deep_link_data) {
        setTimeout(() => mainWindow?.loadURL(`${main_site_url!}/${deep_link_data}`), 100);
      } else {
        setTimeout(() => mainWindow?.loadURL(main_site_url!), 100);
      }
    }
  });

  mainWindow.on('closed', function () {
    mainWindow = null
  })

  mainWindow.on('focus', function () {
    registerHotkeys();
    setMainWindowMenu();
  })

  ipcMain.on('on-hotkey', (_event, action: HotkeyAction | string) => {
    // Backward-compatible: old F-keys from cached pages
    const legacy: Record<string, HotkeyAction> = {
      F1: 'torrents',
      F2: 'blur',
      F3: 'compressor',
      F4: 'mirror',
      F5: 'reload',
      F6: 'speedDown',
      F7: 'speedReset',
      F8: 'speedUp',
      F10: 'toggleMenu',
    };
    if (action === 'logout') {
      logout();
      return;
    }
    const resolved = (legacy[action] || action) as HotkeyAction;
    if (resolved === 'reload') {
      // Prefer page reload when triggered from menu button context
      mainWindow?.webContents.executeJavaScript('location.reload()').catch(() => reload());
      return;
    }
    const handler = getHotkeyActionHandler(resolved);
    if (handler) handler();
    else console.warn(`Unknown hotkey action: ${action}`);
  });

  ipcMain.removeHandler('get-hotkeys');
  ipcMain.handle('get-hotkeys', () => loadHotkeys(store));

  ipcMain.removeHandler('set-hotkey');
  ipcMain.handle('set-hotkey', (_event, action: HotkeyAction, accelerator: string) => {
    if (!HOTKEY_META.some((m) => m.action === action)) {
      throw new Error(`Unknown action: ${action}`);
    }
    const map = loadHotkeys(store);
    const nextAccel = typeof accelerator === 'string' ? accelerator.trim() : '';
    if (nextAccel) {
      for (const key of Object.keys(map) as HotkeyAction[]) {
        if (key !== action && map[key] === nextAccel) map[key] = '';
      }
    }
    map[action] = nextAccel;
    saveHotkeys(store, map);
    registerHotkeys();
    syncHotkeysToRenderer(map);
    return map;
  });

  ipcMain.removeHandler('reset-hotkeys');
  ipcMain.handle('reset-hotkeys', () => {
    saveHotkeys(store, { ...DEFAULT_HOTKEYS });
    registerHotkeys();
    syncHotkeysToRenderer(DEFAULT_HOTKEYS);
    return { ...DEFAULT_HOTKEYS };
  });

  mainWindow.webContents.on('context-menu', (e, props) => {
    if (props.formControlType === 'input-text') {
      const InputMenu = Menu.buildFromTemplate([{
        label: 'Cut',
        role: 'cut',
      }, {
        label: 'Copy',
        role: 'copy',
      }, {
        label: 'Paste',
        role: 'paste',
      }, {
        type: 'separator',
      }, {
        label: 'Select all',
        role: 'selectAll',
      },
      ]);
      InputMenu.popup();
    } else if (props.editFlags?.canCopy) {
      const InputMenu = Menu.buildFromTemplate([
        {
          label: 'Copy',
          role: 'copy',
        }
      ]);
      InputMenu.popup();
    }
  });

  mainWindow?.on('enter-full-screen', () => {
    mainWindow?.setMenuBarVisibility(false);
  });

  mainWindow?.on('leave-full-screen', () => {
    mainWindow?.setMenuBarVisibility(true);
  });

}

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient('reyohoho');

  const gotTheLock = app.requestSingleInstanceLock();
  
  if (!gotTheLock) {
    app.quit();
    return;
  }
  
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
      mainWindow.show();
    }
    
    if (process.platform === 'win32' || process.platform === 'linux') {
      const url = commandLine.find(arg => arg.startsWith('reyohoho://'));
      if (url && mainWindow) {
        deep_link_data = url.replace('reyohoho://', '');
        mainWindow.loadURL(`${main_site_url!}/${deep_link_data}`);
      }
    }
  });

  ipcMain.handle('get-app-config', () => {
    return appConfig;
  });

  ipcMain.handle('execute-in-iframe', async (_event, script: string) => {
    return await executeInVideoFrame(script);
  });

  ipcMain.handle('open-external', (event, url) => {
    shell.openExternal(url);
  });

  loadConfig();
  registerHotkeys();

  if (process.platform === 'win32' || process.platform === 'linux') {
    const url = process.argv.find(arg => arg.startsWith('reyohoho://'));
    if (url) {
      deep_link_data = url.replace('reyohoho://', '');
    }
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('reyohoho://')) {
    deep_link_data = url.replace('reyohoho://', '');
  }
});

app.on('web-contents-created', (e, wc) => {
  wc.setWindowOpenHandler((handler) => {
    try {
      console.log("setWindowOpenHandler: " + handler.url);
      BrowserWindow.getAllWindows().forEach(win => {
        if (win.getTitle() === "Авторизация") {
          win.close();
        }
      });
    } catch (e) { }

    const denyUrl = appConfig?.url_handler_deny || main_site_url;
    if (handler.url.startsWith(denyUrl)) {
      mainWindow?.loadURL(handler.url);
      return { action: "deny" };
    } else {
      shell.openExternal(handler.url);
      return { action: "deny" };
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('browser-window-blur', () => {
  globalShortcut.unregister('F1');
  globalShortcut.unregister('F2');
  globalShortcut.unregister('F3');
  globalShortcut.unregister('F4');
  globalShortcut.unregister('F5');
  globalShortcut.unregister('F6');
  globalShortcut.unregister('F7');
  globalShortcut.unregister('F8');
  globalShortcut.unregister('F9');
  globalShortcut.unregister('F10');
  // globalShortcut.unregister('F11');
  globalShortcut.unregister('CommandOrControl+F5');
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

autoUpdater.on('checking-for-update', () => {
  console.log('Checking for update...');
});

autoUpdater.on('update-not-available', (info) => {
  console.log('Update not available.', info);
});

autoUpdater.on('update-available', () => {
  if (mainWindow != null && process.platform === 'darwin') {
    dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'info',
      title: `Доступно обновление`,
      message: `Перейти на страницу загрузок?`,
      buttons: ['Позже', 'Перейти'],
    }).then((result) => {
      if (result.response === 1) {
        shell.openExternal('https://github.com/mazda1337/raspberry-desktop/releases');
      }
    });
  }
})

autoUpdater.on('error', (err) => {
  console.log('Error in auto-updater.', err);
});

autoUpdater.on('download-progress', (progressObj) => {
  let log_message = 'Download speed: ' + progressObj.bytesPerSecond;
  log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
  log_message = log_message + ' (' + progressObj.transferred + '/' + progressObj.total + ')';
  console.log(log_message);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded.', info);
  showUpdateAvailableDialog();
});

