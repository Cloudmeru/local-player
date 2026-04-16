/**
 * QA Test Suite for Local Player
 * Run with:  npx electron qa-test.js
 *
 * Tests the protocol handler, Range requests, URL encoding,
 * file listing, and video compatibility.
 */

const { app, protocol, net, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Import / mirror helpers from main.js ──
const MIME_TYPES = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.vtt': 'text/vtt',
};

// Pull-based stream conversion with proper backpressure
function nodeToWebStream(nodeStream) {
  const reader = nodeStream[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.next();
        if (done) { controller.close(); }
        else { controller.enqueue(new Uint8Array(value)); }
      } catch (err) { controller.error(err); }
    },
    cancel() { nodeStream.destroy(); }
  });
}

function readFileRange(filePath, start, end) {
  const size = end - start + 1;
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buffer, 0, size, start); }
  finally { fs.closeSync(fd); }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

const { pathToFileURL } = require('url');

function fileToVideoUrl(filePath) {
  return pathToFileURL(filePath).toString();
}

function fileToMediaUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return 'local-media://localhost/' + normalized.split('/').map(encodeURIComponent).join('/');
}

// ── Test framework ──
let passed = 0, failed = 0, skipped = 0;
const results = [];

function assert(condition, testName, detail = '') {
  if (condition) {
    passed++;
    results.push({ status: 'PASS', name: testName });
    console.log(`  ✅ PASS: ${testName}`);
  } else {
    failed++;
    results.push({ status: 'FAIL', name: testName, detail });
    console.log(`  ❌ FAIL: ${testName}${detail ? ' — ' + detail : ''}`);
  }
}

function skip(testName, reason) {
  skipped++;
  results.push({ status: 'SKIP', name: testName, detail: reason });
  console.log(`  ⏭  SKIP: ${testName} — ${reason}`);
}

// ── Register protocol ──
protocol.registerSchemesAsPrivileged([{
  scheme: 'local-media',
  privileges: { stream: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true }
}]);

// ── Test helpers ──
async function fetchMedia(url, headers = {}) {
  return net.fetch(url, { headers });
}

async function readResponseFully(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.length;
  }
  return { chunks, totalBytes };
}

// ── TESTS ──

async function testUrlEncoding() {
  console.log('\n── Test Group: URL Encoding ──');

  // Test simple path
  const simple = fileToMediaUrl('C:\\folder\\file.mp4');
  assert(simple.startsWith('local-media://localhost/'), 'Simple path starts with scheme');
  assert(simple.includes('file.mp4'), 'Simple path contains filename');

  // Test path with spaces
  const spaced = fileToMediaUrl('C:\\My Folder\\My File.mp4');
  assert(spaced.includes('My%20Folder'), 'Space encoded in folder name');
  assert(spaced.includes('My%20File.mp4'), 'Space encoded in file name');

  // Test path with special chars (apostrophe, parens)
  // Note: encodeURIComponent does NOT encode ' ( ) per RFC — but that's fine for URLs
  const special = fileToMediaUrl("C:\\downloads\\Idol Seung-ha's Study on Shameful Desires (2025).mp4");
  assert(special.includes("Seung-ha's") || special.includes('%27'), 'Apostrophe in URL (encoded or literal)');
  assert(special.includes('(2025)') || (special.includes('%28') && special.includes('%29')), 'Parentheses in URL (encoded or literal)');

  // Test roundtrip: encode → URL parse → decode
  const testPath = "C:\\downloads\\Idol Seung-ha's Study (2025).mp4";
  const encoded = fileToMediaUrl(testPath);
  const url = new URL(encoded);
  const decoded = decodeURIComponent(url.pathname).slice(1); // Remove leading /
  assert(decoded === testPath.replace(/\\/g, '/'), 'URL roundtrip preserves path', `got: ${decoded}`);
}

