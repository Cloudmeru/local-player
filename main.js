const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');

// Resolve bundled ffmpeg-static binary, with fallback to system PATH
function resolveFfmpegPath() {
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch (_) {}
  return 'ffmpeg';
}
const FFMPEG_BIN = resolveFfmpegPath();

const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.webm', '.ts', '.mov', '.m4v', '.flv', '.wmv', '.m3u8'];

const MIME_TYPES = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.vtt': 'text/vtt',
};

// Pull-based stream conversion with proper backpressure & Uint8Array chunks
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

// Synchronous read for Range requests (more reliable than streaming for bounded chunks)
function readFileRange(filePath, start, end) {
  const size = end - start + 1;
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buffer, 0, size, start); }
  finally { fs.closeSync(fd); }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

let mainWindow;
let settingsPath;
const metadataCache = new Map();
let letterboxdTokenCache = null;

function sendToWebContents(webContents, channel, payload) {
  if (!webContents || webContents.isDestroyed()) return;
  try {
    webContents.send(channel, payload);
  } catch (error) {
    if (!String(error?.message || '').includes('Object has been destroyed')) {
      throw error;
    }
  }
}

function sanitizeStringArray(values, limit = 24) {
  const output = [];
  const seen = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(normalized);
  };
  visit(values);
  return output.slice(0, limit);
}

function sanitizeStringMap(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [String(key), String(entryValue || '').trim()])
      .filter(([, entryValue]) => entryValue)
  );
}

function sanitizeLinkEntry(link) {
  if (!link || typeof link !== 'object') return null;
  const label = String(link.label || link.type || '').trim();
  const url = String(link.url || '').trim();
  if (!label || !url) return null;
  return { label, url };
}

function sanitizeLinkEntries(links, limit = 10) {
  if (!Array.isArray(links)) return [];
  const output = [];
  const seen = new Set();
  for (const link of links) {
    const sanitized = sanitizeLinkEntry(link);
    if (!sanitized) continue;
    if (seen.has(sanitized.url)) continue;
    seen.add(sanitized.url);
    output.push(sanitized);
    if (output.length >= limit) break;
  }
  return output;
}

function sanitizeCastMember(member) {
  if (!member || typeof member !== 'object') return null;
  const name = String(member.name || '').trim();
  if (!name) return null;
  return {
    source: String(member.source || '').trim(),
    sources: sanitizeStringArray(member.sources || member.source, 6),
    name,
    role: String(member.role || '').trim(),
    bio: String(member.bio || '').trim(),
    photoUrl: String(member.photoUrl || '').trim() || null,
    externalUrl: String(member.externalUrl || '').trim() || null,
    sourceIds: sanitizeStringMap(member.sourceIds),
    links: sanitizeLinkEntries(member.links),
    knownFor: sanitizeStringArray(member.knownFor, 8),
    facts: sanitizeStringArray(member.facts, 10),
  };
}

function sanitizeMetadataCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const normalizedSources = Array.isArray(candidate.sources) && candidate.sources.length
    ? candidate.sources.filter(Boolean).map(String)
    : candidate.source
      ? [String(candidate.source)]
      : [];

  return {
    source: candidate.source ? String(candidate.source) : normalizedSources[0] || '',
    sourceId: candidate.sourceId ?? null,
    title: candidate.title ? String(candidate.title) : '',
    year: Number.isFinite(candidate.year) ? candidate.year : null,
    type: candidate.type === 'series' ? 'series' : 'movie',
    overview: candidate.overview ? String(candidate.overview) : '',
    posterUrl: candidate.posterUrl ? String(candidate.posterUrl) : null,
    rating: Number.isFinite(candidate.rating) ? candidate.rating : null,
    runtime: candidate.runtime ? String(candidate.runtime) : null,
    genre: candidate.genre ? String(candidate.genre) : '',
    externalUrl: candidate.externalUrl ? String(candidate.externalUrl) : null,
    score: Number.isFinite(candidate.score) ? candidate.score : null,
    sources: normalizedSources,
    providerIds: sanitizeStringMap(candidate.providerIds),
    sourceLinks: sanitizeStringMap(candidate.sourceLinks),
    tags: sanitizeStringArray(candidate.tags),
    categories: sanitizeStringArray(candidate.categories),
    usefulInfo: sanitizeStringArray(candidate.usefulInfo, 20),
    cast: Array.isArray(candidate.cast) ? candidate.cast.map(sanitizeCastMember).filter(Boolean).slice(0, 20) : [],
    tagline: candidate.tagline ? String(candidate.tagline) : '',
    backdropUrl: candidate.backdropUrl ? String(candidate.backdropUrl) : null,
    releaseDate: candidate.releaseDate ? String(candidate.releaseDate) : '',
    contentRating: candidate.contentRating ? String(candidate.contentRating) : '',
    language: candidate.language ? String(candidate.language) : '',
    country: candidate.country ? String(candidate.country) : '',
    studio: candidate.studio ? String(candidate.studio) : '',
    awards: candidate.awards ? String(candidate.awards) : '',
    seasonCount: Number.isFinite(candidate.seasonCount) ? candidate.seasonCount : null,
    episodeCount: Number.isFinite(candidate.episodeCount) ? candidate.episodeCount : null,
  };
}

function firstNonEmpty(...values) {
  for (const value of values.flat()) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstFinite(...values) {
  for (const value of values.flat()) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function pickLongestText(...values) {
  return values
    .flat()
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0] || '';
}

function mergeStringMaps(...maps) {
  return Object.assign({}, ...maps.map((entry) => sanitizeStringMap(entry)));
}

function mergeCastMembers(...castLists) {
  const merged = new Map();
  for (const entry of castLists.flat()) {
    const member = sanitizeCastMember(entry);
    if (!member) continue;
    const key = normalizeTitle(member.name);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, member);
      continue;
    }
    existing.sources = sanitizeStringArray([...existing.sources, ...member.sources], 8);
    existing.role = existing.role || member.role;
    existing.bio = pickLongestText(existing.bio, member.bio);
    existing.photoUrl = existing.photoUrl || member.photoUrl;
    existing.externalUrl = existing.externalUrl || member.externalUrl;
    existing.sourceIds = mergeStringMaps(existing.sourceIds, member.sourceIds);
    existing.links = sanitizeLinkEntries([...existing.links, ...member.links], 10);
    existing.knownFor = sanitizeStringArray([...existing.knownFor, ...member.knownFor], 8);
    existing.facts = sanitizeStringArray([...existing.facts, ...member.facts], 10);
  }
  return Array.from(merged.values());
}

function getMetadataSelections() {
  const settings = loadSettings();
  const selections = settings.metadataSelections;
  return selections && typeof selections === 'object' ? selections : {};
}

function getSelectedMetadata(videoPath) {
  if (!videoPath) return null;
  return sanitizeMetadataCandidate(getMetadataSelections()[videoPath]);
}

function setSelectedMetadata(videoPath, candidate) {
  if (!videoPath) return null;
  const selections = getMetadataSelections();
  const sanitizedCandidate = sanitizeMetadataCandidate(candidate);
  if (!sanitizedCandidate || !sanitizedCandidate.title) return null;
  selections[videoPath] = sanitizedCandidate;
  saveSettings({ metadataSelections: selections });
  metadataCache.delete(`${videoPath}|${path.basename(videoPath)}`);
  return sanitizedCandidate;
}

