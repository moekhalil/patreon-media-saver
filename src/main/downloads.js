'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const settings = require('./settings');
const tools = require('./tools');
const patreon = require('./patreon');
const { resolveCampaignDir, buildBaseName } = require('./paths');

// Headers for direct (non-yt-dlp) downloads. NOTE: don't send `origin` here – combined with
// credentials:'include' Chromium switches to CORS mode and the CDN's ACAO makes it fail (net::ERR_FAILED).
const PATREON_HEADERS = {
  referer: 'https://www.patreon.com/',
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
};

const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.mov'];
const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac'];

let nextId = 1;
const jobs = new Map(); // id -> job
const running = new Map(); // id -> { cancel() }
let emit = () => {};

function publicJob(j) {
  const { post, ...rest } = j;
  return rest;
}

function update(job, patch) {
  Object.assign(job, patch);
  emit('downloads:update', publicJob(job));
}

function list() {
  return [...jobs.values()].map(publicJob);
}

function setEmitter(fn) {
  emit = fn;
}

// ------------------------------------------------------------------ helpers

function extFromUrl(u, fallback) {
  try {
    const e = path.extname(new URL(u).pathname).toLowerCase();
    return e && e.length <= 6 ? e : fallback;
  } catch {
    return fallback;
  }
}

function existsAny(dir, base, exts) {
  for (const e of exts) {
    const p = path.join(dir, base + e);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** For each post, report which media already exist on disk. */
function existing(campaign, posts) {
  const dir = resolveCampaignDir(campaign);
  const out = {};
  for (const post of posts) {
    const base = buildBaseName(post, campaign);
    out[post.id] = {
      dir,
      base,
      video: post.video ? existsAny(dir, base, VIDEO_EXTS) : null,
      audio: existsAny(dir, base, AUDIO_EXTS),
    };
  }
  return out;
}

function fmtSelector(q) {
  const h = parseInt(q, 10);
  if (!h) return 'bv*+ba/b';
  return `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    proc.kill('SIGTERM');
  }
}

// ------------------------------------------------------------------ direct HTTP download (mp3, vtt, attachments)

async function directDownload(job, url, outPath, signal) {
  const report = job ? (patch) => update(job, patch) : () => {};
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  if (fs.existsSync(outPath)) {
    report({ progress: 1, stage: 'Already exists – skipped' });
    return outPath;
  }
  const part = outPath + '.part';
  let start = 0;
  try {
    start = (await fsp.stat(part)).size;
  } catch {
    /* fresh */
  }
  const headers = { ...PATREON_HEADERS };
  if (start > 0) headers.range = `bytes=${start}-`;
  const res = await patreon.ses().fetch(url, { headers, signal, credentials: 'include' });
  if (res.status === 416) {
    await fsp.rename(part, outPath);
    return outPath;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} while downloading`);
  const append = res.status === 206 && start > 0;
  if (!append) start = 0;
  const len = Number(res.headers.get('content-length')) || 0;
  const total = len ? len + start : 0;
  let received = start;
  let lastT = Date.now();
  let lastB = received;
  const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  const body = Readable.fromWeb(res.body);
  await new Promise((resolve, reject) => {
    body.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastT > 400) {
        const speed = ((received - lastB) * 1000) / (now - lastT);
        lastT = now;
        lastB = received;
        report({
          progress: total ? received / total : null,
          downloaded: received,
          total,
          speed,
          eta: total && speed ? (total - received) / speed : null,
        });
      }
    });
    body.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    body.pipe(ws);
  });
  await fsp.rename(part, outPath);
  report({ progress: 1, downloaded: received, total: total || received });
  return outPath;
}

// ------------------------------------------------------------------ yt-dlp

