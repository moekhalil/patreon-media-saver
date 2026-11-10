'use strict';
/* global Hls */
/* global api */ // exposed by preload via contextBridge
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ===================================================================== state
const state = {
  user: null,
  campaigns: [],
  settings: null,
  currentId: null,
  data: {}, // campaignId -> { posts: [], next, total, loading, loaded }
  existing: {}, // postId -> { video, audio, dir, base }
  selected: new Set(), // item keys
  filter: 'all',
  search: '',
  hideDownloaded: false,
  jobs: new Map(),
  campaignDir: '',
};

// ===================================================================== helpers
// Hide broken/missing images (avatars, thumbs) instead of showing the broken-image icon.
document.addEventListener('error', (e) => {
  if (e.target instanceof HTMLImageElement) e.target.classList.add('img-broken');
}, true);
document.addEventListener('load', (e) => {
  if (e.target instanceof HTMLImageElement) e.target.classList.remove('img-broken');
}, true);

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtBytes(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) (b /= 1024), i++;
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function toast(msg, kind = '') {
  const t = el('div', { class: `toast ${kind}`, text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4000);
}
async function guard(fn, errPrefix = '') {
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(`${errPrefix}${e.message}`, 'err');
    if (e.code === 'AUTH') showLogin('Your Patreon session expired. Please log in again.');
    return undefined;
  }
}
function currentCampaign() {
  return state.campaigns.find((c) => c.id === state.currentId) || null;
}

// Light-dismiss fallback for runtimes without <dialog closedby>.
function enableLightDismiss(dialog) {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right;
    if (!inside) dialog.close();
  });
}

// ===================================================================== auth
function showLogin(error) {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  const err = $('#login-error');
  err.hidden = !error;
  err.textContent = error || '';
}

async function onLoggedIn(data) {
  state.user = data.user;
  state.campaigns = data.campaigns || [];
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#me-avatar').src = state.user?.image || '';
  $('#me-name').textContent = state.user?.name || 'Patreon user';
  renderCampaignList();
  const last = localStorage.getItem('lastCampaign');
  const pick = state.campaigns.find((c) => c.id === last) || null;
  if (pick) selectCampaign(pick.id);
}

