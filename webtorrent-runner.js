#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs').promises;
const WebTorrent = require('webtorrent');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { existsSync } = require('fs');

const argv = yargs(hideBin(process.argv))
  .demandCommand(1, 'Provide a magnet URI')
  .option('p', { type: 'number', default: 8888 })
  .parseSync();

const magnet = argv._[0];
if (!magnet.startsWith('magnet:?')) {
  console.error('Invalid magnet URI');
  process.exit(1);
}

/* ──────────────────────────────────────────────────────────────
   Globals
   ────────────────────────────────────────────────────────────── */
let torrent, server, client, playerProc, progressInterval;
let streamErrorLogged = false;  // Suppress repeated errors
let pollInterval;               // For VLC process polling

/* ──────────────────────────────────────────────────────────────
   1. Torrent + HTTP server (error-suppressed)
   ────────────────────────────────────────────────────────────── */
(async () => {
  const dlDir = path.resolve('downloads');
  await fs.mkdir(dlDir, { recursive: true }).catch(() => {});

  client = new WebTorrent({
    dht: true,
    utp: false,
    tracker: {
      announce: [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://tracker.openbittorrent.com:80/announce',
        'udp://exodus.desync.com:6969/announce',
        'http://tracker.opentrackr.org:1337/announce',
        'https://tracker.btorrent.xyz:443/announce',
        'https://tracker.openwebtorrent.com'
      ]
    }
  });

  client.on('error', err => {
    console.error('Client error:', err.message);
    shutdown(1);
  });

  console.log('🔗 Connecting to peers...');
  client.add(magnet, { path: dlDir }, t => {
    torrent = t;
    console.log(`📦 Torrent: ${t.name}`);

    const video = t.files.find(f => /\.(mp4|mkv|avi|webm|m4v)$/i.test(f.name));
    if (!video) {
      console.error('❌ No video file found in torrent');
      shutdown(1);
    }

    console.log(`🎞️ Video: ${video.name} (${(video.length / 1e6).toFixed(1)} MB)`);

    // ── HTTP server (suppressed errors) ──
    server = http.createServer((req, res) => {
      if (req.method !== 'GET') return res.writeHead(405).end();

      const range = req.headers.range;
      const size = video.length;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'video/mp4');

      if (!range) {
        res.writeHead(200, { 'Content-Length': size });
        const stream = video.createReadStream();
        stream.on('error', e => logStreamError(e));
        stream.pipe(res);
        return;
      }

      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : size - 1;
      const chunksize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': chunksize
      });

      const stream = video.createReadStream({ start, end });
      stream.on('error', e => logStreamError(e));
      stream.pipe(res);
    });

    server.listen(argv.p, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${argv.p}`;
      console.log(`✅ Streaming ready: ${url}`);
      launchPlayer(url);
    });

    // ── Progress ──
    let last = 0;
    progressInterval = setInterval(() => {
      if (!torrent) return;
      const prog = ((torrent.downloaded / torrent.length) * 100).toFixed(1);
      const speed = ((torrent.downloaded - last) / 5 / 1024).toFixed(1);
      last = torrent.downloaded;
      console.log(`${prog}% | ${speed} KB/s | ${torrent.numPeers} peers`);
    }, 5000);

    t.on('done', () => {
      console.log('🏁 Download complete!');
    });
  });
})();

// ── Helper: Log stream errors only once ──
function logStreamError(e) {
  if (!streamErrorLogged && e.message.includes('prematurely')) {
    console.error('Stream hiccup (normal for seeking):', e.message);
    streamErrorLogged = true;
  }
}

/* ──────────────────────────────────────────────────────────────
   2. Launch VLC (with vlc://quit + polling for close detection)
   ────────────────────────────────────────────────────────────── */
function launchPlayer(url) {
  const vlcPaths = [
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
  ];
  const vlcPath = vlcPaths.find(p => existsSync(p));
  const isWin = process.platform === 'win32';

  if (vlcPath) {
    const args = [
      url,
      '--no-video-title-show',
      '--network-caching=1000',
      '--vout=any',
      '--play-and-exit',
      'vlc://quit'
    ];

    // ✅ Launch VLC in foreground (no hidden window)
    playerProc = spawn(vlcPath, args, {
      windowsHide: false,   // ❗ show the window in foreground
      detached: false,      // don't run in background process group
      stdio: 'ignore'
    });

    console.log('🎬 VLC launched in foreground.');

    // Detect when VLC closes
    playerProc.on('exit', (code) => {
      console.log(`VLC exited (code=${code})`);
      shutdown(0);
    });

  } else {
    // Browser fallback — opens and focuses new tab
    const browserCmd = isWin
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
    
    spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', browserCmd] : ['-c', browserCmd], {
      stdio: 'ignore',
      windowsHide: false,   // ❗ allow focus
      detached: true
    }).unref();

    console.log('🌐 Browser launched in foreground.');
  }
}


/* ──────────────────────────────────────────────────────────────
   3. Shutdown (clears poll too)
   ────────────────────────────────────────────────────────────── */
async function shutdown(exitCode = 0) {
  console.log('\n🧹 Shutting down...');

  if (progressInterval) clearInterval(progressInterval);
  if (pollInterval) clearInterval(pollInterval);

  if (server) {
    await new Promise(r => server.close(r)).catch(() => {});
    console.log('HTTP server stopped');
  }

  if (client) {
    client.destroy(err => {
      if (err) console.error('Client destroy error:', err.message);
      else console.log('Torrent client destroyed');
    });
    await new Promise(r => setTimeout(r, 500));
  }

  const dlDir = path.resolve('downloads');
  try {
    const entries = await fs.readdir(dlDir);
    if (entries.length > 0) {
      await Promise.all(
        entries.map(async e => {
          const full = path.join(dlDir, e);
          await fs.rm(full, { recursive: true, force: true });
        })
      );
      console.log(`🗑️ Cleaned ${dlDir}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Cleanup error:', err.message);
  }

  process.exit(exitCode);
}

/* ──────────────────────────────────────────────────────────────
   4. Ctrl-C
   ────────────────────────────────────────────────────────────── */
process.on('SIGINT', () => {
  console.log('\n⚠️ SIGINT received');
  shutdown(0);
});