'use strict';
const { session } = require('electron');

const PARTITION = 'persist:patreon';
const BASE = 'https://www.patreon.com';

function ses() {
  return session.fromPartition(PARTITION);
}

/** Strip Electron/app tokens so Patreon/Cloudflare see a regular Chrome UA. */
function setupSessionUserAgent() {
  const s = ses();
  const ua = s
    .getUserAgent()
    .replace(/\s?Electron\/\S+/i, '')
    .replace(/\s?patreon-media-saver\/\S+/i, '')
    .replace(/\s?Patreon Media Saver\/\S+/i, '');
  s.setUserAgent(ua);
  return ua;
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function apiGet(url, referer = `${BASE}/home`) {
  const res = await ses().fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      accept: 'application/vnd.api+json',
      'content-type': 'application/vnd.api+json',
      'accept-language': 'en-US,en;q=0.9',
      referer,
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(`Patreon returned ${res.status}. You may need to log in again.`, res.status, 'AUTH');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`Patreon API error ${res.status}: ${text.slice(0, 300)}`, res.status, 'HTTP');
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    throw new ApiError('Patreon returned a non-JSON response (possibly a Cloudflare challenge). Try logging in again.', res.status, 'CHALLENGE');
  }
  return res.json();
}

// ---------------------------------------------------------------- auth

async function getCookies() {
  return ses().cookies.get({ url: BASE });
}

async function hasSessionCookie() {
  const cookies = await getCookies();
  return cookies.some((c) => c.name === 'session_id' && c.value);
}

/** Import a raw "Cookie:" header string (e.g. copied from DevTools). */
async function importCookieString(str) {
  let raw = String(str || '').trim();
  raw = raw.replace(/^cookie:\s*/i, '').replace(/^"|"$/g, '');
  const parts = raw.split(/;\s*/).filter(Boolean);
  let count = 0;
  const expirationDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      await ses().cookies.set({
        url: BASE,
        domain: '.patreon.com',
        path: '/',
        name,
        value,
        secure: true,
        expirationDate,
      });
      count++;
    } catch (e) {
      console.warn('cookie set failed', name, e.message);
    }
  }
  await ses().cookies.flushStore();
  return count;
}

async function logout() {
  await ses().clearStorageData();
  await ses().clearCache();
}

// ---------------------------------------------------------------- current user + memberships

const CURRENT_USER_URL =
  `${BASE}/api/current_user?` +
  new URLSearchParams({
    'fields[user]': 'full_name,image_url,vanity',
    'fields[member]': 'is_free_member,is_free_trial',
    'fields[campaign]':
      'avatar_photo_image_urls,creation_name,is_nsfw,name,published_at,url,url_for_current_user,vanity',
    'fields[reward]': '',
    include: 'active_memberships,active_memberships.campaign,active_memberships.reward',
    'json-api-version': '1.0',
    'json-api-use-default-includes': 'false',
    'json-api-use-default-fields': 'false',
  }).toString();

async function getCurrentUser() {
  const j = await apiGet(CURRENT_USER_URL, `${BASE}/feed/membership`);
  const included = j.included || [];
  const byKey = new Map(included.map((i) => [`${i.type}:${i.id}`, i]));
  const user = {
    id: j.data?.id,
    name: j.data?.attributes?.full_name || '',
    image: j.data?.attributes?.image_url || '',
  };
  const memberships = j.data?.relationships?.active_memberships?.data || [];
  const campaigns = [];
  for (const m of memberships) {
    const member = byKey.get(`member:${m.id}`);
    const cRef = member?.relationships?.campaign?.data;
    if (!cRef) continue;
    const c = byKey.get(`campaign:${cRef.id}`);
    const a = c?.attributes || {};
    const avatars = a.avatar_photo_image_urls || {};
    campaigns.push({
      id: cRef.id,
      name: a.name || `Campaign ${cRef.id}`,
      vanity: a.vanity || '',
      creationName: a.creation_name || '',
      url: a.url_for_current_user || a.url || '',
      avatar: avatars.thumbnail_small || avatars.default_small || avatars.thumbnail || '',
      avatarLarge: avatars.thumbnail || avatars.default || '',
      isNsfw: !!a.is_nsfw,
      isFreeMember: !!member.attributes?.is_free_member,
      isFreeTrial: !!member.attributes?.is_free_trial,
    });
  }
  campaigns.sort((x, y) => x.name.localeCompare(y.name));
  return { user, campaigns };
}

// ---------------------------------------------------------------- posts

// Mirrors the request the Patreon web app makes for /c/<creator>/posts.
const POST_INCLUDE = [
  'campaign', 'access_rules', 'attachments_media', 'audio', 'images', 'media',
  'native_video_insights', 'user', 'user_defined_tags', 'video.null',
].join(',');
const POST_FIELDS = [
  'attachments_preview_metadata', 'comment_count', 'content_json_string', 'created_at', 'edited_at',
  'current_user_can_view', 'embed', 'image', 'is_paid', 'like_count', 'meta_image_url',
  'min_cents_pledged_to_view', 'post_file', 'post_metadata', 'published_at', 'patreon_url', 'post_type',
  'thumbnail', 'thumbnail_url', 'teaser_text_json_string', 'content_teaser_text', 'title', 'url',
  'video', 'video_preview', 'view_count', 'watch_state',
].join(',');