$('#btn-login').addEventListener('click', async () => {
  const btn = $('#btn-login');
  btn.disabled = true;
  btn.textContent = 'Waiting for login window…';
  try {
    const r = await api.auth.login();
    if (r.loggedIn) onLoggedIn(r);
    else showLogin(r.error || 'Login was not completed.');
  } catch (e) {
    showLogin(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log in with Patreon';
  }
});

$('#btn-import-cookies').addEventListener('click', async () => {
  try {
    const r = await api.auth.importCookies($('#cookie-input').value);
    $('#cookie-input').value = '';
    toast(`Imported ${r.imported} cookies.`, 'ok');
    onLoggedIn(r);
  } catch (e) {
    showLogin(`Cookie import failed: ${e.message}`);
  }
});

// ===================================================================== sidebar
function renderCampaignList() {
  const nav = $('#campaign-list');
  nav.replaceChildren(
    ...state.campaigns.map((c) =>
      el(
        'button',
        {
          class: `campaign-item${c.id === state.currentId ? ' active' : ''}`,
          dataset: { id: c.id },
          onclick: () => selectCampaign(c.id),
          title: c.name,
        },
        el('img', { src: c.avatar, alt: '', loading: 'lazy' }),
        el(
          'div',
          { style: 'min-width:0;flex:1' },
          el('div', { class: 'ci-name', text: c.name }),
          el('div', { class: 'ci-sub' }, el('span', { class: `tier${c.isFreeMember ? '' : ' paid'}`, text: c.isFreeMember ? 'Free' : c.isFreeTrial ? 'Trial' : 'Paid' })),
        ),
      ),
    ),
  );
  if (!state.campaigns.length) nav.append(el('p', { class: 'muted small', style: 'padding:10px', text: 'No active memberships found.' }));
}

// ===================================================================== campaign view
async function selectCampaign(id) {
  state.currentId = id;
  state.selected.clear();
  localStorage.setItem('lastCampaign', id);
  $$('.campaign-item').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  const c = currentCampaign();
  $('#empty-state').hidden = true;
  $('#campaign-view').hidden = false;
  $('#c-avatar').src = c.avatarLarge || c.avatar;
  $('#c-name').textContent = c.name;
  $('#c-sub').textContent = c.creationName || '';
  await refreshFolder();
  if (!state.data[id]) state.data[id] = { posts: [], next: null, total: null, loading: false, loaded: false };
  renderPosts();
  if (!state.data[id].loaded) await loadMore();
}

async function refreshFolder() {
  const c = currentCampaign();
  if (!c) return;
  state.campaignDir = await api.settings.campaignDir(c);
  $('#c-folder').textContent = state.campaignDir;
  $('#c-folder').title = state.campaignDir;
  $('#btn-folder-reset').hidden = !state.settings.campaignDirs[c.id];
}

async function loadMore() {
  const id = state.currentId;
  const d = state.data[id];
  if (!d || d.loading || (d.loaded && !d.next)) return false;
  d.loading = true;
  renderLoadStatus();
  try {
    const r = await api.patreon.posts(id, d.next || undefined);
    const seen = new Set(d.posts.map((p) => p.id));
    d.posts.push(...r.posts.filter((p) => !seen.has(p.id)));
    d.next = r.next;
    d.total = r.total ?? d.total;
    d.loaded = true;
    await refreshExisting(r.posts);
    return !!r.next;
  } catch (e) {
    toast(`Failed to load posts: ${e.message}`, 'err');
    if (e.code === 'AUTH') showLogin('Your Patreon session expired. Please log in again.');
    return false;
  } finally {
    d.loading = false;
    if (state.currentId === id) renderPosts();
  }
}

async function loadAll() {
  const id = state.currentId;
  $('#btn-load-all').disabled = true;
  try {
    while (state.currentId === id && (await loadMore())) {
      /* keep paging */
    }
  } finally {
    $('#btn-load-all').disabled = false;
  }
}

async function refreshExisting(posts) {
  const c = currentCampaign();
  if (!c || !posts?.length) return;
  const slim = posts.map((p) => ({ id: p.id, title: p.title, publishedAt: p.publishedAt, postType: p.postType, video: !!p.video }));
  const r = await api.downloads.existing(c, slim).catch(() => ({}));
  Object.assign(state.existing, r);
}

function renderLoadStatus() {
  const d = state.data[state.currentId];
  if (!d) return;
  const total = d.total != null ? ` of ${d.total}` : '';
  $('#load-status').textContent = d.loading ? `Loading… (${d.posts.length}${total})` : `${d.posts.length}${total} posts loaded`;
  $('#btn-load-more').disabled = d.loading || (d.loaded && !d.next);
  $('#btn-load-all').disabled = d.loading || (d.loaded && !d.next);
}

// ---------------------------------------------------------------- grouping into "episodes"
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildItems(posts) {
  const items = [];
  if (!state.settings.groupEpisodes) {
    for (const p of posts) items.push(makeItem(`p${p.id}`, [p]));
    return items;
  }
  const byKey = new Map();
  for (const p of posts) {
    const k = normTitle(p.title);
    let g = byKey.get(k);
    // Only merge posts that have complementary media (one video, one audio) and are close in time.
    const close = g && Math.abs(new Date(g.posts[0].publishedAt) - new Date(p.publishedAt)) < 1000 * 60 * 60 * 24 * 4;
    const compatible = g && close && ((p.video && !g.posts.some((x) => x.video)) || (p.audio && !g.posts.some((x) => x.audio)));
    if (g && compatible && (p.video || p.audio)) {
      g.posts.push(p);
    } else {
      g = { key: `p${p.id}`, posts: [p] };
      if (!byKey.has(k) || !(p.video || p.audio)) byKey.set(k, g);
      else byKey.set(k + '#' + p.id, g);
      items.push(g);
    }
  }
  return items.map((g) => makeItem(g.key, g.posts));
}

function makeItem(key, posts) {
  const videoPost = posts.find((p) => p.video) || null;
  const audioPost = posts.find((p) => p.audio) || null;
  const main = videoPost || audioPost || posts[0];
  return {
    key,
    posts,
    main,
    title: main.title,
    publishedAt: posts.map((p) => p.publishedAt).sort().pop(),
    videoPost,
    audioPost,
    canView: posts.some((p) => p.canView),
    thumb: (videoPost || main).thumb || posts.find((p) => p.thumb)?.thumb || '',
    duration: videoPost?.video?.duration || audioPost?.audio?.duration || null,
  };
}

function itemState(item) {
  const vid = item.videoPost ? state.existing[item.videoPost.id]?.video : null;
  const audSrc = item.audioPost || item.videoPost;
  const aud = audSrc ? state.existing[audSrc.id]?.audio : null;
  return { video: vid, audio: aud };
}

function canAudio(item) {
  return !!(item.audioPost || (item.videoPost && state.settings.audioFromVideoFallback && item.videoPost.video.kind !== 'embed') || item.videoPost);
}

function visibleItems() {
  const d = state.data[state.currentId];
  if (!d) return [];
  let items = buildItems(d.posts);
  const q = state.search.trim().toLowerCase();
  if (q) items = items.filter((i) => i.title.toLowerCase().includes(q));
  if (state.filter === 'video') items = items.filter((i) => i.videoPost);
  else if (state.filter === 'audio') items = items.filter((i) => i.audioPost);
  else if (state.filter === 'other') items = items.filter((i) => !i.videoPost && !i.audioPost);
  if (state.hideDownloaded) {
    items = items.filter((i) => {
      const s = itemState(i);
      if (i.videoPost && !s.video) return true;
      if (i.audioPost && !s.audio) return true;
      return !i.videoPost && !i.audioPost;
    });
  }
  return items;
}

let lastItems = [];
function renderPosts() {
  const list = $('#post-list');
  const d = state.data[state.currentId];
  renderLoadStatus();
  const items = visibleItems();
  lastItems = items;
  // drop selections that are no longer visible
  const visibleKeys = new Set(items.map((i) => i.key));
  for (const k of [...state.selected]) if (!visibleKeys.has(k)) state.selected.delete(k);

  list.replaceChildren(...items.map(renderItem));
  if (d?.loading && !items.length) list.append(el('div', { class: 'loading-row', text: 'Loading posts…' }));
  else if (!items.length && d?.loaded) list.append(el('div', { class: 'loading-row', text: 'No posts match.' }));

  const footer = $('#list-footer');
  footer.textContent = '';
  if (d?.next && !d.loading) footer.append('More posts available — ', el('a', { href: '#', onclick: (e) => (e.preventDefault(), loadMore()), text: 'load more' }));
  else if (d?.loaded && !d.next) footer.textContent = 'All posts loaded.';
  updateSelection();
}

function renderItem(item) {
  const st = itemState(item);
  const selected = state.selected.has(item.key);
  const hasMedia = item.videoPost || item.audioPost;
  const textPost = item.posts.find((p) => !p.video && !p.audio);

  const tags = [];
  if (item.videoPost) {
    const v = item.videoPost.video;
    tags.push(el('span', { class: 'tag video', text: `🎬 Video${v.height ? ` ${v.height}p` : ''}${v.kind === 'embed' ? ` (${v.provider || 'embed'})` : ''}` }));
  }
  if (item.audioPost) tags.push(el('span', { class: 'tag audio', text: '🎧 Audio' }));
  if (!hasMedia) tags.push(el('span', { class: 'tag', text: item.main.postType.replace(/_/g, ' ') || 'post' }));
  if (st.video) tags.push(el('span', { class: 'tag ok', text: '✓ video saved' }));
  if (st.audio) tags.push(el('span', { class: 'tag ok', text: '✓ audio saved' }));
  if (!item.canView) tags.push(el('span', { class: 'tag lock', text: '🔒 Locked' }));
  const attachCount = item.posts.reduce((n, p) => n + p.attachments.length, 0);
  if (attachCount) tags.push(el('span', { class: 'tag', text: `📎 ${attachCount}` }));

  const locked = !item.canView;
  const actions = [];
  if (item.videoPost) actions.push(el('button', { class: 'btn small', onclick: () => openPost(item, 'video'), disabled: locked, text: '▶ Watch' }));
  if (item.audioPost || item.videoPost)
    actions.push(el('button', { class: 'btn small', onclick: () => playAudio(item), disabled: locked, text: '🎧 Listen' }));
  if (item.videoPost)
    actions.push(
      el('button', {
        class: `btn small${st.video ? ' done' : ''}`,
        onclick: () => download([item], { video: true }),
        disabled: locked,
        title: st.video || 'Download video',
        text: st.video ? '✓ Video' : '⬇ Video',
      }),
    );
  if (canAudio(item))
    actions.push(
      el('button', {
        class: `btn small${st.audio ? ' done' : ''}`,
        onclick: () => download([item], { audio: true }),
        disabled: locked || (!item.audioPost && !state.settings.audioFromVideoFallback),
        title: st.audio || (item.audioPost ? 'Download audio file' : 'Extract audio from the video'),
        text: st.audio ? '✓ Audio' : '⬇ Audio',
      }),
    );
  if (!hasMedia) actions.push(el('button', { class: 'btn small', onclick: () => openPost(item), text: 'View post' }));

  return el(
    'div',
    { class: `item${selected ? ' selected' : ''}${locked ? ' locked' : ''}`, role: 'listitem', dataset: { key: item.key } },
    el('input', {
      type: 'checkbox',
      checked: selected,
      disabled: !hasMedia || locked,
      'aria-label': `Select ${item.title}`,
      onchange: (e) => {
        if (e.target.checked) state.selected.add(item.key);
        else state.selected.delete(item.key);
        e.target.closest('.item').classList.toggle('selected', e.target.checked);
        updateSelection();
      },
    }),
    el(
      'button',
      { class: 'thumb', onclick: () => openPost(item), 'aria-label': `Open ${item.title}` },
      item.thumb ? el('img', { src: item.thumb, alt: '', loading: 'lazy' }) : el('div', { class: 'noimg', text: hasMedia ? '♪' : '✎' }),
      item.duration ? el('span', { class: 'dur', text: fmtDuration(item.duration) }) : null,
    ),
    el(
      'div',
      { class: 'i-body' },
      el('div', { class: 'i-title', onclick: () => openPost(item), text: item.title }),
      el('div', { class: 'i-meta' }, el('span', { text: fmtDate(item.publishedAt) }), ...tags),
      textPost?.teaser ? el('div', { class: 'i-teaser', text: textPost.teaser }) : null,
    ),
    el('div', { class: 'i-actions' }, actions),
  );
}

function updateSelection() {
  const n = state.selected.size;
  $('#sel-count').textContent = `${n} selected`;
  ['#btn-dl-sel-video', '#btn-dl-sel-audio', '#btn-dl-sel-both'].forEach((s) => ($(s).disabled = !n));
  const selectable = lastItems.filter((i) => (i.videoPost || i.audioPost) && i.canView);
  const all = $('#sel-all');
  all.checked = selectable.length > 0 && selectable.every((i) => state.selected.has(i.key));
  all.indeterminate = n > 0 && !all.checked;
}

// ---------------------------------------------------------------- downloading
async function download(items, { video = false, audio = false } = {}) {
  const c = currentCampaign();
  const reqs = [];
  for (const item of items) {
    if (!item.canView) continue;
    if (video && item.videoPost) reqs.push({ campaign: c, post: item.videoPost, kind: 'video' });
    if (audio) {
      if (item.audioPost) reqs.push({ campaign: c, post: item.audioPost, kind: 'audio' });
      else if (item.videoPost && state.settings.audioFromVideoFallback) reqs.push({ campaign: c, post: item.videoPost, kind: 'audio' });
    }
  }
  if (!reqs.length) return toast('Nothing to download for that selection.');
  const added = await guard(() => api.downloads.enqueue(reqs), 'Could not queue: ');
  if (added) {
    toast(`Queued ${added.length} download${added.length === 1 ? '' : 's'} → ${state.campaignDir}`, 'ok');
    if (!$('#downloads-drawer').hidden) return;
    openDrawer();
  }
}

function selectedItems() {
  return lastItems.filter((i) => state.selected.has(i.key));
}

$('#btn-dl-sel-video').addEventListener('click', () => download(selectedItems(), { video: true }));
$('#btn-dl-sel-audio').addEventListener('click', () => download(selectedItems(), { audio: true }));
$('#btn-dl-sel-both').addEventListener('click', () => download(selectedItems(), { video: true, audio: true }));
$('#sel-all').addEventListener('change', (e) => {
  for (const i of lastItems) {
    if (!(i.videoPost || i.audioPost) || !i.canView) continue;
    if (e.target.checked) state.selected.add(i.key);
    else state.selected.delete(i.key);
  }
  renderPosts();
});

// ---------------------------------------------------------------- toolbar wiring
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderPosts();
});
$$('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    $$('.seg button').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-checked', String(x === b));
    });
    renderPosts();
  }),
);
$('#opt-group').addEventListener('change', async (e) => {
  state.settings = await api.settings.set({ groupEpisodes: e.target.checked });
  state.selected.clear();
  renderPosts();
});
$('#opt-hide-dl').addEventListener('change', (e) => {
  state.hideDownloaded = e.target.checked;
  renderPosts();
});
$('#btn-load-more').addEventListener('click', loadMore);
$('#btn-load-all').addEventListener('click', loadAll);
$('#btn-refresh').addEventListener('click', async () => {
  state.data[state.currentId] = { posts: [], next: null, total: null, loading: false, loaded: false };
  renderPosts();
  await loadMore();
});
$('#btn-open-patreon').addEventListener('click', () => {
  const c = currentCampaign();
  if (c?.url) api.shell.openExternal(c.url);
});
$('#btn-folder-open').addEventListener('click', () => guard(() => api.shell.openPath(state.campaignDir)));
$('#btn-folder-change').addEventListener('click', async () => {
  const c = currentCampaign();
  const dir = await api.settings.chooseDir(state.campaignDir);
  if (!dir) return;
  state.settings = await api.settings.set({ campaignDirs: { ...state.settings.campaignDirs, [c.id]: dir } });
  await refreshFolder();
  await refreshExisting(state.data[c.id]?.posts);
  renderPosts();
});
$('#btn-folder-reset').addEventListener('click', async () => {
  const c = currentCampaign();
  const dirs = { ...state.settings.campaignDirs };
  delete dirs[c.id];
  state.settings = await api.settings.set({ campaignDirs: dirs });
  await refreshFolder();
  await refreshExisting(state.data[c.id]?.posts);
  renderPosts();
});

