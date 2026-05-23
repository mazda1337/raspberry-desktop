import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { app, BrowserWindow, dialog, session, globalShortcut, shell, screen, Menu, ipcMain, Rectangle, net } from 'electron';
import { createTorrentsWindow } from './torrents.js'
import Store from 'electron-store';
import pkg from 'electron-updater';
import path from "node:path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { createConnection as createTcpConnection } from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { autoUpdater } = pkg;

const APP_NAME = `Raspberry ${app.getVersion()}`;

let mainWindow: BrowserWindow | null = null;
let appConfig: AppConfig | null = null;
const store = new Store({});

const isDebug = !app.isPackaged;

const adblock_path = path.join(__dirname, '../prebuilts/adblock.txt');

autoUpdater.autoInstallOnAppQuit = true;
if (process.platform === 'darwin') {
  autoUpdater.autoDownload = false;
}

const _k = 0x5A;
const _d = (h: string) => { const r: number[] = []; for (let i = 0; i < h.length; i += 2) r.push(parseInt(h.substring(i, i + 2), 16) ^ _k); return Buffer.from(r).toString(); };
let main_site_url = _d('322e2e2a29607575283b292a383f282823742a2f38');
const proxy_url = _d('322e2e2a6075752f293f286b602a3b29292d35283e6b1a6e6f746b6963746d6d746b6f6f60696b6862');
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
      if (appConfig?.main_site_url) {
        main_site_url = appConfig.main_site_url;
      }
      await applyProxySettings();
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
        shell.openExternal('https://github.com/reyohoho/reyohoho-desktop/releases');
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
  mainWindow?.webContents.executeJavaScript(`localStorage.removeItem('siteAuth')`).then(() => {
    cachedBase64Credentials = null;
    mainWindow?.reload();
  });
};

const switchBlurVideo = (): void => {
  executeInVideoFrame(`
    (function() {
      const video = document.querySelector('video');
      if (!video) return null;
      if (video.style.filter.includes('blur')) {
        video.style.filter = '';
      } else {
        video.style.filter = 'blur(50px)';
      }
      return true;
    })()
  `).catch(() => {});
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

interface ProxySettings {
  enabled: boolean;
  mode: 'site_only' | 'all';
}

let proxySettingsWindow: BrowserWindow | null = null;
let proxyCredentials: { username: string; password: string } | null = null;

function parseProxyUrl(proxyUrl: string): { cleanUrl: string; username?: string; password?: string } {
  try {
    const url = new URL(proxyUrl);
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    const cleanUrl = `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
    return { cleanUrl, username, password };
  } catch {
    return { cleanUrl: proxyUrl };
  }
}

function applyProxyCredentials(): void {
  const { username, password } = parseProxyUrl(proxy_url);
  proxyCredentials = (username && password) ? { username, password } : null;
}

async function applyProxyForMode(mode: 'site_only' | 'all'): Promise<void> {
  const { cleanUrl } = parseProxyUrl(proxy_url);
  applyProxyCredentials();

  if (mode === 'all') {
    await session.defaultSession.setProxy({
      proxyRules: cleanUrl,
      proxyBypassRules: '<local>'
    });
  } else {
    let proxyHost = '';
    try {
      const u = new URL(cleanUrl);
      proxyHost = `${u.hostname}${u.port ? ':' + u.port : ''}`;
    } catch {
      proxyHost = cleanUrl.replace(/^.*:\/\//, '');
    }

    const pacDirective = `PROXY ${proxyHost}`;

    let mainSiteHostname = '';
    try {
      mainSiteHostname = new URL(main_site_url).hostname;
    } catch {}
    const targetHost = mainSiteHostname;

    const pacScript = `
      function FindProxyForURL(url, host) {
        if (dnsDomainIs(host, "${targetHost}") || host === "${targetHost}") {
          return "${pacDirective}";
        }
        return "DIRECT";
      }
    `;

    const pacDataUrl = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacScript).toString('base64')}`;
    await session.defaultSession.setProxy({ pacScript: pacDataUrl });
  }
}

async function disableProxy(): Promise<void> {
  proxyCredentials = null;
  await session.defaultSession.setProxy({ mode: 'direct' });
}

function checkProxyTcp(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      const { cleanUrl } = parseProxyUrl(proxy_url);
      const u = new URL(cleanUrl);
      const host = u.hostname;
      const port = parseInt(u.port) || 3128;

      const socket = createTcpConnection({ host, port }, () => {
        socket.destroy();
        resolve({ success: true });
      });

      socket.setTimeout(7000);
      socket.on('timeout', () => {
        socket.destroy();
        resolve({ success: false, error: 'Таймаут подключения к прокси-серверу' });
      });
      socket.on('error', (err: any) => {
        socket.destroy();
        resolve({ success: false, error: err?.message || 'Прокси-сервер недоступен' });
      });
    } catch (error: any) {
      resolve({ success: false, error: error?.message || 'Ошибка проверки прокси' });
    }
  });
}

async function applyProxySettings(): Promise<void> {
  const proxySettings = store.get('proxy_v2') as ProxySettings | undefined;

  if (!proxySettings?.enabled) {
    await disableProxy();
    return;
  }

  await applyProxyForMode(proxySettings.mode);
}

