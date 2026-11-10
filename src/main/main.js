'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const patreon = require('./patreon');
const settings = require('./settings');
const tools = require('./tools');
const downloads = require('./downloads');
const { resolveCampaignDir } = require('./paths');

let mainWindow = null;
let loginWindow = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// --------------------------------------------------------------- session/network hooks

/**
 * Mux (Patreon's video CDN) signed playback URLs are restricted to the Patreon origin.
 * For requests coming from our own UI we present Patreon's Origin/Referer, and loosen CORS
 * on the response so hls.js (running from file://) may read the playlists/segments.
 */
function installNetworkHooks() {
  const ses = patreon.ses();
  const isOurUi = (d) => mainWindow && !mainWindow.isDestroyed() && d.webContentsId === mainWindow.webContents.id;

  ses.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.mux.com/*', '*://*.patreonusercontent.com/*'] },
    (details, cb) => {
      if (!isOurUi(details)) return cb({});
      const h = { ...details.requestHeaders };
      for (const k of Object.keys(h)) if (/^(origin|referer)$/i.test(k)) delete h[k];
      if (/mux\.com/.test(details.url)) h.Origin = 'https://www.patreon.com';
      h.Referer = 'https://www.patreon.com/';
      cb({ requestHeaders: h });
    },
  );

  ses.webRequest.onHeadersReceived({ urls: ['*://*.mux.com/*'] }, (details, cb) => {
    if (!isOurUi(details)) return cb({});
    const h = { ...details.responseHeaders };
    for (const k of Object.keys(h)) if (/^access-control-allow-(origin|credentials)$/i.test(k)) delete h[k];
    h['Access-Control-Allow-Origin'] = ['*'];
    cb({ responseHeaders: h });
  });
}

// --------------------------------------------------------------- windows

// Window/taskbar icon (the packaged exe icon comes from build/icon.ico via electron-builder).
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png');

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'Patreon Media Saver',
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      partition: patreon.PARTITION,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Links inside post content open in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('close', (e) => {
    const active = downloads.list().filter((j) => j.status === 'running' || j.status === 'queued');
    if (!active.length) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Quit and cancel downloads', 'Keep running'],
      defaultId: 1,
      cancelId: 1,
      message: `${active.length} download(s) still in progress.`,
      detail: 'Partial files are kept and will resume next time you download the same item.',
    });
    if (choice === 1) e.preventDefault();
    else downloads.cancelAll();
  });
}

function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return loginWindow.__promise;
  }
  loginWindow = new BrowserWindow({
    width: 520,
    height: 780,
    parent: mainWindow,
    modal: false,
    title: 'Log in to Patreon',
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: { partition: patreon.PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const win = loginWindow;
  win.__promise = new Promise((resolve) => {
    let done = false;
    let checking = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      patreon.ses().cookies.removeListener('changed', onCookie);
      if (!win.isDestroyed()) win.close();
      resolve(val);
    };
    const check = async () => {
      if (done || checking || win.isDestroyed()) return;
      const url = win.webContents.getURL();
      if (/\/(login|signup|auth)/i.test(url)) return; // still on the login/2FA flow
      checking = true;
      try {
        if (await patreon.hasSessionCookie()) {
          const data = await patreon.getCurrentUser();
          finish({ loggedIn: true, ...data });
        }
      } catch {
        /* not yet */
      } finally {
        checking = false;
      }
    };
    const onCookie = (_e, cookie) => {
      if (cookie.name === 'session_id') setTimeout(check, 800);
    };
    patreon.ses().cookies.on('changed', onCookie);
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-navigate-in-page', check);
    win.webContents.on('did-finish-load', check);
    win.on('closed', async () => {
      loginWindow = null;
      if (done) return;
      try {
        const data = await patreon.getCurrentUser();
        finish({ loggedIn: true, ...data });
      } catch (e) {
        finish({ loggedIn: false, error: 'Login window closed before login completed.' });
      }
    });
  });
  win.loadURL(`${patreon.BASE}/login?ru=%2Fhome`);
  return win.__promise;
}

// --------------------------------------------------------------- IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc ${channel}]`, err);
      return { ok: false, error: err.message || String(err), code: err.code };
    }
  });
}

function registerIpc() {
  handle('auth:status', async () => {
    if (!(await patreon.hasSessionCookie())) return { loggedIn: false };
    try {
      return { loggedIn: true, ...(await patreon.getCurrentUser()) };
    } catch (e) {
      return { loggedIn: false, error: e.message };
    }
  });
  handle('auth:login', () => openLoginWindow());
  handle('auth:logout', () => patreon.logout());
  handle('auth:importCookies', async (str) => {
    const n = await patreon.importCookieString(str);
    if (!n) throw new Error('No cookies found in the pasted text.');
    return { loggedIn: true, imported: n, ...(await patreon.getCurrentUser()) };
  });

  handle('patreon:posts', (campaignId, nextUrl) => patreon.getPosts(campaignId, nextUrl));

  handle('settings:get', () => settings.load());
  handle('settings:set', (partial) => settings.save(partial || {}));
  handle('settings:campaignDir', (campaign) => resolveCampaignDir(campaign));
  handle('dialog:chooseDir', async (defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || settings.load().downloadDir,
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('downloads:enqueue', (reqs) => downloads.enqueue(reqs));
  handle('downloads:cancel', (id) => downloads.cancel(id));
  handle('downloads:retry', (id) => downloads.retry(id));
  handle('downloads:clear', () => downloads.clearFinished());
  handle('downloads:list', () => downloads.list());
  handle('downloads:existing', (campaign, posts) => downloads.existing(campaign, posts));

  const toolProgress = (p) => send('tools:progress', p);
  handle('tools:status', () => tools.status());
  handle('tools:install', (opts) => tools.ensure(opts || {}, toolProgress));
  handle('tools:updateYtDlp', () => tools.updateYtDlp(toolProgress));

  handle('shell:openPath', async (p) => {
    if (p && !fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  handle('shell:showItem', (p) => shell.showItemInFolder(p));
  handle('shell:openExternal', (url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs allowed');
    return shell.openExternal(url);
  });
}

// --------------------------------------------------------------- app lifecycle

app.whenReady().then(async () => {
  // Matches build.appId so Windows groups the taskbar entry and uses our icon.
  if (process.platform === 'win32') app.setAppUserModelId('local.patreon-media-saver');
  patreon.setupSessionUserAgent();
  installNetworkHooks();
  registerIpc();
  downloads.setEmitter(send);
  createMainWindow();

  // Make sure yt-dlp + ffmpeg are present in ./third-party (non-blocking).
  mainWindow.webContents.once('did-finish-load', () => {
    tools
      .ensure({}, (p) => send('tools:progress', p))
      .then((st) => send('tools:status', st))
      .catch((e) => send('tools:status', { error: e.message }));
  });
});

app.on('window-all-closed', () => app.quit());