// ===================================================================== post viewer / players
let hls = null;
function destroyHls() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

function attachHls(videoEl, url) {
  destroyHls();
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        console.error('hls fatal', data);
        toast(`Playback error: ${data.details}. The link may have expired — try Refresh.`, 'err');
        destroyHls();
      }
    });
    hls.loadSource(url);
    hls.attachMedia(videoEl);
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = url;
  } else {
    toast('HLS playback is not supported in this build.', 'err');
  }
}

const postDialog = $('#post-dialog');
enableLightDismiss(postDialog);
postDialog.addEventListener('close', () => {
  destroyHls();
  $('#pd-media').replaceChildren();
});
$('[data-close]', postDialog).addEventListener('click', () => postDialog.close());

function openPost(item, prefer) {
  const media = $('#pd-media');
  media.replaceChildren();
  $('#pd-title').textContent = item.title;
  $('#pd-date').textContent = `${fmtDate(item.publishedAt)}${item.duration ? ` · ${fmtDuration(item.duration)}` : ''}`;

  const vp = item.videoPost;
  if (vp && item.canView && prefer !== 'none') {
    const v = vp.video;
    if (v.kind === 'embed') {
      media.append(el('div', { class: 'muted', style: 'padding:18px', text: `Embedded ${v.provider || 'video'}: ` }, el('a', { href: v.url, target: '_blank', text: v.url })));
    } else {
      const video = el('video', { controls: true, autoplay: prefer === 'video', crossorigin: 'anonymous', poster: v.thumbnailUrl || vp.thumb || null });
      if (v.transcriptUrl) video.append(el('track', { kind: 'subtitles', src: v.transcriptUrl, srclang: 'en', label: 'English' }));
      media.append(video);
      if (v.kind === 'hls') attachHls(video, v.url);
      else video.src = v.url;
    }
  } else if (item.audioPost && item.canView) {
    media.append(el('audio', { controls: true, src: item.audioPost.audio.url, preload: 'metadata' }));
  } else if (item.thumb) {
    media.append(el('img', { class: 'hero', src: item.thumb, alt: '' }));
  }

  // actions
  const st = itemState(item);
  const acts = $('#pd-actions');
  acts.replaceChildren();
  if (item.videoPost) acts.append(el('button', { class: 'btn small', onclick: () => download([item], { video: true }), text: st.video ? '✓ Video (re-check)' : '⬇ Video' }));
  if (canAudio(item)) acts.append(el('button', { class: 'btn small', onclick: () => download([item], { audio: true }), text: st.audio ? '✓ Audio (re-check)' : '⬇ Audio' }));
  if (item.videoPost?.video?.transcriptUrl)
    acts.append(el('button', { class: 'btn small', onclick: () => api.downloads.enqueue([{ campaign: currentCampaign(), post: item.videoPost, kind: 'subtitles' }]).then(() => openDrawer()), text: '⬇ Subtitles' }));
  if (st.video || st.audio) acts.append(el('button', { class: 'btn small', onclick: () => api.shell.showItem(st.video || st.audio), text: 'Show file' }));
  for (const p of item.posts) if (p.url) acts.append(el('button', { class: 'btn small', onclick: () => api.shell.openExternal(p.url), text: item.posts.length > 1 ? `Patreon (${p.postType.replace(/_/g, ' ')}) ↗` : 'Open on Patreon ↗' }));

  // content
  const content = $('#pd-content');
  content.replaceChildren();
  for (const p of item.posts) {
    const nodes = renderContentJson(p.contentJson);
    if (nodes.length) content.append(...nodes);
    else if (p.teaser && !content.childNodes.length) content.append(el('p', { text: p.teaser }));
  }

  // files
  const files = $('#pd-files');
  files.replaceChildren();
  const c = currentCampaign();
  for (const p of item.posts) {
    for (const a of p.attachments) {
      files.append(
        el('div', { class: 'file' }, el('span', { text: `📎 ${a.name}` }),
          el('button', { class: 'btn small', onclick: () => api.downloads.enqueue([{ campaign: c, post: p, kind: 'attachment', attachment: a }]).then(() => openDrawer()), text: 'Download' })),
      );
    }
    if (p.images.length) {
      files.append(
        el('div', { class: 'gallery' }, p.images.map((im) => el('img', { src: im.thumb, alt: im.name, title: 'Click to download', onclick: () => api.downloads.enqueue([{ campaign: c, post: p, kind: 'attachment', attachment: { name: im.name, url: im.url } }]).then(() => openDrawer()) }))),
      );
    }
  }
  postDialog.showModal();
}