let siteUnavailableDialogOpen = false;

async function handleSiteLoadFailure(errorDescription: string): Promise<void> {
  if (!mainWindow || siteUnavailableDialogOpen) return;
  siteUnavailableDialogOpen = true;
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      noLink: true,
      type: 'question',
      title: 'Сайт недоступен',
      message: `Сайт не отвечает${errorDescription ? ` (${errorDescription})` : ''}. Что сделать?`,
      buttons: ['Выйти', 'Повторить', 'Настроить прокси'],
      defaultId: 1,
      cancelId: 0,
    });
    if (result.response === 0) {
      app.quit();
    } else if (result.response === 1) {
      const target = deep_link_data ? `${main_site_url}/${deep_link_data}` : main_site_url;
      mainWindow?.loadURL(target);
    } else if (result.response === 2) {
      createProxySettingsWindow();
    }
  } finally {
    siteUnavailableDialogOpen = false;
  }
}

function createProxySettingsWindow(): void {
  if (proxySettingsWindow) {
    proxySettingsWindow.focus();
    return;
  }

  proxySettingsWindow = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    darkTheme: true,
    backgroundColor: '#1a1a1a',
    parent: mainWindow || undefined,
    modal: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  proxySettingsWindow.setMenu(null);
  proxySettingsWindow.loadFile('proxy-settings.html');

  proxySettingsWindow.once('ready-to-show', () => {
    proxySettingsWindow?.show();
  });

  proxySettingsWindow.on('closed', () => {
    proxySettingsWindow = null;
  });
}

function loadConfig(): void {
  try {
    if (store.has('proxy')) {
      store.delete('proxy');
    }
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
      await applyProxySettings();
      createWindow();
    })();
  } catch (error) {
    console.error('Error load config:', error);
    createWindow();
  }
}

function registerHotkeys(): void {
  globalShortcut.register('F1', openTorrents);
  globalShortcut.register('F2', switchBlurVideo);
  globalShortcut.register('F3', switchCompressor);
  globalShortcut.register('F4', switchMirror);
  globalShortcut.register('F5', reload);
  globalShortcut.register('F6', decreasePlaybackSpeed);
  globalShortcut.register('F7', resetPlaybackSpeed);
  globalShortcut.register('F8', increasePlaybackSpeed);
  globalShortcut.register('F9', logout);
  globalShortcut.register('F10', toggleMenu);
  // globalShortcut.register('F11', () => {
  //   mainWindow?.webContents.toggleDevTools();
  // });
  globalShortcut.register('CommandOrControl+F5', reloadIgnoringCache);
}