async function testProtocolHandler_BasicServe() {
  console.log('\n── Test Group: Protocol Handler - Basic Serve ──');

  const downloadsDir = path.join(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    skip('Basic serve', 'downloads folder not found');
    return;
  }

  // Find a small MP4 file to test with
  const files = fs.readdirSync(downloadsDir)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({ name: f, size: fs.statSync(path.join(downloadsDir, f)).size }))
    .sort((a, b) => a.size - b.size);

  if (files.length === 0) {
    skip('Basic serve', 'No MP4 files in downloads');
    return;
  }

  const testFile = files[0]; // smallest file
  const testPath = path.join(downloadsDir, testFile.name);
  const mediaUrl = fileToMediaUrl(testPath);

  console.log(`  Using test file: ${testFile.name} (${(testFile.size / 1048576).toFixed(1)} MB)`);

  // Test 1: Full file request (no Range)
  try {
    const resp = await fetchMedia(mediaUrl);
    assert(resp.status === 200, 'Full request returns 200');
    assert(resp.headers.get('content-type') === 'video/mp4', 'Content-Type is video/mp4');
    assert(resp.headers.get('accept-ranges') === 'bytes', 'Accept-Ranges header present');
    assert(parseInt(resp.headers.get('content-length')) === testFile.size, 'Content-Length matches file size',
      `expected ${testFile.size}, got ${resp.headers.get('content-length')}`);
    // Don't read the full body - just verify headers
    resp.body.cancel();
  } catch (err) {
    assert(false, 'Full request succeeds', err.message);
  }
}

async function testProtocolHandler_RangeRequests() {
  console.log('\n── Test Group: Protocol Handler - Range Requests ──');

  const downloadsDir = path.join(__dirname, '..', 'downloads');
  const files = fs.readdirSync(downloadsDir)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({ name: f, size: fs.statSync(path.join(downloadsDir, f)).size }))
    .sort((a, b) => a.size - b.size);

  if (files.length === 0) { skip('Range requests', 'No MP4 files'); return; }

  const testFile = files[0];
  const testPath = path.join(downloadsDir, testFile.name);
  const mediaUrl = fileToMediaUrl(testPath);

  // Test 1: Range from beginning (bytes=0-1023)
  try {
    const resp = await fetchMedia(mediaUrl, { Range: 'bytes=0-1023' });
    assert(resp.status === 206, 'Range 0-1023 returns 206');
    assert(resp.headers.get('content-range') === `bytes 0-1023/${testFile.size}`,
      'Content-Range header correct for 0-1023',
      `got: ${resp.headers.get('content-range')}`);
    assert(parseInt(resp.headers.get('content-length')) === 1024,
      'Content-Length is 1024 for 0-1023');
    const { totalBytes } = await readResponseFully(resp);
    assert(totalBytes === 1024, 'Received exactly 1024 bytes', `got ${totalBytes}`);
  } catch (err) {
    assert(false, 'Range 0-1023 request', err.message);
  }

  // Test 2: Range from middle
  const midStart = Math.floor(testFile.size / 2);
  const midEnd = midStart + 4095;
  try {
    const resp = await fetchMedia(mediaUrl, { Range: `bytes=${midStart}-${midEnd}` });
    assert(resp.status === 206, 'Mid-file Range returns 206');
    const { totalBytes } = await readResponseFully(resp);
    assert(totalBytes === 4096, `Mid-file Range returns 4096 bytes`, `got ${totalBytes}`);
  } catch (err) {
    assert(false, 'Mid-file Range request', err.message);
  }

  // Test 3: Range from near end (open-ended)
  const nearEnd = testFile.size - 1000;
  try {
    const resp = await fetchMedia(mediaUrl, { Range: `bytes=${nearEnd}-` });
    assert(resp.status === 206, 'Open-ended Range returns 206');
    const expectedLen = testFile.size - nearEnd;
    const { totalBytes } = await readResponseFully(resp);
    assert(totalBytes === expectedLen, `Open-ended Range returns ${expectedLen} bytes`, `got ${totalBytes}`);
  } catch (err) {
    assert(false, 'Open-ended Range request', err.message);
  }

  // Test 4: Range for last byte
  try {
    const lastByteStart = testFile.size - 1;
    const resp = await fetchMedia(mediaUrl, { Range: `bytes=${lastByteStart}-${lastByteStart}` });
    assert(resp.status === 206, 'Last byte Range returns 206');
    const { totalBytes } = await readResponseFully(resp);
    assert(totalBytes === 1, 'Last byte Range returns 1 byte', `got ${totalBytes}`);
  } catch (err) {
    assert(false, 'Last byte Range request', err.message);
  }

  // Test 5: Open-ended Range from 0 (bytes=0-)
  try {
    const resp = await fetchMedia(mediaUrl, { Range: 'bytes=0-' });
    assert(resp.status === 206, 'bytes=0- returns 206');
    assert(resp.headers.get('content-range') === `bytes 0-${testFile.size - 1}/${testFile.size}`,
      'Content-Range correct for bytes=0-',
      `got: ${resp.headers.get('content-range')}`);
    resp.body.cancel();
  } catch (err) {
    assert(false, 'bytes=0- request', err.message);
  }
}