async function ytDlpDownload(job, url, mode, dir, base, onProc) {
  const st = await tools.status();
  if (!st.ytDlp) throw new Error('yt-dlp is not installed. Open Settings → Tools and click Install.');
  const s = settings.load();
  await fsp.mkdir(dir, { recursive: true });

  const args = [
    '--newline',
    '--color', 'never',
    '--continue',
    '--no-overwrites',
    '--no-playlist',
    '--concurrent-fragments', '4',
    '--add-headers', 'Origin:https://www.patreon.com',
    '--add-headers', 'Referer:https://www.patreon.com/',
    '--add-headers', 'Accept-Language:en-US,en;q=0.9',
    '-P', dir,
    '-o', `${base.replace(/%/g, '%%')}.%(ext)s`,
    '--progress-template',
    'download:[PMS]%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.format_id)s',
  ];
  if (st.ffmpeg) args.push('--ffmpeg-location', st.ffmpeg.path);
  if (mode === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('-f', fmtSelector(s.videoQuality), '--merge-output-format', 'mp4', '--remux-video', 'mp4');
  }
  args.push('--', url);

  const proc = spawn(st.ytDlp.path, args, {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  onProc(proc);
  const log = [];
  let errLine = '';
  let streamNo = 0;
  let lastFormat = null;

  const handle = (line) => {
    line = line.trim();
    if (!line) return;
    if (line.startsWith('[PMS]')) {
      const [status, dl, tot, est, speed, eta, fi, fc, fmt] = line.slice(5).split('|');
      const num = (v) => (v && v !== 'NA' && v !== 'None' ? Number(v) : null);
      if (fmt !== lastFormat) {
        lastFormat = fmt;
        streamNo++;
      }
      const total = num(tot) || num(est);
      const fiN = num(fi);
      const fcN = num(fc);
      let progress = total ? num(dl) / total : null;
      if (fcN && fiN) progress = fiN / fcN;
      update(job, {
        stage: streamNo > 1 ? `Downloading stream ${streamNo} (${fmt})` : `Downloading (${fmt})`,
        progress: progress != null ? Math.min(1, progress) : job.progress,
        downloaded: num(dl),
        total,
        speed: num(speed),
        eta: num(eta),
        ...(status === 'finished' ? { progress: 1 } : {}),
      });
      return;
    }
    log.push(line);
    if (log.length > 60) log.shift();
    if (/^ERROR:/.test(line)) errLine = line;
    else if (/^\[(Merger|ExtractAudio|VideoRemuxer|FixupM3u8|Fixup\w*)\]/.test(line)) {
      const pp = line.match(/^\[(\w+)\]/)[1];
      const label = { Merger: 'Merging audio + video…', ExtractAudio: 'Extracting audio…', VideoRemuxer: 'Remuxing to mp4…' }[pp] || 'Finalizing file…';
      update(job, { stage: label });
    }
    else if (/has already been downloaded/.test(line)) update(job, { stage: 'Already downloaded', progress: 1 });
  };

  const pump = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      lines.forEach(handle);
    });
    stream.on('end', () => buf && handle(buf));
  };
  pump(proc.stdout);
  pump(proc.stderr);

  const code = await new Promise((resolve) => {
    proc.on('error', (e) => {
      errLine = e.message;
      resolve(-1);
    });
    proc.on('close', resolve);
  });
  job.log = log.slice(-25);
  if (job.status === 'canceled') throw new Error('Canceled');
  if (code !== 0) throw new Error(errLine || `yt-dlp exited with code ${code}`);
  const exts = mode === 'audio' ? AUDIO_EXTS : VIDEO_EXTS;
  return existsAny(dir, base, exts);
}

// ------------------------------------------------------------------ subtitles (ffmpeg)

/** Run ffmpeg, resolving with { code, stderr }. */
function runFfmpeg(ffmpeg, args, onProc) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    onProc?.(p);
    let stderr = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    p.stdout.resume();
    p.on('error', (e) => resolve({ code: -1, stderr: e.message }));
    p.on('close', (code) => resolve({ code, stderr }));
  });
}

/** True if the media file already contains a subtitle stream. */
async function hasSubtitleStream(ffmpeg, file) {
  // `ffmpeg -i file` with no output exits non-zero but prints the stream list to stderr.
  const { stderr } = await runFfmpeg(ffmpeg, ['-hide_banner', '-i', file]);
  return /Stream #\d+:\d+.*: Subtitle:/.test(stderr);
}

