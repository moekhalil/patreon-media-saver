'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // Global root folder. Each creator gets a subfolder unless overridden / disabled.
  downloadDir: '',
  perCreatorSubfolder: true,
  // { [campaignId]: "F:/PODCASTS/chapotraphouse" } – absolute per-creator overrides.
  campaignDirs: {},
  // Tokens: {title} {date} {campaign} {id} {type}
  filenameTemplate: '{title}',
  // best | 1080 | 720 | 480 | 360
  videoQuality: 'best',
  // When only a video post exists, allow extracting audio (mp3) from it.
  audioFromVideoFallback: true,
  saveSubtitles: false,
  embedSubtitles: true, // mux post_file.transcript_url into the video as a soft subtitle track
  saveThumbnail: false,
  concurrency: 2,
  groupEpisodes: true,
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    /* first run */
  }
  cache = { ...DEFAULTS, ...data };
  if (!cache.downloadDir) cache.downloadDir = path.join(app.getPath('downloads'), 'Patreon');
  if (!cache.campaignDirs || typeof cache.campaignDirs !== 'object') cache.campaignDirs = {};
  return cache;
}

function save(partial) {
  const cur = load();
  cache = { ...cur, ...partial };
  if (partial.campaignDirs) cache.campaignDirs = { ...partial.campaignDirs };
  cache.concurrency = Math.max(1, Math.min(8, parseInt(cache.concurrency, 10) || 2));
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}

module.exports = { load, save, DEFAULTS };