function clearSelectedMetadata(videoPath) {
  if (!videoPath) return;
  const selections = getMetadataSelections();
  if (!(videoPath in selections)) return;
  delete selections[videoPath];
  saveSettings({ metadataSelections: selections });
  metadataCache.delete(`${videoPath}|${path.basename(videoPath)}`);
}

// ── Must register BEFORE app ready ──
protocol.registerSchemesAsPrivileged([{
  scheme: 'local-media',
  privileges: { stream: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true }
}]);

function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#111936',
    title: 'Local Player',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  window.loadFile('index.html');
}

app.whenReady().then(() => {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');

  // Serve local files via local-media:// protocol (with Range support for seeking)
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

        // Use synchronous buffer read for bounded ranges (≤ 8 MB) — more reliable
        // Use streaming for large/open-ended ranges
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

    // Full file: stream with proper backpressure
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

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Settings persistence ──
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return {}; }
}

function saveSettings(data) {
  const current = loadSettings();
  Object.assign(current, data);
  fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2));
}

// ── Helpers ──
function fileToMediaUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return 'local-media://localhost/' + normalized.split('/').map(encodeURIComponent).join('/');
}

function fmtVttTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

function getDuration(videoPath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(0);
      const dur = parseFloat(stdout.trim());
      resolve(isNaN(dur) ? 0 : dur);
    });
  });
}

function thumbDir(videoPath) {
  const ext = path.extname(videoPath);
  const baseName = path.basename(videoPath, ext);
  return path.join(path.dirname(videoPath), 'thumbnails', baseName);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeTitle(value).split(/\s+/).filter(Boolean);
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseFilenameMetadata(filename) {
  const stem = path.basename(filename, path.extname(filename));
  const yearMatch = stem.match(/(?:19|20)\d{2}/);
  const episodicMatch = stem.match(/s(\d{1,2})[ ._-]*e(\d{1,2})|(\d{1,2})x(\d{1,2})/i);
  const junkTokens = [
    '2160p', '1440p', '1080p', '720p', '576p', '480p', '360p',
    'bluray', 'brrip', 'bdrip', 'dvdrip', 'hdrip', 'hdtv', 'webrip', 'webdl', 'web-dl',
    'remux', 'proper', 'repack', 'extended', 'uncut', 'rerip', 'limited', 'internal',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'av1', 'xvid',
    'aac', 'ac3', 'dts', 'ddp', 'ddp5 1', '5 1', '7 1', 'atmos', 'dual audio',
    'multi', 'subbed', 'dubbed', 'nf', 'amzn', 'dsnp', 'imax', 'hdr', '10bit', '8bit'
  ];

  let query = stem.replace(/[._]+/g, ' ');
  if (yearMatch) query = query.replace(new RegExp(`\\b${yearMatch[0]}\\b`, 'g'), ' ');
  if (episodicMatch) query = query.replace(episodicMatch[0], ' ');
  for (const token of junkTokens) {
    query = query.replace(new RegExp(`\\b${escapeRegex(token)}\\b`, 'ig'), ' ');
  }
  query = query.replace(/\s+/g, ' ').trim();

  return {
    stem,
    query: query || stem.replace(/[._]+/g, ' ').trim(),
    year: yearMatch ? Number(yearMatch[0]) : null,
    isSeries: Boolean(episodicMatch),
    season: episodicMatch ? Number(episodicMatch[1] || episodicMatch[3]) : null,
    episode: episodicMatch ? Number(episodicMatch[2] || episodicMatch[4]) : null,
  };
}

function titleSimilarityScore(query, candidateTitle) {
  const queryNorm = normalizeTitle(query);
  const candidateNorm = normalizeTitle(candidateTitle);
  if (!queryNorm || !candidateNorm) return 0;
  if (queryNorm === candidateNorm) return 55;
  if (candidateNorm.startsWith(queryNorm) || queryNorm.startsWith(candidateNorm)) return 40;

  const queryTokens = new Set(tokenize(query));
  const candidateTokens = new Set(tokenize(candidateTitle));
  if (!queryTokens.size || !candidateTokens.size) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }

  return Math.round((overlap / Math.max(queryTokens.size, candidateTokens.size)) * 35);
}

function scoreCandidate(candidate, parsed) {
  let score = titleSimilarityScore(parsed.query, candidate.title);
  if (parsed.year && candidate.year) {
    if (parsed.year === candidate.year) score += 18;
    else if (Math.abs(parsed.year - candidate.year) === 1) score += 8;
  }

  if (parsed.isSeries) {
    score += candidate.type === 'series' ? 18 : -6;
  } else if (candidate.type === 'movie') {
    score += 10;
  }

  if (candidate.source === 'TMDb') score += 12;
  if (candidate.source === 'Letterboxd') score += 11;
  if (candidate.source === 'OMDb') score += 10;
  if (candidate.source === 'TVMaze') score += 8;
  if (candidate.rating && Number.isFinite(candidate.rating)) score += Math.min(10, Math.round(candidate.rating));

  return score;
}