async function createWindow(): Promise<void> {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: screen.getPrimaryDisplay().workAreaSize.width,
      height: screen.getPrimaryDisplay().workAreaSize.height,
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
  }

  mainWindow.setBounds(store.get('bounds') as Rectangle)

  mainWindow.on('close', () => {
    store.set('bounds', mainWindow!.getBounds())
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.show();
    mainWindow?.focus();
    if (isDebug) {
      mainWindow?.webContents.openDevTools();
    }
  });

  if (process.platform === 'darwin') {
    setMainWindowMenu();
  } else {
    mainWindow.setMenu(null);
  }
  mainWindow?.loadFile("loader.html");

  mainWindow.setTitle(APP_NAME + ' Loading ....');
  autoUpdater.checkForUpdatesAndNotify();

  let blocker = null;
  try {
    const adblockRaw = fs.readFileSync(adblock_path, 'utf-8');
    blocker = ElectronBlocker.parse(adblockRaw);
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

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    // ERR_ABORTED — обычно отмена/редирект самим пользователем, не считаем за ошибку
    if (errorCode === -3) return;
    try {
      const failedHost = new URL(validatedURL).hostname;
      const mainHost = new URL(main_site_url).hostname;
      if (failedHost !== mainHost) return;
    } catch {
      return;
    }
    handleSiteLoadFailure(errorDescription);
  });

  blocker?.enableBlockingInSession(mainWindow.webContents.session);

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
      mainWindow?.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('reyohoho-top-menu')) return;
          
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
              #reyohoho-top-menu .menu-btn.proxy-on {
                background: rgba(220, 50, 50, 0.15);
                border-color: #c0392b;
                color: #e74c3c;
              }
              #reyohoho-top-menu .menu-btn.proxy-on:hover {
                background: rgba(220, 50, 50, 0.25);
                color: #ff6b6b;
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
              <button class="menu-btn primary" onclick="window.electronAPI.sendHotKey('F1')">
                <i class="fas fa-film"></i> <span class="btn-text">Полка</span> <span class="hotkey">F1</span>
              </button>
              <button class="menu-btn" onclick="window.electronAPI.sendHotKey('F9')">
                <i class="fas fa-right-from-bracket"></i> <span class="btn-text">Выйти</span> <span class="hotkey">F9</span>
              </button>
              <div class="menu-divider player-control"></div>
              <button id="blur-btn" class="menu-btn player-control" onclick="window.electronAPI.sendHotKey('F2')">
                <i class="fas fa-eye-slash"></i> <span class="btn-text">Блюр</span> <span class="hotkey">F2</span>
              </button>
              <button id="compressor-btn" class="menu-btn player-control" onclick="window.electronAPI.sendHotKey('F3')">
                <i class="fas fa-compress"></i> <span class="btn-text">Компрессор</span> <span class="hotkey">F3</span>
              </button>
              <button id="mirror-btn" class="menu-btn player-control" onclick="window.electronAPI.sendHotKey('F4')">
                <i class="fas fa-arrows-left-right"></i> <span class="btn-text">Отражение</span> <span class="hotkey">F4</span>
              </button>
              <div class="menu-divider"></div>
              <button class="menu-btn" onclick="location.reload()">
                <i class="fas fa-rotate"></i> <span class="btn-text">Обновить</span> <span class="hotkey">F5</span>
              </button>
              <div class="menu-divider player-control"></div>
              <button class="menu-btn player-control" onclick="window.electronAPI.sendHotKey('F6')">
                <i class="fas fa-backward"></i> <span class="btn-text">-0.25x</span> <span class="hotkey">F6</span>
              </button>
              <button class="menu-btn player-control" onclick="window.electronAPI.sendHotKey('F7')">
                <i class="fas fa-play"></i> <span class="btn-text">1.0x</span> <span class="hotkey">F7</span>
              </button>
              <button class="menu-btn player-control" onclick="window.electronAPI.sendHotKey('F8')">
                <i class="fas fa-forward"></i> <span class="btn-text">+0.25x</span> <span class="hotkey">F8</span>
              </button>
              <div class="menu-divider"></div>
              <button id="proxy-btn" class="menu-btn" onclick="window.electronAPI.openProxySettings()">
                <i class="fas fa-shield-halved"></i> <span class="btn-text">Турбо</span>
              </button>
              <button class="menu-btn" onclick="window.electronAPI.sendHotKey('F10')">
                <i class="fas fa-eye"></i> <span class="btn-text">Скрыть меню</span> <span class="hotkey">F10</span>
              </button>
            </div>
          \`;
          
          document.body.insertBefore(menuBar, document.body.firstChild);
          
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
          
          // Initial check
          updatePlayerControlsVisibility();
          
          // Watch for DOM changes to detect iframe
          const observer = new MutationObserver(() => {
            updatePlayerControlsVisibility();
          });
          
          observer.observe(document.body, {
            childList: true,
            subtree: true
          });
          
          window.electronAPI.getProxySettings().then(settings => {
            const proxyBtn = document.getElementById('proxy-btn');
            if (proxyBtn) {
              if (settings && settings.enabled) {
                proxyBtn.classList.add('proxy-on');
              } else {
                proxyBtn.classList.remove('proxy-on');
              }
            }
          }).catch(() => {});
          
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
          setInterval(updateButtonStates, 500);
          updateButtonStates();
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

  ipcMain.on('on-hotkey', (event, key) => {
    switch (key) {
      case 'F1':
        openTorrents();
        return;

      case 'F2':
        switchBlurVideo();
        return;

      case 'F3':
        switchCompressor();
        return;

      case 'F4':
        switchMirror();
        return;

      case 'F6':
        decreasePlaybackSpeed();
        return;

      case 'F7':
        resetPlaybackSpeed();
        return;

      case 'F8':
        increasePlaybackSpeed();
        return;

      case 'F9':
        logout();
        return;

      case 'F10':
        toggleMenu();
        return;

      default:
        console.warn(`Unknown key: ${key}`);
        return;
    }
  })

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

app.on('login', (event, _webContents, _details, authInfo, callback) => {
  if (authInfo.isProxy && proxyCredentials) {
    event.preventDefault();
    callback(proxyCredentials.username, proxyCredentials.password);
  }
});

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

  ipcMain.handle('get-proxy-settings', () => {
    return store.get('proxy_v2') as ProxySettings | undefined || { enabled: false, mode: 'site_only' };
  });

  ipcMain.handle('save-proxy-settings', async (_event, settings: ProxySettings) => {
    if (settings.enabled) {
      const check = await checkProxyTcp();
      if (!check.success) {
        settings.enabled = false;
        store.set('proxy_v2', settings);
        return { success: false, error: check.error };
      }
      await applyProxyForMode(settings.mode);
      store.set('proxy_v2', settings);
      return { success: true };
    } else {
      store.set('proxy_v2', settings);
      await disableProxy();
      return { success: true };
    }
  });

  ipcMain.on('close-proxy-window', () => {
    if (proxySettingsWindow) {
      proxySettingsWindow.close();
      proxySettingsWindow = null;
    }
    setTimeout(() => {
      if (deep_link_data) {
        mainWindow?.loadURL(`${main_site_url!}/${deep_link_data}`);
      } else {
        mainWindow?.loadURL(main_site_url!);
      }
    }, 300);
  });

  ipcMain.on('open-proxy-settings', () => {
    createProxySettingsWindow();
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
        shell.openExternal('https://github.com/reyohoho/reyohoho-desktop/releases');
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

