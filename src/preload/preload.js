'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) {
    const e = new Error(r.error);
    e.code = r.code;
    throw e;
  }
  return r.data;
}

function on(channel, cb) {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('api', {
  auth: {
    status: () => call('auth:status'),
    login: () => call('auth:login'),
    logout: () => call('auth:logout'),
    importCookies: (str) => call('auth:importCookies', str),
  },
  patreon: {
    posts: (campaignId, nextUrl) => call('patreon:posts', campaignId, nextUrl),
  },
  settings: {
    get: () => call('settings:get'),
    set: (partial) => call('settings:set', partial),
    campaignDir: (campaign) => call('settings:campaignDir', campaign),
    chooseDir: (defaultPath) => call('dialog:chooseDir', defaultPath),
  },
  downloads: {
    enqueue: (reqs) => call('downloads:enqueue', reqs),
    cancel: (id) => call('downloads:cancel', id),
    retry: (id) => call('downloads:retry', id),
    clear: () => call('downloads:clear'),
    list: () => call('downloads:list'),
    existing: (campaign, posts) => call('downloads:existing', campaign, posts),
    onUpdate: (cb) => on('downloads:update', cb),
    onCleared: (cb) => on('downloads:cleared', cb),
  },
  tools: {
    status: () => call('tools:status'),
    install: (opts) => call('tools:install', opts),
    updateYtDlp: () => call('tools:updateYtDlp'),
    onProgress: (cb) => on('tools:progress', cb),
    onStatus: (cb) => on('tools:status', cb),
  },
  shell: {
    openPath: (p) => call('shell:openPath', p),
    showItem: (p) => call('shell:showItem', p),
    openExternal: (url) => call('shell:openExternal', url),
  },
});