function mergeCandidates(candidates, parsed) {
  const merged = new Map();
  for (const candidate of candidates) {
    candidate.score = scoreCandidate(candidate, parsed);
    const key = `${normalizeTitle(candidate.title)}|${candidate.year || 'na'}|${candidate.type}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...candidate,
        sources: [candidate.source],
        providerIds: candidate.sourceId ? { [candidate.source]: String(candidate.sourceId) } : {},
        sourceLinks: candidate.externalUrl ? { [candidate.source]: candidate.externalUrl } : {},
      });
      continue;
    }

    existing.sources = Array.from(new Set([...existing.sources, candidate.source]));
    existing.score = Math.max(existing.score, candidate.score) + 8;
    existing.overview = existing.overview || candidate.overview;
    existing.posterUrl = existing.posterUrl || candidate.posterUrl;
    existing.rating = existing.rating || candidate.rating;
    existing.runtime = existing.runtime || candidate.runtime;
    existing.genre = existing.genre || candidate.genre;
    existing.externalUrl = existing.externalUrl || candidate.externalUrl;
    existing.providerIds = mergeStringMaps(existing.providerIds, candidate.sourceId ? { [candidate.source]: String(candidate.sourceId) } : null);
    existing.sourceLinks = mergeStringMaps(existing.sourceLinks, candidate.externalUrl ? { [candidate.source]: candidate.externalUrl } : null);
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, 8);
}

async function fetchJson(url, options = {}) {
  const response = await net.fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchOptionalJson(url, options = {}) {
  try {
    return await fetchJson(url, options);
  } catch {
    return null;
  }
}

function getMetadataProviderConfig() {
  const settings = loadSettings();
  return {
    tmdbApiKey: process.env.TMDB_API_KEY || settings.tmdbApiKey || '',
    omdbApiKey: process.env.OMDB_API_KEY || settings.omdbApiKey || '',
    letterboxdClientId: process.env.LETTERBOXD_CLIENT_ID || settings.letterboxdClientId || '',
    letterboxdClientSecret: process.env.LETTERBOXD_CLIENT_SECRET || settings.letterboxdClientSecret || '',
  };
}

function getMetadataSourceStatus() {
  const config = getMetadataProviderConfig();
  return [
    { name: 'TVMaze', available: true, reason: 'public api' },
    { name: 'TMDb', available: Boolean(config.tmdbApiKey), reason: config.tmdbApiKey ? 'configured' : 'missing TMDB_API_KEY or settings.tmdbApiKey' },
    { name: 'OMDb', available: Boolean(config.omdbApiKey), reason: config.omdbApiKey ? 'configured' : 'missing OMDB_API_KEY or settings.omdbApiKey' },
    {
      name: 'Letterboxd',
      available: true,
      reason: config.letterboxdClientId && config.letterboxdClientSecret
        ? 'anonymous search with authenticated detail fallback configured'
        : 'anonymous search enabled'
    },
  ];
}

function pickLetterboxdImageUrl(image) {
  const sizes = Array.isArray(image?.sizes) ? image.sizes : [];
  if (!sizes.length) return null;
  const sorted = [...sizes].sort((left, right) => (left.width || 0) - (right.width || 0));
  return (sorted.find((size) => (size.width || 0) >= 342) || sorted[sorted.length - 1] || {}).url || null;
}

function getLetterboxdLink(entity) {
  const links = Array.isArray(entity?.links) ? entity.links : [];
  return links.find((link) => link.type === 'letterboxd' || link.type === 'boxd')?.url || null;
}

async function getLetterboxdAccessToken(clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;
  if (letterboxdTokenCache && letterboxdTokenCache.expiresAt > Date.now() + 30000) {
    return letterboxdTokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await net.fetch('https://api.letterboxd.com/api/v0/auth/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Letterboxd auth failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.access_token) {
    throw new Error('Letterboxd auth returned no access token');
  }

  letterboxdTokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(0, Number(payload.expires_in || 0) * 1000),
  };
  return letterboxdTokenCache.accessToken;
}

function getTmdbRequestConfig(tmdbApiKey) {
  const headers = { accept: 'application/json' };
  const queryParams = new URLSearchParams();
  if (/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\./.test(tmdbApiKey)) {
    headers.Authorization = `Bearer ${tmdbApiKey}`;
  } else {
    queryParams.set('api_key', tmdbApiKey);
  }
  return { headers, queryParams };
}

async function fetchTmdbJson(pathName, tmdbApiKey, params = {}) {
  if (!tmdbApiKey) return null;
  const url = new URL(`https://api.themoviedb.org/3${pathName}`);
  const requestConfig = getTmdbRequestConfig(tmdbApiKey);
  requestConfig.queryParams.forEach((value, key) => url.searchParams.set(key, value));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return fetchOptionalJson(url.toString(), { headers: requestConfig.headers });
}

async function fetchLetterboxdJson(pathName, options = {}) {
  const { clientId = '', clientSecret = '', params = {}, allowAuthFallback = true } = options;
  const url = new URL(`https://api.letterboxd.com/api/v0/${String(pathName || '').replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const anonymousResponse = await net.fetch(url.toString(), {
    headers: { accept: 'application/json' },
  });
  if (anonymousResponse.ok) {
    return anonymousResponse.json();
  }

  if (!allowAuthFallback || !clientId || !clientSecret || ![401, 403].includes(anonymousResponse.status)) {
    throw new Error(`Letterboxd request failed with HTTP ${anonymousResponse.status}`);
  }

  const accessToken = await getLetterboxdAccessToken(clientId, clientSecret);
  if (!accessToken) {
    throw new Error('Letterboxd auth unavailable');
  }

  const authenticatedResponse = await net.fetch(url.toString(), {
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!authenticatedResponse.ok) {
    throw new Error(`Letterboxd request failed with HTTP ${authenticatedResponse.status}`);
  }
  return authenticatedResponse.json();
}

function buildCastMember(name, options = {}) {
  const links = [];
  if (options.externalUrl) {
    links.push({ label: options.source || 'Reference', url: options.externalUrl });
  }
  if (Array.isArray(options.links)) {
    links.push(...options.links);
  }
  return sanitizeCastMember({
    source: options.source || '',
    sources: options.sources || options.source,
    name,
    role: options.role || '',
    bio: options.bio || '',
    photoUrl: options.photoUrl || null,
    externalUrl: options.externalUrl || null,
    sourceIds: options.sourceIds || {},
    links,
    knownFor: options.knownFor || [],
    facts: options.facts || [],
  });
}

function parseOmdbResponse(response) {
  return response && response.Response !== 'False' ? response : null;
}

async function fetchTmdbTitleDetails(candidate, tmdbApiKey) {
  const providerId = candidate?.providerIds?.TMDb || (candidate?.source === 'TMDb' ? candidate.sourceId : null);
  if (!providerId || !tmdbApiKey) return null;
  const mediaType = candidate.type === 'series' ? 'tv' : 'movie';
  const detail = await fetchTmdbJson(`/${mediaType}/${providerId}`, tmdbApiKey, {
    append_to_response: 'credits,external_ids',
    language: 'en-US',
  });
  if (!detail) return null;

  const genres = sanitizeStringArray((detail.genres || []).map((genre) => genre?.name));
  const countries = sanitizeStringArray((detail.production_countries || []).map((country) => country?.name));
  const languages = sanitizeStringArray((detail.spoken_languages || []).map((language) => language?.english_name || language?.name));
  const studios = sanitizeStringArray((detail.production_companies || []).map((company) => company?.name), 6);
  const runtimeValue = candidate.type === 'series'
    ? firstFinite(detail.episode_run_time?.[0])
    : firstFinite(detail.runtime);
  const cast = Array.isArray(detail.credits?.cast)
    ? detail.credits.cast.slice(0, 12).map((member) => buildCastMember(member?.name, {
        source: 'TMDb',
        role: member?.character || member?.known_for_department || 'Cast',
        photoUrl: member?.profile_path ? `https://image.tmdb.org/t/p/w342${member.profile_path}` : null,
        externalUrl: member?.id ? `https://www.themoviedb.org/person/${member.id}` : null,
        sourceIds: member?.id ? { TMDb: String(member.id) } : {},
      }))
    : [];

  return {
    source: 'TMDb',
    title: detail.title || detail.name || candidate.title,
    year: detail.release_date || detail.first_air_date ? Number(String(detail.release_date || detail.first_air_date).slice(0, 4)) : null,
    type: candidate.type,
    overview: detail.overview || '',
    posterUrl: detail.poster_path ? `https://image.tmdb.org/t/p/w500${detail.poster_path}` : null,
    backdropUrl: detail.backdrop_path ? `https://image.tmdb.org/t/p/w780${detail.backdrop_path}` : null,
    rating: Number.isFinite(detail.vote_average) ? detail.vote_average : null,
    runtime: runtimeValue ? `${runtimeValue} min` : null,
    categories: genres,
    tags: [...genres, mediaType === 'movie' ? 'Movie' : 'Series'],
    usefulInfo: sanitizeStringArray([
      countries.length ? `Country: ${countries.join(', ')}` : null,
      languages.length ? `Language: ${languages.join(', ')}` : null,
      studios.length ? `Studio: ${studios.join(', ')}` : null,
      detail.status && detail.status.toLowerCase() !== 'released' ? `Status: ${detail.status}` : null,
      Number.isFinite(detail.number_of_seasons) ? `Seasons: ${detail.number_of_seasons}` : null,
      Number.isFinite(detail.number_of_episodes) ? `Episodes: ${detail.number_of_episodes}` : null,
    ], 12),
    cast,
    tagline: detail.tagline || '',
    releaseDate: detail.release_date || detail.first_air_date || '',
    language: languages.join(', '),
    country: countries.join(', '),
    studio: studios.join(', '),
    seasonCount: Number.isFinite(detail.number_of_seasons) ? detail.number_of_seasons : null,
    episodeCount: Number.isFinite(detail.number_of_episodes) ? detail.number_of_episodes : null,
    sourceLinks: { TMDb: `https://www.themoviedb.org/${mediaType}/${providerId}` },
    providerIds: { TMDb: String(providerId) },
  };
}