function postsUrl(campaignId) {
  return (
    `${BASE}/api/posts?` +
    new URLSearchParams({
      include: POST_INCLUDE,
      'fields[campaign]': 'avatar_photo_image_urls,name,url,vanity',
      'fields[post]': POST_FIELDS,
      'fields[post_tag]': 'tag_type,value',
      'fields[user]': 'image_url,full_name,url',
      'fields[access_rule]': 'access_rule_type,amount_cents',
      'fields[media]': 'id,image_urls,display,download_url,metadata,file_name,state',
      'fields[native_video_insights]': 'video_duration',
      'filter[campaign_id]': String(campaignId),
      'filter[contains_exclusive_posts]': 'true',
      'filter[is_draft]': 'false',
      sort: '-published_at',
      'json-api-use-default-includes': 'false',
      'json-api-version': '1.0',
    }).toString()
  );
}

function isAudioUrl(u) {
  return /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|$)/i.test(u || '');
}

function normalizePost(p, byKey) {
  const a = p.attributes || {};
  const rel = p.relationships || {};
  const media = (ref) => (ref ? byKey.get(`media:${ref.id}`) : null);
  const pf = a.post_file || null;
  const type = a.post_type || '';

  let video = null;
  let audio = null;

  if (pf && pf.url) {
    const isHls = /\.m3u8(\?|$)/i.test(pf.url);
    const audioish = isAudioUrl(pf.url) || type === 'podcast' || type === 'audio_file';
    if (isHls || (!audioish && (type.includes('video') || pf.width || pf.height))) {
      video = {
        kind: isHls ? 'hls' : 'file',
        url: pf.url,
        duration: pf.duration || pf.full_content_duration || null,
        width: pf.width || null,
        height: pf.height || null,
        transcriptUrl: pf.transcript_url || null,
        thumbnailUrl: pf.default_thumbnail?.url || null,
        storyboard: pf.storyboard || null,
        expiresAt: pf.expires_at || pf.viewer_playback_data?.playback_token_expiry || null,
      };
    } else if (audioish) {
      const am = media(rel.audio?.data);
      audio = {
        url: pf.url,
        downloadUrl: am?.attributes?.download_url || pf.url,
        duration: pf.duration || pf.full_content_duration || null,
        fileName: am?.attributes?.file_name || null,
      };
    }
  }
  if (!audio && rel.audio?.data) {
    const am = media(rel.audio.data);
    const u = am?.attributes?.download_url || am?.attributes?.display?.url;
    if (u) audio = { url: u, downloadUrl: u, duration: am.attributes.display?.duration || null, fileName: am.attributes.file_name || null };
  }
  if (!video && type === 'video_embed' && a.embed?.url) {
    video = { kind: 'embed', url: a.embed.url, provider: a.embed.provider || '', duration: null };
  }

  const attachments = (rel.attachments_media?.data || [])
    .map((r) => media(r))
    .filter(Boolean)
    .map((m) => ({ id: m.id, name: m.attributes.file_name || `attachment-${m.id}`, url: m.attributes.download_url }))
    .filter((x) => x.url);

  const images = (rel.images?.data || [])
    .map((r) => media(r))
    .filter(Boolean)
    .map((m) => ({
      id: m.id,
      name: m.attributes.file_name || `image-${m.id}`,
      url: m.attributes.image_urls?.original || m.attributes.download_url,
      thumb: m.attributes.image_urls?.default_small || m.attributes.image_urls?.default || m.attributes.download_url,
    }))
    .filter((x) => x.url);

  const thumb =
    a.thumbnail?.default_small || a.thumbnail?.default || a.image?.thumb_url || a.image?.url ||
    video?.thumbnailUrl || pf?.default_thumbnail?.url || '';

  return {
    id: p.id,
    title: a.title || '(untitled)',
    postType: type,
    publishedAt: a.published_at || a.created_at || '',
    url: a.url || (a.patreon_url ? BASE + a.patreon_url : ''),
    campaignId: rel.campaign?.data?.id || null,
    canView: a.current_user_can_view !== false,
    thumb,
    teaser: a.content_teaser_text || '',
    contentJson: a.content_json_string || '',
    likeCount: a.like_count || 0,
    commentCount: a.comment_count || 0,
    video,
    audio,
    attachments,
    images,
  };
}

function indexIncluded(j) {
  return new Map((j.included || []).map((i) => [`${i.type}:${i.id}`, i]));
}

/** Fetch one page of posts. Pass `nextUrl` (from previous result) to continue. */
async function getPosts(campaignId, nextUrl) {
  const url = nextUrl || postsUrl(campaignId);
  if (!url.startsWith(`${BASE}/api/`)) throw new Error('Refusing to fetch non-Patreon URL');
  const j = await apiGet(url, `${BASE}/home`);
  const byKey = indexIncluded(j);
  const posts = (j.data || []).map((p) => normalizePost(p, byKey));
  return {
    posts,
    next: j.links?.next || null,
    total: j.meta?.pagination?.total ?? null,
  };
}

/** Re-fetch a single post so we get freshly-signed media URLs right before downloading. */
async function getPost(postId) {
  const url =
    `${BASE}/api/posts/${encodeURIComponent(postId)}?` +
    new URLSearchParams({
      include: 'audio,attachments_media,images,media,campaign',
      'fields[post]': POST_FIELDS,
      'fields[media]': 'id,image_urls,display,download_url,metadata,file_name,state',
      'fields[campaign]': 'name,vanity',
      'json-api-use-default-includes': 'false',
      'json-api-version': '1.0',
    }).toString();
  const j = await apiGet(url);
  return normalizePost(j.data, indexIncluded(j));
}

module.exports = {
  PARTITION,
  BASE,
  ses,
  setupSessionUserAgent,
  hasSessionCookie,
  importCookieString,
  logout,
  getCurrentUser,
  getPosts,
  getPost,
  normalizePost,
  indexIncluded,
  ApiError,
};