/**
 * Download the post's transcript VTT and mux it into the video as a soft subtitle track
 * (mov_text for mp4/mov, webvtt for mkv/webm). Streams are copied, so this is fast and lossless.
 * Skips files that already have a subtitle track, which also means re-checking an old download adds subs to it.
 */
async function embedSubtitles(job, videoPath, vttUrl, signal, onProc) {
  const st = await tools.status();
  if (!st.ffmpeg) throw new Error('ffmpeg is not installed (needed to embed subtitles).');
  const ffmpeg = st.ffmpeg.path;
  if (await hasSubtitleStream(ffmpeg, videoPath)) return false;

  const ext = path.extname(videoPath).toLowerCase();
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, ext);
  const vtt = path.join(dir, `${stem}.pms-subs.vtt`);
  const tmp = path.join(dir, `${stem}.pms-embed${ext}`);
  try {
    await fsp.rm(vtt, { force: true });
    await directDownload(null, vttUrl, vtt, signal);
    const subCodec = ext === '.mkv' || ext === '.webm' ? 'webvtt' : 'mov_text';
    const args = [
      '-hide_banner', '-nostdin', '-y',
      '-i', videoPath,
      '-i', vtt,
      '-map', '0:v?', '-map', '0:a?', '-map', '1:0',
      '-c', 'copy', '-c:s', subCodec,
      '-metadata:s:s:0', 'language=eng',
      '-metadata:s:s:0', 'title=Transcript',
      '-map_metadata', '0',
      ...(ext === '.mp4' || ext === '.mov' ? ['-movflags', '+faststart'] : []),
      tmp,
    ];
    const { code, stderr } = await runFfmpeg(ffmpeg, args, onProc);
    if (job.status === 'canceled') throw new Error('Canceled');
    if (code !== 0) {
      const last = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
      throw new Error(`ffmpeg failed to embed subtitles: ${last}`);
    }
    await fsp.rename(tmp, videoPath); // replace the original in place
    return true;
  } finally {
    await fsp.rm(vtt, { force: true }).catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ job runner

async function freshPost(job) {
  try {
    const p = await patreon.getPost(job.postId);
    // If the refetch came back without media (e.g. no access / logged out), keep the cached URLs.
    return {
      ...job.post,
      ...p,
      video: p.video || job.post.video,
      audio: p.audio || job.post.audio,
    };
  } catch (e) {
    console.warn('refresh post failed, using cached URLs:', e.message);
    return job.post;
  }
}

async function runJob(job) {
  const ctl = new AbortController();
  let proc = null;
  running.set(job.id, {
    cancel() {
      ctl.abort();
      killTree(proc);
    },
  });
  update(job, { status: 'running', stage: 'Refreshing media URL…', progress: null, startedAt: Date.now() });
  try {
    const post = job.kind === 'attachment' ? job.post : await freshPost(job);
    const s = settings.load();
    const { dir, base } = job;
    let out = null;
    let note = '';

    if (job.kind === 'video') {
      if (!post.video) throw new Error('This post has no video.');
      out = await ytDlpDownload(job, post.video.url, 'video', dir, base, (p) => (proc = p));
      if (s.embedSubtitles && post.video.transcriptUrl && out) {
        update(job, { stage: 'Embedding subtitles…', speed: null, eta: null });
        try {
          const added = await embedSubtitles(job, out, post.video.transcriptUrl, ctl.signal, (p) => (proc = p));
          note = added ? 'subtitles embedded' : 'subtitles already embedded';
        } catch (e) {
          if (job.status === 'canceled' || ctl.signal.aborted) throw e;
          console.warn('embed subs failed', e.message);
          note = 'video saved, but embedding subtitles failed';
        }
      }
      if (s.saveSubtitles && post.video.transcriptUrl) {
        update(job, { stage: 'Saving subtitles…' });
        await directDownload(null, post.video.transcriptUrl, path.join(dir, base + '.vtt'), ctl.signal).catch((e) =>
          console.warn('subs failed', e.message),
        );
      }
    } else if (job.kind === 'audio') {
      if (post.audio) {
        const url = post.audio.downloadUrl || post.audio.url;
        update(job, { stage: 'Downloading audio' });
        out = await directDownload(job, url, path.join(dir, base + extFromUrl(url, '.mp3')), ctl.signal);
      } else if (post.video) {
        update(job, { stage: 'Extracting audio from video' });
        out = await ytDlpDownload(job, post.video.url, 'audio', dir, base, (p) => (proc = p));
      } else throw new Error('This post has no audio.');
    } else if (job.kind === 'subtitles') {
      if (!post.video?.transcriptUrl) throw new Error('No transcript/subtitles available.');
      out = await directDownload(job, post.video.transcriptUrl, path.join(dir, base + '.vtt'), ctl.signal);
    } else if (job.kind === 'attachment') {
      out = await directDownload(job, job.url, path.join(dir, job.fileName), ctl.signal);
    }

    if (s.saveThumbnail && post.thumb && (job.kind === 'video' || job.kind === 'audio')) {
      const tp = path.join(dir, base + extFromUrl(post.thumb, '.jpg'));
      if (!fs.existsSync(tp)) await directDownload(null, post.thumb, tp, ctl.signal).catch(() => {});
    }

    update(job, { status: 'done', progress: 1, stage: note ? `Done – ${note}` : 'Done', outPath: out, finishedAt: Date.now(), speed: null, eta: null });
  } catch (e) {
    if (job.status === 'canceled' || ctl.signal.aborted) update(job, { status: 'canceled', stage: 'Canceled', speed: null, eta: null });
    else update(job, { status: 'error', stage: 'Failed', error: e.message, speed: null, eta: null });
  } finally {
    running.delete(job.id);
    pump();
  }
}

function pump() {
  const max = settings.load().concurrency || 2;
  for (const job of jobs.values()) {
    if (running.size >= max) break;
    if (job.status === 'queued') runJob(job);
  }
}

/**
 * Enqueue downloads.
 * @param {Array<{campaign, post, kind: 'video'|'audio'|'subtitles'|'attachment', attachment?}>} reqs
 */
function enqueue(reqs) {
  const added = [];
  for (const r of reqs) {
    const dir = resolveCampaignDir(r.campaign);
    const base = buildBaseName(r.post, r.campaign);
    // De-dupe: same post + kind already queued/running.
    const dupe = [...jobs.values()].find(
      (j) => j.postId === r.post.id && j.kind === r.kind && (j.status === 'queued' || j.status === 'running') &&
        (r.kind !== 'attachment' || j.url === r.attachment?.url),
    );
    if (dupe) continue;
    const job = {
      id: nextId++,
      campaign: { id: r.campaign.id, name: r.campaign.name, vanity: r.campaign.vanity },
      postId: r.post.id,
      title: r.kind === 'attachment' ? `${r.post.title} – ${r.attachment.name}` : r.post.title,
      kind: r.kind,
      dir,
      base,
      url: r.attachment?.url,
      fileName: r.attachment ? require('./paths').sanitizeFileName(r.attachment.name) : undefined,
      post: r.post,
      status: 'queued',
      stage: 'Queued',
      progress: 0,
      addedAt: Date.now(),
    };
    jobs.set(job.id, job);
    added.push(publicJob(job));
    emit('downloads:update', publicJob(job));
  }
  pump();
  return added;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.status === 'queued') update(job, { status: 'canceled', stage: 'Canceled' });
  else if (job.status === 'running') {
    job.status = 'canceled';
    running.get(id)?.cancel();
  }
}

function retry(id) {
  const job = jobs.get(id);
  if (!job || job.status === 'running' || job.status === 'queued') return;
  update(job, { status: 'queued', stage: 'Queued', error: null, progress: 0 });
  pump();
}

function clearFinished() {
  for (const [id, j] of jobs) if (['done', 'error', 'canceled'].includes(j.status)) jobs.delete(id);
  emit('downloads:cleared', list());
}

function cancelAll() {
  for (const j of jobs.values()) cancel(j.id);
}

module.exports = { enqueue, cancel, retry, clearFinished, cancelAll, list, existing, setEmitter };