async function fetchOmdbTitleDetails(candidate, parsed, omdbApiKey) {
  if (!omdbApiKey) return null;
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', omdbApiKey);

  const providerId = candidate?.providerIds?.OMDb || (candidate?.source === 'OMDb' ? candidate.sourceId : null);
  if (providerId) {
    url.searchParams.set('i', String(providerId));
  } else {
    url.searchParams.set('t', candidate.title || parsed.query);
    if (candidate.year || parsed.year) url.searchParams.set('y', String(candidate.year || parsed.year));
  }
  url.searchParams.set('plot', 'short');

  const detail = parseOmdbResponse(await fetchOptionalJson(url.toString()));
  if (!detail) return null;

  const genres = sanitizeStringArray(String(detail.Genre || '').split(','));
  const languages = sanitizeStringArray(String(detail.Language || '').split(','));
  const countries = sanitizeStringArray(String(detail.Country || '').split(','));
  const cast = sanitizeStringArray(String(detail.Actors || '').split(','), 12).map((name) => buildCastMember(name, {
    source: 'OMDb',
    role: 'Cast',
  }));

  return {
    source: 'OMDb',
    title: detail.Title || candidate.title,
    year: detail.Year ? Number(String(detail.Year).slice(0, 4)) : null,
    type: detail.Type === 'series' ? 'series' : 'movie',
    overview: detail.Plot && detail.Plot !== 'N/A' ? detail.Plot : '',
    posterUrl: detail.Poster && detail.Poster !== 'N/A' ? detail.Poster : null,
    rating: detail.imdbRating && detail.imdbRating !== 'N/A' ? Number(detail.imdbRating) : null,
    runtime: detail.Runtime && detail.Runtime !== 'N/A' ? detail.Runtime : null,
    categories: genres,
    tags: [...genres, detail.Rated && detail.Rated !== 'N/A' ? detail.Rated : null],
    usefulInfo: sanitizeStringArray([
      detail.Director && detail.Director !== 'N/A' ? `Director: ${detail.Director}` : null,
      detail.Writer && detail.Writer !== 'N/A' ? `Writer: ${detail.Writer}` : null,
      detail.Awards && detail.Awards !== 'N/A' ? `Awards: ${detail.Awards}` : null,
      detail.BoxOffice && detail.BoxOffice !== 'N/A' ? `Box Office: ${detail.BoxOffice}` : null,
      detail.imdbVotes && detail.imdbVotes !== 'N/A' ? `IMDb votes: ${detail.imdbVotes}` : null,
      detail.totalSeasons && detail.totalSeasons !== 'N/A' ? `Seasons: ${detail.totalSeasons}` : null,
    ], 12),
    cast,
    releaseDate: detail.Released && detail.Released !== 'N/A' ? detail.Released : '',
    contentRating: detail.Rated && detail.Rated !== 'N/A' ? detail.Rated : '',
    language: languages.join(', '),
    country: countries.join(', '),
    awards: detail.Awards && detail.Awards !== 'N/A' ? detail.Awards : '',
    seasonCount: detail.totalSeasons && detail.totalSeasons !== 'N/A' ? Number(detail.totalSeasons) : null,
    sourceLinks: detail.imdbID ? { OMDb: `https://www.imdb.com/title/${detail.imdbID}/` } : {},
    providerIds: detail.imdbID ? { OMDb: detail.imdbID } : {},
  };
}

async function fetchTvMazeTitleDetails(candidate) {
  const providerId = candidate?.providerIds?.TVMaze || (candidate?.source === 'TVMaze' ? candidate.sourceId : null);
  if (!providerId) return null;
  const detail = await fetchOptionalJson(`https://api.tvmaze.com/shows/${encodeURIComponent(providerId)}?embed=cast`);
  if (!detail) return null;

  const genres = sanitizeStringArray(detail.genres || []);
  const language = String(detail.language || '').trim();
  const country = detail.network?.country?.name || detail.webChannel?.country?.name || '';
  const cast = Array.isArray(detail._embedded?.cast)
    ? detail._embedded.cast.slice(0, 12).map((entry) => buildCastMember(entry?.person?.name, {
        source: 'TVMaze',
        role: entry?.character?.name || 'Cast',
        photoUrl: entry?.person?.image?.original || entry?.person?.image?.medium || null,
        externalUrl: entry?.person?.url || null,
        sourceIds: entry?.person?.id ? { TVMaze: String(entry.person.id) } : {},
        facts: sanitizeStringArray([
          entry?.person?.gender,
          entry?.person?.birthday ? `Born: ${entry.person.birthday}` : null,
          entry?.person?.country?.name,
        ], 6),
      }))
    : [];

  return {
    source: 'TVMaze',
    title: detail.name || candidate.title,
    year: detail.premiered ? Number(String(detail.premiered).slice(0, 4)) : null,
    type: 'series',
    overview: stripHtml(detail.summary),
    posterUrl: detail.image?.original || detail.image?.medium || null,
    rating: Number.isFinite(detail.rating?.average) ? detail.rating.average : null,
    runtime: detail.runtime ? `${detail.runtime} min` : null,
    categories: genres,
    tags: [...genres, detail.type || 'Series'],
    usefulInfo: sanitizeStringArray([
      detail.status && detail.status.toLowerCase() !== 'running' && detail.status.toLowerCase() !== 'released' ? `Status: ${detail.status}` : null,
      detail.network?.name ? `Network: ${detail.network.name}` : null,
      detail.webChannel?.name ? `Web channel: ${detail.webChannel.name}` : null,
      detail.officialSite ? `Official site available` : null,
    ], 10),
    cast,
    releaseDate: detail.premiered || '',
    language,
    country,
    sourceLinks: detail.url ? { TVMaze: detail.url } : {},
    providerIds: { TVMaze: String(providerId) },
  };
}

