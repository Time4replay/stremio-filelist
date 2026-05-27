const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 7002;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const FL_USERNAME = process.env.FL_USERNAME || 'Xander20';
const FL_PASSKEY  = process.env.FL_PASSKEY  || '9286b4781e34b43814feb8ae17e69421';

const CAT_MOVIES = '1,2,3,4,6,19,20,25,26';
const CAT_SERIES = '21,23,27';

// ─── Fetch JSON de la Filelist API ────────────────────────────────────────────
function flAPI(params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      username: FL_USERNAME,
      passkey: FL_PASSKEY,
      output: 'json',
      ...params
    }).toString();

    const options = {
      hostname: 'filelist.io',
      path: `/api.php?${qs}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve([]); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Descarca fisierul .torrent si extrage info hash ──────────────────────────
function getTorrentHash(downloadUrl) {
  return new Promise((resolve, reject) => {
    const lib = downloadUrl.startsWith('https') ? https : http;
    
    lib.get(downloadUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // Urmareste redirecturi
      if (res.statusCode === 301 || res.statusCode === 302) {
        return getTorrentHash(res.headers.location).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          // Parse bencode manual pentru a extrage info hash
          // Cautam dictionarul 'info' in fisierul torrent
          const hash = extractInfoHash(buf);
          resolve(hash);
        } catch(e) {
          reject(e);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Extrage info hash din fisier torrent (bencode) ───────────────────────────
function extractInfoHash(buf) {
  const crypto = require('crypto');
  
  // Gasim pozitia "4:info" in buffer
  const infoKey = Buffer.from('4:info');
  let infoStart = -1;
  
  for (let i = 0; i < buf.length - infoKey.length; i++) {
    if (buf.slice(i, i + infoKey.length).equals(infoKey)) {
      infoStart = i + infoKey.length;
      break;
    }
  }
  
  if (infoStart === -1) throw new Error('No info dict found');
  
  // Gasim sfarsitul dictionarului info (trebuie sa numaram d...e)
  let depth = 0;
  let pos = infoStart;
  
  // Primul caracter trebuie sa fie 'd' (dictionar)
  if (buf[pos] !== 100) throw new Error('Info is not a dict'); // 100 = 'd'
  
  depth = 1;
  pos++;
  
  while (pos < buf.length && depth > 0) {
    const ch = buf[pos];
    if (ch === 100 || ch === 108) { // 'd' sau 'l'
      depth++;
      pos++;
    } else if (ch === 101) { // 'e'
      depth--;
      pos++;
    } else if (ch >= 48 && ch <= 57) { // cifra - string bencode
      let colonPos = buf.indexOf(58, pos); // 58 = ':'
      const len = parseInt(buf.slice(pos, colonPos).toString());
      pos = colonPos + 1 + len;
    } else if (ch === 105) { // 'i' - integer
      const endPos = buf.indexOf(101, pos + 1); // 'e'
      pos = endPos + 1;
    } else {
      pos++;
    }
  }
  
  const infoEnd = pos;
  const infoBuf = buf.slice(infoStart, infoEnd);
  const hash = crypto.createHash('sha1').update(infoBuf).digest('hex');
  return hash;
}

// ─── Construieste magnet link ─────────────────────────────────────────────────
function buildMagnet(hash, name) {
  const trackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.tracker.cl:1337/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'http://tracker.openbittorrent.com:80/announce',
  ];
  
  const encodedName = encodeURIComponent(name);
  const trackerList = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodedName}${trackerList}`;
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function getQuality(torrent) {
  const cat = torrent.category || '';
  const name = torrent.name || '';
  if (cat.includes('4K') || name.match(/2160p|4K|UHD/i)) return '4K';
  if (name.match(/1080p/i)) return '1080p';
  if (name.match(/720p/i)) return '720p';
  if (cat.includes('Blu-Ray') || name.match(/BluRay|Blu-Ray/i)) return 'BluRay';
  if (cat.includes('HD')) return 'HD';
  if (cat.includes('DVD')) return 'DVD';
  return 'SD';
}

// ─── Cache pentru hash-uri (evitam re-download torrent) ──────────────────────
const hashCache = {};

// ─── Manifest ─────────────────────────────────────────────────────────────────
const manifest = {
  id: 'ro.filelist.stremio',
  version: '1.0.0',
  name: '🎬 FileList.io',
  description: 'Filme și seriale de pe FileList.io — tracker privat românesc',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// ─── Stream Handler ───────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    console.log(`[FileList] Request: ${type} ${id}`);

    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;

    const categories = type === 'movie' ? CAT_MOVIES : CAT_SERIES;

    const results = await flAPI({
      action: 'search-torrents',
      type: 'imdb',
      query: imdbId,
      category: categories
    });

    if (!results || !Array.isArray(results) || results.length === 0) {
      console.log(`[FileList] No results for ${imdbId}`);
      return { streams: [] };
    }

    // Filtram pentru seriale
    let filtered = results;
    if (type === 'series' && season && episode) {
      const seasonStr = `S${String(season).padStart(2, '0')}`;
      const episodeStr = `E${String(episode).padStart(2, '0')}`;
      const seEp = `${seasonStr}${episodeStr}`;

      const exact = results.filter(t =>
        t.name.toUpperCase().includes(seEp.toUpperCase())
      );
      const seasonPack = results.filter(t => {
        const name = t.name.toUpperCase();
        return name.includes(seasonStr.toUpperCase()) && !name.match(/E\d{2}/);
      });

      filtered = exact.length > 0 ? exact : [...seasonPack, ...results].slice(0, 8);
    }

    // Sortam dupa seederi
    filtered.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    filtered = filtered.slice(0, 8);

    console.log(`[FileList] Processing ${filtered.length} torrents...`);

    // Procesam torrentele in paralel (max 8)
    const streamPromises = filtered.map(async (torrent) => {
      try {
        // Verificam cache-ul
        let hash = hashCache[torrent.id];
        
        if (!hash) {
          hash = await getTorrentHash(torrent.download_link);
          hashCache[torrent.id] = hash;
          console.log(`[FileList] Hash extracted for ${torrent.name.substring(0, 40)}: ${hash}`);
        }

        const magnet = buildMagnet(hash, torrent.name);
        const quality = getQuality(torrent);
        const size = formatSize(torrent.size);
        const seeders = torrent.seeders || 0;
        const isRO = torrent.name.match(/\.(ro|RO)\.|romanian|subtitrare|dublat/i) ||
                     (torrent.category && torrent.category.includes('-RO'));

        const title = [
          `${quality}${isRO ? ' 🇷🇴' : ''}  👥 ${seeders}`,
          size,
          torrent.freeleech ? '⚡ Freeleech' : null,
          torrent.name.length > 60 ? torrent.name.substring(0, 60) + '...' : torrent.name
        ].filter(Boolean).join('\n');

        return {
          url: magnet,
          title,
          name: `FileList\n${quality}`,
          behaviorHints: { notWebReady: false }
        };
      } catch(err) {
        console.error(`[FileList] Error processing torrent ${torrent.id}:`, err.message);
        return null;
      }
    });

    const streams = (await Promise.all(streamPromises)).filter(Boolean);
    console.log(`[FileList] Returning ${streams.length} streams`);
    return { streams };

  } catch (err) {
    console.error('[FileList] Error:', err.message);
    return { streams: [] };
  }
});

// ─── Express server ───────────────────────────────────────────────────────────
const addonRouter = getRouter(builder.getInterface());
const app = express();

app.get('/logo', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="20" fill="#1a1a2e"/><text x="100" y="80" font-family="Arial Black,Arial" font-size="38" font-weight="900" text-anchor="middle" fill="#e94560">FILE</text><text x="100" y="130" font-family="Arial Black,Arial" font-size="38" font-weight="900" text-anchor="middle" fill="#ffffff">LIST</text><text x="100" y="170" font-family="Arial Black,Arial" font-size="22" font-weight="900" text-anchor="middle" fill="#e94560">.io</text></svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.end(svg);
});

app.use(addonRouter);

app.listen(PORT, () => {
  console.log(`\n🎬 FileList Addon pornit! (magnet links)`);
  console.log(`➡️  Manifest: ${BASE_URL}/manifest.json\n`);
});