/** Render Patreon's ProseMirror-style content JSON into safe DOM nodes (no innerHTML). */
function renderContentJson(str) {
  if (!str) return [];
  let doc;
  try {
    doc = JSON.parse(str);
  } catch {
    return [];
  }
  const render = (node) => {
    if (!node) return null;
    const kids = () => (node.content || []).map(render).filter(Boolean);
    switch (node.type) {
      case 'doc': return kids();
      case 'paragraph': return node.content?.length ? el('p', {}, kids()) : null;
      case 'heading': return el(`h${Math.min(6, Math.max(2, node.attrs?.level || 3))}`, {}, kids());
      case 'bulletList': case 'bullet_list': return el('ul', {}, kids());
      case 'orderedList': case 'ordered_list': return el('ol', {}, kids());
      case 'listItem': case 'list_item': return el('li', {}, kids());
      case 'blockquote': return el('blockquote', {}, kids());
      case 'hardBreak': case 'hard_break': return el('br');
      case 'horizontalRule': return el('hr');
      case 'image': return node.attrs?.src ? el('img', { src: node.attrs.src, alt: node.attrs.alt || '' }) : null;
      case 'text': {
        let n = document.createTextNode(node.text || '');
        for (const m of node.marks || []) {
          if (m.type === 'bold' || m.type === 'strong') n = el('strong', {}, n);
          else if (m.type === 'italic' || m.type === 'em') n = el('em', {}, n);
          else if (m.type === 'link' && /^https?:/i.test(m.attrs?.href || '')) n = el('a', { href: m.attrs.href, target: '_blank' }, n);
        }
        return n;
      }
      default: return node.content ? el('div', {}, kids()) : null;
    }
  };
  const out = render(doc);
  return (Array.isArray(out) ? out : [out]).filter(Boolean);
}