async function testProtocolHandler_SpecialChars() {
  console.log('\n── Test Group: Protocol Handler - Special Characters ──');

  const downloadsDir = path.join(__dirname, '..', 'downloads');
  const specialFiles = fs.readdirSync(downloadsDir)
    .filter(f => f.endsWith('.mp4') && (/[' ()]/.test(f)));

  if (specialFiles.length === 0) {
    skip('Special chars', 'No files with special characters');
    return;
  }

  for (const fn of specialFiles) {
    const fp = path.join(downloadsDir, fn);
    const mediaUrl = fileToMediaUrl(fp);
    const fileSize = fs.statSync(fp).size;

    try {
      const resp = await fetchMedia(mediaUrl, { Range: 'bytes=0-7' });
      assert(resp.status === 206, `Serve file with special chars: ${fn.slice(0, 40)}...`);
      const { totalBytes } = await readResponseFully(resp);
      assert(totalBytes === 8, `Correct bytes for special-char file: ${fn.slice(0, 40)}...`, `got ${totalBytes}`);
    } catch (err) {
      assert(false, `Special-char file: ${fn.slice(0, 40)}...`, err.message);
    }
  }
}

async function testProtocolHandler_NotFound() {
  console.log('\n── Test Group: Protocol Handler - Error Cases ──');

  // Test non-existent file
  try {
    const resp = await fetchMedia('local-media://localhost/C%3A/nonexistent/file.mp4');
    assert(resp.status === 404, 'Non-existent file returns 404', `got ${resp.status}`);
  } catch (err) {
    assert(false, 'Non-existent file request', err.message);
  }
}

async function testProtocolHandler_MoovAtEnd() {
  console.log('\n── Test Group: Moov-at-End File Serving ──');

  const downloadsDir = path.join(__dirname, '..', 'downloads');
  // Test files known to have moov at end
  const moovEndFiles = [
    'MOSAIC-ARCHIVE-SNOS-047.mp4.mp4',
    'Idol Seung-ha\'s Study on Shameful Desires (2025).mp4'
  ].filter(f => fs.existsSync(path.join(downloadsDir, f)));

  if (moovEndFiles.length === 0) {
    skip('Moov-at-end', 'No moov-at-end files found');
    return;
  }

  for (const fn of moovEndFiles) {
    const fp = path.join(downloadsDir, fn);
    const fileSize = fs.statSync(fp).size;
    const mediaUrl = fileToMediaUrl(fp);

    // Browser MP4 parser will seek to the end to find moov
    // Simulate: request the last 8MB (where moov typically is)
    const seekOffset = Math.max(0, fileSize - 8 * 1024 * 1024);
    try {
      const resp = await fetchMedia(mediaUrl, { Range: `bytes=${seekOffset}-` });
      assert(resp.status === 206, `Moov-at-end Range seek works: ${fn.slice(0, 40)}...`);

      const contentRange = resp.headers.get('content-range');
      const expectedRange = `bytes ${seekOffset}-${fileSize - 1}/${fileSize}`;
      assert(contentRange === expectedRange,
        `Moov-at-end Content-Range correct: ${fn.slice(0, 40)}...`,
        `expected: ${expectedRange}, got: ${contentRange}`);

      const { totalBytes } = await readResponseFully(resp);
      const expectedBytes = fileSize - seekOffset;
      assert(totalBytes === expectedBytes,
        `Moov-at-end returned correct bytes: ${fn.slice(0, 40)}...`,
        `expected ${expectedBytes}, got ${totalBytes}`);
    } catch (err) {
      assert(false, `Moov-at-end seek: ${fn.slice(0, 40)}...`, err.message);
    }
  }
}

async function testVideoPlayback_BrowserWindow() {
  console.log('\n── Test Group: Browser Video Playback ──');

  const downloadsDir = path.join(__dirname, '..', 'downloads');
  const files = fs.readdirSync(downloadsDir)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({
      name: f,
      path: path.join(downloadsDir, f),
      size: fs.statSync(path.join(downloadsDir, f)).size
    }))
    .sort((a, b) => a.size - b.size);

  if (files.length === 0) { skip('Browser playback', 'No MP4 files'); return; }

  // Create a hidden BrowserWindow for testing playback
  // Use a real HTML file so file:// URLs work for the video element
  const testHtmlPath = path.join(__dirname, '_qa-playback-test.html');
  fs.writeFileSync(testHtmlPath, `<!DOCTYPE html><html><body>
    <video id="v" style="width:320px;height:240px" muted></video>
    <script>
      window.testVideo = function(url) {
        return new Promise(function(resolve) {
          var v = document.getElementById('v');
          v.removeAttribute('src');
          v.load();
          const timeout = setTimeout(() => resolve({ ok: false, error: 'timeout (10s)' }), 10000);
          v.addEventListener('loadedmetadata', () => {
            clearTimeout(timeout);
            resolve({
              ok: true,
              duration: v.duration,
              videoWidth: v.videoWidth,
              videoHeight: v.videoHeight
            });
          }, { once: true });
          v.addEventListener('error', () => {
            clearTimeout(timeout);
            const e = v.error;
            resolve({
              ok: false,
              error: 'MediaError code=' + (e ? e.code : '?') + ' ' + (e ? e.message : '')
            });
          }, { once: true });
          v.src = url;
        });
      };
    </script>
    </body></html>`);

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  await win.loadFile(testHtmlPath);

  // Test each file
  const testSet = files.slice(0, Math.min(files.length, 19));

  for (const f of testSet) {
    const videoUrl = fileToVideoUrl(f.path);
    try {
      const result = await win.webContents.executeJavaScript(`testVideo(${JSON.stringify(videoUrl)})`);
      if (result.ok) {
        assert(true, `Playback OK: ${f.name.slice(0, 50)} (${result.videoWidth}x${result.videoHeight}, ${Math.round(result.duration)}s)`);
      } else {
        assert(false, `Playback: ${f.name.slice(0, 50)}`, result.error);
      }
    } catch (err) {
      assert(false, `Playback: ${f.name.slice(0, 50)}`, err.message);
    }
  }

  win.close();
  try { fs.unlinkSync(testHtmlPath); } catch {}
}

async function testVideoSeeking_BrowserWindow() {
  console.log('\n── Test Group: Video Seeking ──');

  const downloadsDir = path.join(__dirname, '..', 'downloads');
  const files = fs.readdirSync(downloadsDir)
    .filter(f => f.endsWith('.mp4') && !['video.mp4', 'video2.mp4'].includes(f))
    .map(f => ({
      name: f,
      path: path.join(downloadsDir, f),
      size: fs.statSync(path.join(downloadsDir, f)).size
    }))
    .sort((a, b) => a.size - b.size);

  if (files.length === 0) { skip('Seeking', 'No MP4 files'); return; }

  const testFile = files[0];
  const videoUrl = fileToVideoUrl(testFile.path);

  const seekHtmlPath = path.join(__dirname, '_qa-seek-test.html');
  fs.writeFileSync(seekHtmlPath, `<!DOCTYPE html><html><body>
    <video id="v" style="width:320px;height:240px" muted></video>
    <script>
      window.testSeek = function(url) {
        return new Promise(function(resolve) {
          var v = document.getElementById('v');
          v.removeAttribute('src');
          v.load();
          var timeout = setTimeout(function() { resolve({ ok: false, error: 'load timeout' }); }, 15000);
          v.addEventListener('loadedmetadata', function() {
            clearTimeout(timeout);
            var dur = v.duration;
            if (!dur || dur <= 0) { resolve({ ok: false, error: 'no duration' }); return; }
            var targets = [dur * 0.25, dur * 0.5, dur * 0.75];
            var idx = 0;
            var results = [];
            function doSeek() {
              if (idx >= targets.length) { resolve({ ok: true, seeks: results, duration: dur }); return; }
              var target = targets[idx];
              var seekTimeout = setTimeout(function() {
                results.push({ target: target, actual: v.currentTime, ok: false, error: 'seek timeout' });
                idx++;
                doSeek();
              }, 5000);
              v.addEventListener('seeked', function() {
                clearTimeout(seekTimeout);
                var diff = Math.abs(v.currentTime - target);
                results.push({ target: target, actual: v.currentTime, diff: diff, ok: diff < 5 });
                idx++;
                doSeek();
              }, { once: true });
              v.addEventListener('error', function() {
                clearTimeout(seekTimeout);
                var e = v.error;
                results.push({ target: target, ok: false, error: 'seek error code=' + (e ? e.code : '?') });
                idx++;
                doSeek();
              }, { once: true });
              v.currentTime = target;
            }
            doSeek();
          }, { once: true });
          v.addEventListener('error', function() {
            clearTimeout(timeout);
            resolve({ ok: false, error: 'load error' });
          }, { once: true });
          v.src = url;
        });
      };
    </script>
  </body></html>`);

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  await win.loadFile(seekHtmlPath);

  try {
    const result = await win.webContents.executeJavaScript(`testSeek(${JSON.stringify(videoUrl)})`);
    if (result.ok) {
      for (const s of result.seeks) {
        assert(s.ok, `Seek to ${Math.round(s.target)}s → landed at ${Math.round(s.actual)}s (diff: ${s.diff ? s.diff.toFixed(1) : '?'}s)`,
          s.ok ? '' : (s.error || `diff too large: ${s.diff}`));
      }
    } else {
      assert(false, `Seeking test for ${testFile.name.slice(0, 40)}`, result.error);
    }
  } catch (err) {
    assert(false, `Seeking test for ${testFile.name.slice(0, 40)}`, err.message);
  }

  win.close();
  try { fs.unlinkSync(seekHtmlPath); } catch {}
}

async function testContainerIntegrity() {
  console.log('\n── Test Group: Container Integrity ──');

  const downloadsDir = path.join(__dirname, '..', 'downloads');
  const files = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.mp4'));
  const { execFile } = require('child_process');

  for (const fn of files) {
    const fp = path.join(downloadsDir, fn);
    try {
      const result = await new Promise((resolve, reject) => {
        execFile('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration,format_name',
          '-of', 'json',
          fp
        ], { timeout: 30000 }, (err, stdout, stderr) => {
          if (err) return resolve({ ok: false, error: stderr || err.message });
          try {
            const data = JSON.parse(stdout);
            resolve({
              ok: true,
              duration: parseFloat(data.format.duration),
              format: data.format.format_name
            });
          } catch (e) {
            resolve({ ok: false, error: 'parse error: ' + e.message });
          }
        });
      });

      if (result.ok && result.duration > 0) {
        assert(true, `Container OK: ${fn.slice(0, 50)} (${result.format}, ${Math.round(result.duration)}s)`);
      } else {
        assert(false, `Container: ${fn.slice(0, 50)}`, result.error || 'no duration');
      }
    } catch (err) {
      assert(false, `Container: ${fn.slice(0, 50)}`, err.message);
    }
  }
}

async function testEdgeCases() {
  console.log('\n── Test Group: Edge Cases ──');

  // Test Range with start beyond file size
  const downloadsDir = path.join(__dirname, '..', 'downloads');
  const files = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.mp4'));
  if (files.length === 0) { skip('Edge cases', 'No files'); return; }

  const fp = path.join(downloadsDir, files[0]);
  const fileSize = fs.statSync(fp).size;
  const mediaUrl = fileToMediaUrl(fp);

  // Range beyond file size
  try {
    const resp = await fetchMedia(mediaUrl, { Range: `bytes=${fileSize + 1000}-` });
    assert(resp.status === 416, 'Range beyond file size returns 416', `got ${resp.status}`);
    try { resp.body.cancel(); } catch {}
  } catch (err) {
    assert(false, 'Range beyond file size does not crash', err.message);
  }

  // Large Range header value
  try {
    const resp = await fetchMedia(mediaUrl, { Range: 'bytes=0-99999999999999' });
    assert(resp.status === 206, 'Oversized end Range clamped correctly');
    const contentRange = resp.headers.get('content-range');
    assert(contentRange && contentRange.includes(`${fileSize - 1}/${fileSize}`),
      'Oversized Range clamped to file size',
      `got: ${contentRange}`);
    try { resp.body.cancel(); } catch {}
  } catch (err) {
    assert(false, 'Oversized end Range', err.message);
  }
}

// ── Main ──
app.whenReady().then(async () => {
  // Register the same protocol handler as main.js
  protocol.handle('local-media', (request) => {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }

    let stat;
    try { stat = fs.statSync(filePath); }
    catch { return new Response('Not Found', { status: 404 }); }

    const fileSize = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const rangeHeader = request.headers.get('range');

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        if (start >= fileSize) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` }
          });
        }
        const end = match[2] ? Math.min(parseInt(match[2]), fileSize - 1) : fileSize - 1;
        const chunkSize = end - start + 1;

        const MAX_SYNC_READ = 8 * 1024 * 1024;
        let body;
        if (chunkSize <= MAX_SYNC_READ) {
          body = readFileRange(filePath, start, end);
        } else {
          body = nodeToWebStream(fs.createReadStream(filePath, { start, end }));
        }

        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': String(chunkSize),
            'Accept-Ranges': 'bytes',
          }
        });
      }
    }

    const stream = nodeToWebStream(fs.createReadStream(filePath));
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
      }
    });
  });

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       Local Player — QA Test Suite               ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Downloads dir: ${path.join(__dirname, '..', 'downloads')}`);

  try {
    await testUrlEncoding();
    await testProtocolHandler_BasicServe();
    await testProtocolHandler_RangeRequests();
    await testProtocolHandler_SpecialChars();
    await testProtocolHandler_NotFound();
    await testProtocolHandler_MoovAtEnd();
    await testEdgeCases();
    await testContainerIntegrity();
    await testVideoPlayback_BrowserWindow();
    await testVideoSeeking_BrowserWindow();
  } catch (err) {
    console.error('\n💥 Test suite crashed:', err);
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  Results:  ✅ ${String(passed).padEnd(3)} passed   ❌ ${String(failed).padEnd(3)} failed   ⏭  ${String(skipped).padEnd(3)} skipped  ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ❌ ${r.name}: ${r.detail}`);
    });
  }

  console.log('');
  app.quit();
});

app.on('window-all-closed', () => {});