async function fetchLetterboxdTitleDetails(candidate, clientId, clientSecret) {
  const providerId = candidate?.providerIds?.Letterboxd || (candidate?.source === 'Letterboxd' ? candidate.sourceId : null);
  if (!providerId || candidate.type === 'series') return null;
  const film = await fetchOptionalJsonPromise(() => fetchLetterboxdJson(`film/${encodeURIComponent(providerId)}`, {
    clientId,
    clientSecret,
  }));
  if (!film) return null;

  const genres = sanitizeStringArray((film.genres || []).map((genre) => genre?.name));
  const actorContribution = Array.isArray(film.contributions)
    ? film.contributions.find((group) => group?.type === 'Actor')
    : null;
  const cast = Array.isArray(actorContribution?.contributors)
    ? actorContribution.contributors.slice(0, 12).map((contributor) => buildCastMember(contributor?.name, {
        source: 'Letterboxd',
        role: contributor?.characterName || 'Actor',
        photoUrl: pickLetterboxdImageUrl(contributor?.customPoster || contributor?.poster),
        externalUrl: contributor?.id ? `https://letterboxd.com/actor/${encodeURIComponent(normalizeTitle(contributor.name).replace(/\s+/g, '-'))}/` : null,
        sourceIds: mergeStringMaps(
          contributor?.id ? { Letterboxd: String(contributor.id) } : null,
          contributor?.tmdbid ? { TMDb: String(contributor.tmdbid) } : null
        ),
      }))
    : [];

  return {
    source: 'Letterboxd',
    title: film.name || candidate.title,
    year: Number.isFinite(film.releaseYear) ? film.releaseYear : null,
    type: 'movie',
    overview: film.description || film.tagline || '',
    posterUrl: pickLetterboxdImageUrl(film.poster),
    backdropUrl: pickLetterboxdImageUrl(film.backdrop),
    rating: Number.isFinite(film.rating) ? film.rating * 2 : null,
    runtime: Number.isFinite(film.runTime) ? `${film.runTime} min` : null,
    categories: genres,
    tags: [...genres, film.top250Position ? 'Top 250' : null],
    usefulInfo: sanitizeStringArray([
      film.top250Position ? `Top 250 position: ${film.top250Position}` : null,
      film.trailer?.url ? 'Trailer available' : null,
      film.filmCollectionId ? 'Part of a collection' : null,
    ], 8),
    cast,
    tagline: film.tagline || '',
    sourceLinks: getLetterboxdLink(film) ? { Letterboxd: getLetterboxdLink(film) } : {},
    providerIds: { Letterboxd: String(providerId) },
  };
}

async function fetchOptionalJsonPromise(factory) {
  try {
    return await factory();
  } catch {
    return null;
  }
}

async function compileMetadataCandidate(candidate, parsed, providerConfig) {
  const baseCandidate = sanitizeMetadataCandidate(candidate);
  if (!baseCandidate) return null;

  const [tmdbDetail, omdbDetail, tvMazeDetail, letterboxdDetail] = await Promise.all([
    fetchTmdbTitleDetails(baseCandidate, providerConfig.tmdbApiKey),
    fetchOmdbTitleDetails(baseCandidate, parsed, providerConfig.omdbApiKey),
    fetchTvMazeTitleDetails(baseCandidate),
    fetchLetterboxdTitleDetails(baseCandidate, providerConfig.letterboxdClientId, providerConfig.letterboxdClientSecret),
  ]);

  const details = [tmdbDetail, omdbDetail, tvMazeDetail, letterboxdDetail].filter(Boolean);
  const categories = sanitizeStringArray([
    baseCandidate.categories,
    baseCandidate.genre ? String(baseCandidate.genre).split(',') : [],
    ...details.map((detail) => detail.categories || []),
  ], 16);
  const usefulInfo = sanitizeStringArray([
    baseCandidate.usefulInfo,
    ...details.map((detail) => detail.usefulInfo || []),
    firstNonEmpty(baseCandidate.contentRating, ...details.map((detail) => detail.contentRating))
      ? `Rated: ${firstNonEmpty(baseCandidate.contentRating, ...details.map((detail) => detail.contentRating))}`
      : null,
    firstNonEmpty(baseCandidate.awards, ...details.map((detail) => detail.awards))
      ? `Awards: ${firstNonEmpty(baseCandidate.awards, ...details.map((detail) => detail.awards))}`
      : null,
  ], 18);
  const sourceLinks = mergeStringMaps(
    baseCandidate.sourceLinks,
    baseCandidate.externalUrl ? { [baseCandidate.source]: baseCandidate.externalUrl } : null,
    ...details.map((detail) => detail.sourceLinks)
  );

  return sanitizeMetadataCandidate({
    ...baseCandidate,
    title: firstNonEmpty(baseCandidate.title, ...details.map((detail) => detail.title)),
    year: firstFinite(baseCandidate.year, ...details.map((detail) => detail.year)),
    overview: pickLongestText(baseCandidate.overview, ...details.map((detail) => detail.overview)),
    posterUrl: firstNonEmpty(baseCandidate.posterUrl, ...details.map((detail) => detail.posterUrl)) || null,
    backdropUrl: firstNonEmpty(baseCandidate.backdropUrl, ...details.map((detail) => detail.backdropUrl)) || null,
    rating: firstFinite(baseCandidate.rating, ...details.map((detail) => detail.rating)),
    runtime: firstNonEmpty(baseCandidate.runtime, ...details.map((detail) => detail.runtime)) || null,
    genre: categories.join(', '),
    externalUrl: baseCandidate.externalUrl || sourceLinks[baseCandidate.source] || Object.values(sourceLinks)[0] || null,
    sources: sanitizeStringArray([baseCandidate.sources, ...details.map((detail) => detail.source)]),
    providerIds: mergeStringMaps(baseCandidate.providerIds, ...details.map((detail) => detail.providerIds)),
    sourceLinks,
    tags: sanitizeStringArray([
      baseCandidate.tags,
      categories,
      baseCandidate.type === 'series' ? 'Series' : 'Movie',
      firstFinite(baseCandidate.year, ...details.map((detail) => detail.year)) ? String(firstFinite(baseCandidate.year, ...details.map((detail) => detail.year))) : null,
      ...details.map((detail) => detail.tags || []),
    ], 20),
    categories,
    usefulInfo,
    cast: mergeCastMembers(baseCandidate.cast, ...details.map((detail) => detail.cast || [])).slice(0, 14),
    tagline: firstNonEmpty(baseCandidate.tagline, ...details.map((detail) => detail.tagline)),
    releaseDate: firstNonEmpty(baseCandidate.releaseDate, ...details.map((detail) => detail.releaseDate)),
    contentRating: firstNonEmpty(baseCandidate.contentRating, ...details.map((detail) => detail.contentRating)),
    language: firstNonEmpty(baseCandidate.language, ...details.map((detail) => detail.language)),
    country: firstNonEmpty(baseCandidate.country, ...details.map((detail) => detail.country)),
    studio: firstNonEmpty(baseCandidate.studio, ...details.map((detail) => detail.studio)),
    awards: firstNonEmpty(baseCandidate.awards, ...details.map((detail) => detail.awards)),
    seasonCount: firstFinite(baseCandidate.seasonCount, ...details.map((detail) => detail.seasonCount)),
    episodeCount: firstFinite(baseCandidate.episodeCount, ...details.map((detail) => detail.episodeCount)),
  });
}