// persistent audio player
function playAudio(item) {
  const audioEl = $('#audio-el');
  destroyAudioHls();
  if (item.audioPost) {
    audioEl.src = item.audioPost.audio.url;
  } else if (item.videoPost?.video?.kind === 'hls') {
    // Play the video's HLS stream audio-only.
    if (window.Hls && Hls.isSupported()) {
      audioHls = new Hls();
      audioHls.loadSource(item.videoPost.video.url);
      audioHls.attachMedia(audioEl);
    }
  } else if (item.videoPost) {
    audioEl.src = item.videoPost.video.url;
  }
  $('#audio-title').textContent = item.title;
  $('#audio-sub').textContent = `${currentCampaign()?.name || ''} · ${fmtDate(item.publishedAt)}${item.audioPost ? '' : ' · (from video)'}`;
  $('#audio-thumb').src = item.thumb || currentCampaign()?.avatar || '';
  $('#audio-bar').hidden = false;
  document.body.classList.add('has-audio');
  audioEl.play().catch(() => {});
}
let audioHls = null;
function destroyAudioHls() {
  if (audioHls) {
    audioHls.destroy();
    audioHls = null;
  }
}
$('#audio-close').addEventListener('click', () => {
  const a = $('#audio-el');
  a.pause();
  destroyAudioHls();
  a.removeAttribute('src');
  a.load();
  $('#audio-bar').hidden = true;
  document.body.classList.remove('has-audio');
});

