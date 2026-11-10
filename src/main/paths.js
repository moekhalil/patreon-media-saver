'use strict';
const path = require('path');
const settings = require('./settings');

/** Make a string safe as a Windows/macOS/Linux file name. */
function sanitizeFileName(name) {
  let s = String(name ?? '').normalize('NFC');
  s = s.replace(/\s*:\s*/g, ' - '); // "P214: Title" -> "P214 - Title"
  s = s.replace(/[<>"/\\|?*\u0000-\u001f]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  if (s.length > 180) s = s.slice(0, 180).trim();
  return s || 'untitled';
}

function campaignFolderName(campaign) {
  return sanitizeFileName(campaign?.vanity || campaign?.name || String(campaign?.id || 'creator'));
}

/** Resolve the directory that downloads for a campaign go into. */
function resolveCampaignDir(campaign) {
  const s = settings.load();
  const override = campaign && s.campaignDirs[campaign.id];
  if (override) return override;
  return s.perCreatorSubfolder ? path.join(s.downloadDir, campaignFolderName(campaign)) : s.downloadDir;
}

/** Build the file base name (no extension) from the template. */
function buildBaseName(post, campaign) {
  const s = settings.load();
  const tpl = s.filenameTemplate || '{title}';
  const date = (post.publishedAt || '').slice(0, 10);
  const out = tpl
    .replace(/\{title\}/g, post.title || `post-${post.id}`)
    .replace(/\{date\}/g, date)
    .replace(/\{campaign\}/g, campaign?.name || '')
    .replace(/\{id\}/g, post.id || '')
    .replace(/\{type\}/g, post.postType || '');
  return sanitizeFileName(out);
}

module.exports = { sanitizeFileName, resolveCampaignDir, buildBaseName, campaignFolderName };