async function fetchTmdbPersonDetails(tmdbId, tmdbApiKey) {
  if (!tmdbId || !tmdbApiKey) return null;
  const person = await fetchTmdbJson(`/person/${tmdbId}`, tmdbApiKey, {
    append_to_response: 'combined_credits,external_ids',
    language: 'en-US',
  });
  if (!person) return null;
  const combinedCredits = [...(person.combined_credits?.cast || []), ...(person.combined_credits?.crew || [])]
    .sort((left, right) => (right.popularity || 0) - (left.popularity || 0));
  return sanitizeCastMember({
    source: 'TMDb',
    name: person.name,
    bio: person.biography || '',
    photoUrl: person.profile_path ? `https://image.tmdb.org/t/p/w500${person.profile_path}` : null,
    externalUrl: `https://www.themoviedb.org/person/${tmdbId}`,
    sourceIds: mergeStringMaps(
      { TMDb: String(tmdbId) },
      person.external_ids?.imdb_id ? { IMDb: person.external_ids.imdb_id } : null
    ),
    links: sanitizeLinkEntries([
      { label: 'TMDb', url: `https://www.themoviedb.org/person/${tmdbId}` },
      person.external_ids?.imdb_id ? { label: 'IMDb', url: `https://www.imdb.com/name/${person.external_ids.imdb_id}/` } : null,
    ]),
    knownFor: sanitizeStringArray(combinedCredits.map((item) => item.title || item.name), 8),
    facts: sanitizeStringArray([
      person.known_for_department ? `Known for: ${person.known_for_department}` : null,
      person.birthday ? `Born: ${person.birthday}` : null,
      person.place_of_birth ? `From: ${person.place_of_birth}` : null,
      person.deathday ? `Died: ${person.deathday}` : null,
    ], 8),
  });
}

async function fetchLetterboxdContributorDetails(letterboxdId, clientId, clientSecret) {
  if (!letterboxdId) return null;
  const [contributor, contributions] = await Promise.all([
    fetchOptionalJsonPromise(() => fetchLetterboxdJson(`contributor/${encodeURIComponent(letterboxdId)}`, { clientId, clientSecret })),
    fetchOptionalJsonPromise(() => fetchLetterboxdJson(`contributor/${encodeURIComponent(letterboxdId)}/contributions`, {
      clientId,
      clientSecret,
      params: { type: 'Actor', perPage: 6 },
    })),
  ]);
  if (!contributor) return null;
  return sanitizeCastMember({
    source: 'Letterboxd',
    name: contributor.name,
    bio: contributor.bio || '',
    photoUrl: pickLetterboxdImageUrl(contributor.customPoster || contributor.poster),
    externalUrl: getLetterboxdLink(contributor),
    sourceIds: mergeStringMaps(
      { Letterboxd: String(letterboxdId) },
      contributor.tmdbid ? { TMDb: String(contributor.tmdbid) } : null
    ),
    links: sanitizeLinkEntries((contributor.links || []).map((link) => ({ label: link.type || 'Link', url: link.url }))),
    knownFor: sanitizeStringArray((contributions?.items || []).map((item) => item?.film?.name), 8),
    facts: sanitizeStringArray((contributor.statistics?.contributions || []).map((entry) => `${entry.type}: ${entry.filmCount} titles`), 8),
  });
}

async function fetchTvMazePersonDetails(tvmazeId) {
  if (!tvmazeId) return null;
  const person = await fetchOptionalJson(`https://api.tvmaze.com/people/${encodeURIComponent(tvmazeId)}`);
  if (!person) return null;
  return sanitizeCastMember({
    source: 'TVMaze',
    name: person.name,
    photoUrl: person.image?.original || person.image?.medium || null,
    externalUrl: person.url || null,
    sourceIds: { TVMaze: String(tvmazeId) },
    facts: sanitizeStringArray([
      person.gender,
      person.birthday ? `Born: ${person.birthday}` : null,
      person.country?.name ? `From: ${person.country.name}` : null,
    ], 6),
  });
}

async function lookupPersonDetails(person) {
  const candidate = sanitizeCastMember(person);
  if (!candidate) return null;
  const providerConfig = getMetadataProviderConfig();
  const tmdbDetail = await fetchTmdbPersonDetails(candidate.sourceIds.TMDb, providerConfig.tmdbApiKey);
  const letterboxdDetail = tmdbDetail ? null : await fetchLetterboxdContributorDetails(candidate.sourceIds.Letterboxd, providerConfig.letterboxdClientId, providerConfig.letterboxdClientSecret);
  const tvmazeDetail = tmdbDetail || letterboxdDetail ? null : await fetchTvMazePersonDetails(candidate.sourceIds.TVMaze);
  const detail = tmdbDetail || letterboxdDetail || tvmazeDetail;
  if (!detail) return candidate;
  return sanitizeCastMember({
    ...candidate,
    source: candidate.source || detail.source,
    sources: sanitizeStringArray([candidate.sources, detail.sources]),
    bio: pickLongestText(candidate.bio, detail.bio),
    photoUrl: candidate.photoUrl || detail.photoUrl,
    externalUrl: candidate.externalUrl || detail.externalUrl,
    sourceIds: mergeStringMaps(candidate.sourceIds, detail.sourceIds),
    links: sanitizeLinkEntries([...candidate.links, ...detail.links], 10),
    knownFor: sanitizeStringArray([candidate.knownFor, detail.knownFor], 8),
    facts: sanitizeStringArray([candidate.facts, detail.facts], 10),
  });
}

async function searchTvMaze(parsed) {
  try {
    const results = await fetchJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(parsed.query)}`);
    return results.slice(0, 6).map((item) => ({
      source: 'TVMaze',
      sourceId: item.show.id,
      title: item.show.name,
      year: item.show.premiered ? Number(item.show.premiered.slice(0, 4)) : null,
      type: 'series',
      overview: stripHtml(item.show.summary),
      posterUrl: item.show.image?.medium || item.show.image?.original || null,
      rating: item.show.rating?.average || null,
      runtime: item.show.runtime || null,
      genre: Array.isArray(item.show.genres) ? item.show.genres.join(', ') : '',
      externalUrl: item.show.url || null,
    }));
  } catch {
    return [];
  }
}

async function searchTmdb(parsed, tmdbApiKey) {
  if (!tmdbApiKey) return [];

  try {
    const [movies, tv] = await Promise.all([
      fetchTmdbJson('/search/movie', tmdbApiKey, {
        query: parsed.query,
        include_adult: 'false',
        language: 'en-US',
        page: '1',
        year: parsed.year && !parsed.isSeries ? parsed.year : '',
      }),
      fetchTmdbJson('/search/tv', tmdbApiKey, {
        query: parsed.query,
        include_adult: 'false',
        language: 'en-US',
        page: '1',
        first_air_date_year: parsed.year ? parsed.year : '',
      }),
    ]);

    const movieCandidates = (movies.results || []).slice(0, 5).map((item) => ({
      source: 'TMDb',
      sourceId: item.id,
      title: item.title,
      year: item.release_date ? Number(item.release_date.slice(0, 4)) : null,
      type: 'movie',
      overview: item.overview || '',
      posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : null,
      rating: item.vote_average || null,
      runtime: null,
      genre: '',
      externalUrl: `https://www.themoviedb.org/movie/${item.id}`,
    }));

    const tvCandidates = (tv.results || []).slice(0, 5).map((item) => ({
      source: 'TMDb',
      sourceId: item.id,
      title: item.name,
      year: item.first_air_date ? Number(item.first_air_date.slice(0, 4)) : null,
      type: 'series',
      overview: item.overview || '',
      posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : null,
      rating: item.vote_average || null,
      runtime: null,
      genre: '',
      externalUrl: `https://www.themoviedb.org/tv/${item.id}`,
    }));

    return [...movieCandidates, ...tvCandidates];
  } catch {
    return [];
  }
}

