'use strict';
/**
 * Manages external tools (yt-dlp, ffmpeg/ffprobe) inside a local "third-party" folder.
 * Nothing is installed globally; PATH is only used as a fallback on platforms
 * where we don't auto-download (e.g. ffmpeg on macOS).
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { app } = require('electron');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

function thirdPartyDir() {
  let base;
  if (!app.isPackaged) base = path.resolve(__dirname, '..', '..');
  else if (process.env.PORTABLE_EXECUTABLE_DIR) base = process.env.PORTABLE_EXECUTABLE_DIR;
  else base = path.dirname(process.execPath);
  const dir = path.join(base, 'third-party');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    const fallback = path.join(app.getPath('userData'), 'third-party');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function toolPath(name) {
  return path.join(thirdPartyDir(), name + EXE);
}

function ytDlpAsset() {
  if (IS_WIN) return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function ffmpegAsset() {
  const base = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/';
  if (IS_WIN) return base + (process.arch === 'arm64' ? 'ffmpeg-master-latest-winarm64-gpl.zip' : 'ffmpeg-master-latest-win64-gpl.zip');
  if (process.platform === 'linux')
    return base + (process.arch === 'arm64' ? 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz' : 'ffmpeg-master-latest-linux64-gpl.tar.xz');
  return null; // macOS: rely on PATH (e.g. `brew install ffmpeg`)
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim());
    });
  });
}

function which(cmd) {
  return new Promise((resolve) => {
    execFile(IS_WIN ? 'where' : 'which', [cmd], { windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).split(/\r?\n/)[0].trim() || null);
    });
  });
}

/** Locate a tool: local third-party folder first, then PATH. */
async function locate(name) {
  const local = toolPath(name);
  if (fs.existsSync(local)) return { path: local, source: 'local' };
  const sys = await which(name);
  if (sys) return { path: sys, source: 'system' };
  return null;
}

async function status() {
  const [y, f] = await Promise.all([locate('yt-dlp'), locate('ffmpeg')]);
  const ytVersion = y ? await run(y.path, ['--version']) : null;
  const ffOut = f ? await run(f.path, ['-hide_banner', '-version']) : null;
  const ffVersion = ffOut ? (ffOut.split(/\r?\n/)[0].match(/version\s+(\S+)/) || [])[1] || 'unknown' : null;
  return {
    dir: thirdPartyDir(),
    ytDlp: y ? { ...y, version: ytVersion } : null,
    ffmpeg: f ? { ...f, version: ffVersion } : null,
    ready: !!(y && f),
  };
}

let installing = null;

async function download(url, dest, label, onProgress) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'patreon-media-saver' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let last = 0;
  const tmp = dest + '.download';
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - last > 200) {
      last = now;
      onProgress?.({ label, received, total });
    }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  onProgress?.({ label, received, total: total || received });
  await fsp.rm(dest, { force: true });
  await fsp.rename(tmp, dest);
}

function extract(archive, outDir) {
  return new Promise((resolve, reject) => {
    // bsdtar ships with Windows 10+ and handles .zip; GNU tar handles .tar.xz on Linux.
    const args = archive.endsWith('.zip') ? ['-xf', archive, '-C', outDir] : ['-xJf', archive, '-C', outDir];
    const p = spawn('tar', args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err}`))));
  });
}

async function findFile(dir, name) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const r = await findFile(full, name);
      if (r) return r;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) return full;
  }
  return null;
}

async function installYtDlp(onProgress) {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytDlpAsset()}`;
  const dest = toolPath('yt-dlp');
  await download(url, dest, 'yt-dlp', onProgress);
  if (!IS_WIN) await fsp.chmod(dest, 0o755);
}

async function installFfmpeg(onProgress) {
  const url = ffmpegAsset();
  if (!url) throw new Error('Automatic ffmpeg install is not supported on this platform. Install ffmpeg and put it on PATH.');
  const dir = thirdPartyDir();
  const archive = path.join(os.tmpdir(), `pms-${Date.now()}-${path.basename(url)}`);
  const work = path.join(os.tmpdir(), `pms-ffmpeg-${Date.now()}`);
  try {
    await download(url, archive, 'ffmpeg', onProgress);
    onProgress?.({ label: 'ffmpeg', stage: 'extracting' });
    await fsp.mkdir(work, { recursive: true });
    await extract(archive, work);
    for (const bin of ['ffmpeg', 'ffprobe']) {
      const found = await findFile(work, bin + EXE);
      if (!found) throw new Error(`${bin} not found in archive`);
      const dest = path.join(dir, bin + EXE);
      await fsp.rm(dest, { force: true });
      await fsp.copyFile(found, dest);
      if (!IS_WIN) await fsp.chmod(dest, 0o755);
    }
  } finally {
    await fsp.rm(archive, { force: true }).catch(() => {});
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Ensure tools exist in the third-party folder.
 * @param {{force?: boolean, only?: 'yt-dlp'|'ffmpeg'}} opts
 */
function ensure(opts = {}, onProgress) {
  if (installing) return installing;
  installing = (async () => {
    try {
      const wantY = !opts.only || opts.only === 'yt-dlp';
      const wantF = !opts.only || opts.only === 'ffmpeg';
      if (wantY && (opts.force || !fs.existsSync(toolPath('yt-dlp')))) {
        // Always prefer a local copy in ./third-party, even if one exists on PATH.
        await installYtDlp(onProgress);
      }
      // Same for ffmpeg where we can auto-download it (Windows/Linux); macOS falls back to PATH.
      if (wantF && ffmpegAsset() && (opts.force || !fs.existsSync(toolPath('ffmpeg')))) {
        await installFfmpeg(onProgress);
      }
      return status();
    } finally {
      installing = null;
    }
  })();
  return installing;
}

/** Self-update yt-dlp (the official binaries support -U). */
async function updateYtDlp(onProgress) {
  const local = toolPath('yt-dlp');
  if (!fs.existsSync(local)) return ensure({ only: 'yt-dlp' }, onProgress);
  onProgress?.({ label: 'yt-dlp', stage: 'updating' });
  await new Promise((resolve) => {
    const p = spawn(local, ['-U'], { windowsHide: true });
    p.on('close', resolve);
    p.on('error', resolve);
  });
  return status();
}

module.exports = { thirdPartyDir, locate, status, ensure, updateYtDlp };