// ===================================================================== downloads drawer
function openDrawer() {
  $('#downloads-drawer').hidden = false;
  renderJobs();
}
$('#btn-downloads').addEventListener('click', () => {
  const d = $('#downloads-drawer');
  if (d.hidden) openDrawer();
  else d.hidden = true;
});
$('#btn-dl-close').addEventListener('click', () => ($('#downloads-drawer').hidden = true));
$('#btn-dl-clear').addEventListener('click', () => api.downloads.clear());

const jobEls = new Map();
function renderJob(j) {
  const pct = j.progress != null ? Math.round(j.progress * 100) : null;
  const bits = [j.stage || j.status];
  if (j.status === 'running') {
    if (pct != null) bits.push(`${pct}%`);
    if (j.downloaded) bits.push(`${fmtBytes(j.downloaded)}${j.total ? ` / ${fmtBytes(j.total)}` : ''}`);
    if (j.speed) bits.push(`${fmtBytes(j.speed)}/s`);
    if (j.eta) bits.push(`ETA ${fmtDuration(j.eta)}`);
  }
  const btns = [];
  if (j.status === 'running' || j.status === 'queued') btns.push(el('button', { class: 'btn small', onclick: () => api.downloads.cancel(j.id), text: 'Cancel' }));
  if (j.status === 'error' || j.status === 'canceled') btns.push(el('button', { class: 'btn small', onclick: () => api.downloads.retry(j.id), text: 'Retry' }));
  if (j.status === 'done' && j.outPath) {
    btns.push(el('button', { class: 'btn small', onclick: () => api.shell.openPath(j.outPath), text: 'Open' }));
    btns.push(el('button', { class: 'btn small', onclick: () => api.shell.showItem(j.outPath), text: 'Show in folder' }));
  } else btns.push(el('button', { class: 'btn small', onclick: () => api.shell.openPath(j.dir), text: 'Folder' }));

  const kindLabel = { video: '🎬 Video', audio: '🎧 Audio', subtitles: '💬 Subtitles', attachment: '📎 File' }[j.kind] || j.kind;
  const progress = el('progress', { max: 1 });
  if (j.progress != null) progress.value = j.status === 'done' ? 1 : j.progress;
  else if (j.status !== 'running') progress.value = 0;

  return el(
    'div',
    { class: `dl ${j.status}` },
    el('div', { class: 'dl-top' }, el('div', { class: 'dl-title', text: j.title }), el('span', { class: 'tag', text: kindLabel })),
    el('div', { class: 'dl-stage', text: `${j.campaign?.name || ''} · ${bits.join(' · ')}` }),
    progress,
    j.error ? el('div', { class: 'dl-err', text: j.error }) : null,
    el('div', { class: 'dl-btns' }, btns),
  );
}