async function searchOmdb(parsed, omdbApiKey) {
  if (!omdbApiKey) return [];

  try {
    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('apikey', omdbApiKey);
    url.searchParams.set('s', parsed.query);
    if (parsed.year) url.searchParams.set('y', String(parsed.year));
    if (parsed.isSeries) url.searchParams.set('type', 'series');

    const searchResults = await fetchJson(url.toString());
    if (!searchResults.Search) return [];

    const detailResults = await Promise.all(searchResults.Search.slice(0, 4).map(async (item) => {
      try {
        const detailUrl = new URL('https://www.omdbapi.com/');
        detailUrl.searchParams.set('apikey', omdbApiKey);
        detailUrl.searchParams.set('i', item.imdbID);
        detailUrl.searchParams.set('plot', 'short');
        const detail = await fetchJson(detailUrl.toString());
        return {
          source: 'OMDb',
          sourceId: item.imdbID,
          title: detail.Title || item.Title,
          year: detail.Year ? Number(String(detail.Year).slice(0, 4)) : null,
          type: detail.Type === 'series' ? 'series' : 'movie',
          overview: detail.Plot && detail.Plot !== 'N/A' ? detail.Plot : '',
          posterUrl: detail.Poster && detail.Poster !== 'N/A' ? detail.Poster : null,
          rating: detail.imdbRating && detail.imdbRating !== 'N/A' ? Number(detail.imdbRating) : null,
          runtime: detail.Runtime && detail.Runtime !== 'N/A' ? detail.Runtime : null,
          genre: detail.Genre && detail.Genre !== 'N/A' ? detail.Genre : '',
          externalUrl: item.imdbID ? `https://www.imdb.com/title/${item.imdbID}/` : null,
        };
      } catch {
        return null;
      }
    }));

    return detailResults.filter(Boolean);
  } catch {
    return [];
  }
}

async function searchLetterboxd(parsed, clientId, clientSecret) {
  if (parsed.isSeries) return [];

  try {
    const searchResults = await fetchLetterboxdJson('search', {
      clientId,
      clientSecret,
      params: {
        input: parsed.query,
        searchMethod: 'Autocomplete',
        include: 'FilmSearchItem',
        perPage: '6',
        adult: 'false',
        excludeMemberFilmRelationships: 'true',
      },
    });

    const items = Array.isArray(searchResults?.items) ? searchResults.items : [];
    const filmItems = items
      .filter((item) => item?.type === 'FilmSearchItem' && item.film?.id)
      .slice(0, 4);

    const detailedFilms = await Promise.all(filmItems.map(async (item) => {
      const summary = item.film;
      try {
        const detail = await fetchLetterboxdJson(`film/${encodeURIComponent(summary.id)}`, {
          clientId,
          clientSecret,
        });
        return detail;
      } catch {
        return summary;
      }
    }));

    return detailedFilms.map((film) => ({
      source: 'Letterboxd',
      sourceId: film.id,
      title: film.name,
      year: Number.isFinite(film.releaseYear) ? film.releaseYear : null,
      type: 'movie',
      overview: film.description || film.tagline || '',
      posterUrl: pickLetterboxdImageUrl(film.poster) || pickLetterboxdImageUrl(film.backdrop),
      rating: Number.isFinite(film.rating) ? film.rating * 2 : null,
      runtime: Number.isFinite(film.runTime) ? `${film.runTime} min` : null,
      genre: Array.isArray(film.genres) ? film.genres.map((genre) => genre.name).filter(Boolean).join(', ') : '',
      externalUrl: getLetterboxdLink(film),
    }));
  } catch {
    return [];
  }
}

async function lookupMetadata(filename, videoPath, forceRefresh = false) {
  const cacheKey = `${videoPath || ''}|${filename || ''}`;
  if (!forceRefresh && metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey);
  }

  const parsed = parseFilenameMetadata(filename);
  const providerConfig = getMetadataProviderConfig();
  const savedMatch = getSelectedMetadata(videoPath);
  if (!forceRefresh && savedMatch) {
    const enrichedSavedMatch = await compileMetadataCandidate(savedMatch, parsed, providerConfig) || savedMatch;
    setSelectedMetadata(videoPath, enrichedSavedMatch);
    const savedResult = {
      parsed,
      sourceStatus: getMetadataSourceStatus(),
      candidates: [enrichedSavedMatch],
      bestMatch: enrichedSavedMatch,
      selectedMatch: enrichedSavedMatch,
    };
    metadataCache.set(cacheKey, savedResult);
    return savedResult;
  }

  const sourceStatus = getMetadataSourceStatus();
  const [tvMazeCandidates, tmdbCandidates, omdbCandidates, letterboxdCandidates] = await Promise.all([
    searchTvMaze(parsed),
    searchTmdb(parsed, providerConfig.tmdbApiKey),
    searchOmdb(parsed, providerConfig.omdbApiKey),
    searchLetterboxd(parsed, providerConfig.letterboxdClientId, providerConfig.letterboxdClientSecret),
  ]);

  const candidates = mergeCandidates([
    ...tvMazeCandidates,
    ...tmdbCandidates,
    ...omdbCandidates,
    ...letterboxdCandidates,
  ], parsed);
  const bestMatch = candidates[0] || null;
  const compiledBestMatch = bestMatch ? await compileMetadataCandidate(bestMatch, parsed, providerConfig) : null;

  // Persist the top match so repeat playback and future launches reuse it
  // instead of re-querying providers every time. Manual refresh still bypasses this.
  const persistedMatch = compiledBestMatch ? setSelectedMetadata(videoPath, compiledBestMatch) : null;

  const result = {
    parsed,
    sourceStatus,
    candidates,
    bestMatch: compiledBestMatch,
    selectedMatch: persistedMatch || getSelectedMetadata(videoPath),
  };

  metadataCache.set(cacheKey, result);
  return result;
}

function collectVideos(rootPath, currentPath, videos, metadataSelections) {
  let entries;
  try { entries = fs.readdirSync(currentPath, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === 'thumbnails') continue;
      collectVideos(rootPath, fullPath, videos, metadataSelections);
      continue;
    }

    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) continue;

    let stats;
    try { stats = fs.statSync(fullPath); } catch { continue; }

    const relativePath = path.relative(rootPath, fullPath);
    const relativeDir = path.dirname(relativePath);
    const folderTags = relativeDir === '.'
      ? []
      : relativeDir.split(path.sep).filter(Boolean);
    const td = thumbDir(fullPath);
    const posterPath = path.join(td, 'poster.jpg');
    const hasPoster = fs.existsSync(posterPath);
    const localPosterUrl = hasPoster ? fileToMediaUrl(posterPath) : null;
    const metadataMatch = sanitizeMetadataCandidate(metadataSelections?.[fullPath]);

    videos.push({
      name: entry.name,
      path: fullPath,
      relativePath,
      relativeDir: relativeDir === '.' ? '' : relativeDir,
      folderTags,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      hasPoster,
      hasSprites: fs.existsSync(path.join(td, 'thumbs.vtt')),
      posterUrl: localPosterUrl,
      localPosterUrl,
      metadataMatch,
    });
  }
}

// ── IPC: Folder & file listing ──
ipcMain.handle('select-folder', async () => {
  const settings = loadSettings();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: settings.lastFolder || undefined,
  });
  if (result.canceled || !result.filePaths.length) return null;
  const folder = result.filePaths[0];
  saveSettings({ lastFolder: folder });
  return folder;
});