function renderJobs() {
  const active = [...state.jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length;
  $('#dl-badge').hidden = !active;
  $('#dl-badge').textContent = active;
  if ($('#downloads-drawer').hidden) return;
  const list = $('#dl-list');
  const jobs = [...state.jobs.values()].sort((a, b) => b.id - a.id);
  if (!jobs.length) return list.replaceChildren(el('div', { class: 'dl-empty', text: 'No downloads yet.' }));
  list.replaceChildren(...jobs.map((j) => {
    const n = renderJob(j);
    jobEls.set(j.id, n);
    return n;
  }));
}

let jobsRaf = 0;
api.downloads.onUpdate((j) => {
  const prev = state.jobs.get(j.id);
  state.jobs.set(j.id, j);
  if (j.status === 'done' && prev?.status !== 'done') {
    toast(`Saved: ${j.title}`, 'ok');
    if (j.campaign?.id === state.currentId) {
      const posts = state.data[state.currentId]?.posts.filter((p) => p.id === j.postId) || [];
      refreshExisting(posts).then(renderPosts);
    }
  }
  if (j.status === 'error' && prev?.status !== 'error') toast(`Download failed: ${j.title}`, 'err');
  if (!jobsRaf) jobsRaf = requestAnimationFrame(() => ((jobsRaf = 0), renderJobs()));
});
api.downloads.onCleared((list) => {
  state.jobs = new Map(list.map((j) => [j.id, j]));
  renderJobs();
});

// ===================================================================== tools
function renderToolsBanner(p) {
  const b = $('#tools-banner');
  if (!p) return (b.hidden = true);
  b.hidden = false;
  const pct = p.total ? p.received / p.total : null;
  const label = p.stage ? `${p.stage} ${p.label}…` : `Downloading ${p.label}… ${p.total ? `${fmtBytes(p.received)} / ${fmtBytes(p.total)}` : fmtBytes(p.received)}`;
  const prog = el('progress', { max: 1 });
  if (pct != null) prog.value = pct;
  b.replaceChildren(el('div', { text: `🔧 ${label}` }), prog);
  $('#st-tools-progress').textContent = label;
}
api.tools.onProgress(renderToolsBanner);
api.tools.onStatus((st) => {
  renderToolsBanner(null);
  $('#st-tools-progress').textContent = '';
  if (st?.error) toast(`Tool setup failed: ${st.error}`, 'err');
  else if (st && !st.ready) toast('yt-dlp/ffmpeg not fully available. See Settings → Tools.', 'err');
  if (st && !st.error) fillToolStatus(st);
});

function fillToolStatus(st) {
  $('#st-tools-dir').textContent = st.dir;
  $('#st-yt').textContent = st.ytDlp ? `${st.ytDlp.version || '?'} (${st.ytDlp.source})` : 'not installed';
  $('#st-ff').textContent = st.ffmpeg ? `${st.ffmpeg.version || '?'} (${st.ffmpeg.source})` : 'not installed';
}

// ===================================================================== settings
const stDialog = $('#settings-dialog');
enableLightDismiss(stDialog);

$('#btn-settings').addEventListener('click', async () => {
  const s = (state.settings = await api.settings.get());
  $('#st-dir').value = s.downloadDir;
  $('#st-subfolder').checked = s.perCreatorSubfolder;
  $('#st-template').value = s.filenameTemplate;
  $('#st-quality').value = s.videoQuality;
  $('#st-concurrency').value = s.concurrency;
  $('#st-audio-fallback').checked = s.audioFromVideoFallback;
  $('#st-subs').checked = s.saveSubtitles;
  $('#st-embed-subs').checked = s.embedSubtitles !== false;
  $('#st-thumb').checked = s.saveThumbnail;
  $('#st-account').textContent = state.user ? `Logged in as ${state.user.name}` : '';
  stDialog.returnValue = '';
  stDialog.showModal();
  api.tools.status().then(fillToolStatus).catch(() => {});
});

stDialog.addEventListener('close', async () => {
  if (stDialog.returnValue !== 'save') return;
  state.settings = await api.settings.set({
    downloadDir: $('#st-dir').value.trim(),
    perCreatorSubfolder: $('#st-subfolder').checked,
    filenameTemplate: $('#st-template').value.trim() || '{title}',
    videoQuality: $('#st-quality').value,
    concurrency: Number($('#st-concurrency').value) || 2,
    audioFromVideoFallback: $('#st-audio-fallback').checked,
    saveSubtitles: $('#st-subs').checked,
    embedSubtitles: $('#st-embed-subs').checked,
    saveThumbnail: $('#st-thumb').checked,
  });
  toast('Settings saved.', 'ok');
  if (state.currentId) {
    await refreshFolder();
    await refreshExisting(state.data[state.currentId]?.posts);
    renderPosts();
  }
});

$('#st-dir-browse').addEventListener('click', async () => {
  const d = await api.settings.chooseDir($('#st-dir').value);
  if (d) $('#st-dir').value = d;
});
$('#st-tools-open').addEventListener('click', () => api.shell.openPath($('#st-tools-dir').textContent));
$('#st-yt-update').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const st = await guard(() => api.tools.updateYtDlp(), 'yt-dlp update failed: ');
  e.target.disabled = false;
  if (st) (fillToolStatus(st), toast('yt-dlp is up to date.', 'ok'));
  renderToolsBanner(null);
});
$('#st-ff-reinstall').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const st = await guard(() => api.tools.install({ force: true, only: 'ffmpeg' }), 'ffmpeg install failed: ');
  e.target.disabled = false;
  if (st) (fillToolStatus(st), toast('ffmpeg installed.', 'ok'));
  renderToolsBanner(null);
});
$('#st-logout').addEventListener('click', async () => {
  await api.auth.logout();
  stDialog.close();
  state.data = {};
  state.currentId = null;
  $('#campaign-view').hidden = true;
  $('#empty-state').hidden = false;
  showLogin();
});

// ===================================================================== boot
(async function boot() {
  state.settings = await api.settings.get();
  $('#opt-group').checked = state.settings.groupEpisodes;
  for (const j of await api.downloads.list()) state.jobs.set(j.id, j);
  renderJobs();
  try {
    const r = await api.auth.status();
    if (r.loggedIn) await onLoggedIn(r);
    else showLogin(r.error ? `Not logged in: ${r.error}` : '');
  } catch (e) {
    showLogin(e.message);
  }
})();