ipcMain.handle('get-last-folder', () => loadSettings().lastFolder || null);

ipcMain.handle('list-videos', async (event, folderPath) => {
  const videos = [];
  collectVideos(folderPath, folderPath, videos, getMetadataSelections());
  videos.sort((a, b) => a.name.localeCompare(b.name));
  return videos;
});

ipcMain.handle('get-media-url', (event, filePath) => pathToFileURL(filePath).toString());

ipcMain.handle('get-duration', async (event, videoPath) => getDuration(videoPath));

// ── IPC: Poster generation ──
ipcMain.handle('generate-poster', async (event, videoPath) => {
  const td = thumbDir(videoPath);
  const posterPath = path.join(td, 'poster.jpg');
  if (fs.existsSync(posterPath)) return fileToMediaUrl(posterPath);

  fs.mkdirSync(td, { recursive: true });
  const duration = await getDuration(videoPath);
  const seekTime = Math.max(1, Math.floor(duration * 0.1));

  return new Promise((resolve) => {
    execFile(FFMPEG_BIN, [
      '-ss', String(seekTime),
      '-i', videoPath,
      '-vframes', '1',
      '-vf', 'scale=320:-2',
      '-q:v', '3',
      '-y',
      posterPath
    ], { timeout: 60000 }, (err) => {
      if (err || !fs.existsSync(posterPath)) return resolve(null);
      resolve(fileToMediaUrl(posterPath));
    });
  });
});

// ── IPC: Sprite generation ──
ipcMain.handle('generate-sprites', async (event, videoPath) => {
  const sender = event.sender;
  const td = thumbDir(videoPath);
  const vttPath = path.join(td, 'thumbs.vtt');

  if (fs.existsSync(vttPath)) {
    return { status: 'exists', vttUrl: fileToMediaUrl(vttPath) };
  }

  fs.mkdirSync(td, { recursive: true });
  const duration = await getDuration(videoPath);
  if (duration <= 0) return { status: 'error', error: 'Could not determine video duration' };

  // Match KPM Player (stream_app.py) settings exactly
  const interval = 10;  // fixed 10-second interval
  const cols = 5, rows = 5;
  const thumbW = 427, thumbH = 240;
  const actualFrames = Math.ceil(duration / interval);

  sendToWebContents(sender, 'sprite-progress', { videoPath, percent: 0, status: 'generating' });

  const spritePattern = path.join(td, 'sprite_%d.jpg');

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_BIN, [
        '-i', videoPath,
        '-vf', `fps=1/${interval},scale=${thumbW}:${thumbH},tile=${cols}x${rows}`,
        '-q:v', '5',
        '-y',
        spritePattern
      ]);

      let cancelled = false;
      const cancelIfSenderDestroyed = () => {
        if (cancelled || !sender.isDestroyed()) return;
        cancelled = true;
        proc.kill();
        reject(new Error('Renderer was closed while generating sprites'));
      };

      sender.once('destroyed', cancelIfSenderDestroyed);

      proc.stderr.on('data', (data) => {
        if (cancelled) return;
        const str = data.toString();
        const m = str.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
          const pct = Math.min(99, Math.round(secs / duration * 100));
          sendToWebContents(sender, 'sprite-progress', { videoPath, percent: pct, status: 'generating' });
        }
      });

      proc.on('close', (code) => {
        sender.removeListener('destroyed', cancelIfSenderDestroyed);
        if (cancelled) return;
        code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`));
      });
      proc.on('error', (error) => {
        sender.removeListener('destroyed', cancelIfSenderDestroyed);
        if (cancelled) return;
        reject(error);
      });
    });
  } catch (err) {
    sendToWebContents(sender, 'sprite-progress', { videoPath, percent: 0, status: 'error' });
    return { status: 'error', error: err.message };
  }

  // Generate VTT with absolute local-media:// sprite URLs
  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < actualFrames; i++) {
    const startTime = i * interval;
    const endTime = Math.min((i + 1) * interval, duration);
    const spriteNum = Math.floor(i / (cols * rows)) + 1;
    const pos = i % (cols * rows);
    const x = (pos % cols) * thumbW;
    const y = Math.floor(pos / cols) * thumbH;
    const spriteUrl = fileToMediaUrl(path.join(td, `sprite_${spriteNum}.jpg`));
    vtt += `${fmtVttTime(startTime)} --> ${fmtVttTime(endTime)}\n`;
    vtt += `${spriteUrl}#xywh=${x},${y},${thumbW},${thumbH}\n\n`;
  }
  fs.writeFileSync(vttPath, vtt);

  sendToWebContents(sender, 'sprite-progress', { videoPath, percent: 100, status: 'done' });
  return { status: 'generated', vttUrl: fileToMediaUrl(vttPath) };
});

// ── IPC: ffmpeg check ──
ipcMain.handle('check-ffmpeg', () => {
  return new Promise((resolve) => {
    execFile(FFMPEG_BIN, ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
});

ipcMain.handle('lookup-metadata', async (event, payload) => {
  const { filename, videoPath, forceRefresh } = payload || {};
  if (!filename) {
    return { parsed: null, sourceStatus: getMetadataSourceStatus(), candidates: [], bestMatch: null, selectedMatch: getSelectedMetadata(videoPath) };
  }
  return lookupMetadata(filename, videoPath, Boolean(forceRefresh));
});

ipcMain.handle('get-metadata-source-status', () => getMetadataSourceStatus());

ipcMain.handle('get-metadata-settings', () => {
  const settings = loadSettings();
  return {
    tmdbApiKey: settings.tmdbApiKey || '',
    omdbApiKey: settings.omdbApiKey || '',
    letterboxdClientId: settings.letterboxdClientId || '',
    letterboxdClientSecret: settings.letterboxdClientSecret || '',
  };
});

ipcMain.handle('save-metadata-settings', (event, payload) => {
  const nextSettings = {
    tmdbApiKey: String(payload?.tmdbApiKey || '').trim(),
    omdbApiKey: String(payload?.omdbApiKey || '').trim(),
    letterboxdClientId: String(payload?.letterboxdClientId || '').trim(),
    letterboxdClientSecret: String(payload?.letterboxdClientSecret || '').trim(),
  };
  saveSettings(nextSettings);
  metadataCache.clear();
  letterboxdTokenCache = null;
  return {
    saved: true,
    sourceStatus: getMetadataSourceStatus(),
    settings: nextSettings,
  };
});

ipcMain.handle('save-selected-metadata', async (event, payload) => {
  const parsed = parseFilenameMetadata(payload?.filename || path.basename(payload?.videoPath || 'video'));
  const candidate = sanitizeMetadataCandidate(payload?.match);
  const compiledMatch = candidate
    ? await compileMetadataCandidate(candidate, parsed, getMetadataProviderConfig()) || candidate
    : null;
  const savedMatch = setSelectedMetadata(payload?.videoPath, compiledMatch);
  return {
    savedMatch,
    sourceStatus: getMetadataSourceStatus(),
  };
});

ipcMain.handle('clear-selected-metadata', (event, payload) => {
  clearSelectedMetadata(payload?.videoPath);
  return {
    cleared: true,
    sourceStatus: getMetadataSourceStatus(),
  };
});

ipcMain.handle('lookup-person-details', async (event, payload) => {
  const person = await lookupPersonDetails(payload?.person);
  return { person };
});
