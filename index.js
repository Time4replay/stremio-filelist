const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const https = require('https');

const PORT = process.env.PORT || 7002;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// ─── Credentiale Filelist ─────────────────────────────────────────────────────
const FL_USERNAME = process.env.FL_USERNAME || 'Xander20';
const FL_PASSKEY  = process.env.FL_PASSKEY  || '9286b4781e34b43814feb8ae17e69421';

// ─── Categorii Filelist ───────────────────────────────────────────────────────
// Filme: 1(SD), 2(DVD), 3(DVD-RO), 4(HD), 6(4K), 19(HD-RO), 20(Blu-Ray), 25(3D), 26(4K Blu-Ray)
// Seriale: 21(HD), 23(SD), 27(4K)
const CAT_MOVIES  = '1,2,3,4,6,19,20,25,26';
const CAT_SERIES  = '21,23,27';
const CAT_ALL     = '1,2,3,4,6,19,20,21,23,25,26,27';

// ─── Helper: fetch JSON de la Filelist API ────────────────────────────────────
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
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          resolve([]);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Helper: construieste magnet link din download_link ──────────────────────
function buildMagnetFromTorrent(torrent) {
  // Filelist nu ofera magnet direct, dar ofera download_link
  // Stremio poate folosi direct link-ul de download ca torrent URL
  return torrent.download_link;
}

// ─── Helper: formateaza dimensiunea ──────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

// ─── Helper: calitate din categorie/nume ─────────────────────────────────────
function getQuality(torrent) {
  const cat = torrent.category || '';
  const name = torrent.name || '';
  if (cat.includes('4K') || name.match(/2160p|4K|UHD/i)) return '4K';
  if (cat.includes('Blu-Ray') || name.match(/BluRay|Blu-Ray/i)) return 'BluRay';
  if (cat.includes('HD') || name.match(/1080p|720p/i)) {
    if (name.match(/1080p/i)) return '1080p';
    if (name.match(/720p/i)) return '720p';
    return 'HD';
  }
  if (cat.includes('DVD')) return 'DVD';
  return 'SD';
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
const manifest = {
  id: 'ro.filelist.stremio',
  version: '1.0.0',
  name: '🎬 FileList.io',
  description: 'Filme și seriale de pe FileList.io — tracker privat românesc',
  logo: `${BASE_URL}/logo`,
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// ─── Stream Handler ───────────────────────────────────────────────────────────
// Stremio trimite IMDB ID (ex: tt1234567) + type (movie/series)
// + pentru seriale: id de forma tt1234567:1:2 (sezon:episod)
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    console.log(`[FileList] Stream request: ${type} ${id}`);

    // Parsam ID-ul
    const parts = id.split(':');
    const imdbId = parts[0]; // tt1234567
    const season = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;

    // Categorii in functie de tip
    const categories = type === 'movie' ? CAT_MOVIES : CAT_SERIES;

    // Cautam pe Filelist dupa IMDB ID
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

    // Filtram pentru seriale dupa sezon/episod
    let filtered = results;
    if (type === 'series' && season && episode) {
      const seasonStr = `S${String(season).padStart(2, '0')}`;
      const episodeStr = `E${String(episode).padStart(2, '0')}`;
      const seasonEp = `${seasonStr}${episodeStr}`;

      // Incercam sa gasim episodul exact
      const exact = results.filter(t =>
        t.name.toUpperCase().includes(seasonEp.toUpperCase()) ||
        t.name.toUpperCase().includes(seasonStr.toUpperCase() + 'E' + String(episode).padStart(2, '0'))
      );

      // Daca nu gasim episod exact, includem sezoanele complete
      const seasons = results.filter(t => {
        const name = t.name.toUpperCase();
        return name.includes(seasonStr.toUpperCase()) && !name.match(/E\d{2}/);
      });

      filtered = exact.length > 0 ? exact : [...seasons, ...results.slice(0, 5)];
    }

    // Sortam dupa seederi (descrescator)
    filtered.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

    // Luam maxim 10 rezultate
    filtered = filtered.slice(0, 10);

    // Construim stream-urile
    const streams = filtered.map(torrent => {
      const quality = getQuality(torrent);
      const size = formatSize(torrent.size);
      const seeders = torrent.seeders || 0;
      const isRO = torrent.name.match(/\.(ro|RO)\.|romanian|subtitrare|dublat/i) ||
                   torrent.category?.includes('-RO');

      const title = [
        `${quality}${isRO ? ' 🇷🇴' : ''}`,
        `👥 ${seeders} seeders`,
        size ? `💾 ${size}` : '',
        torrent.freeleech ? '⚡ Freeleech' : '',
        `📁 ${torrent.name.substring(0, 50)}...`
      ].filter(Boolean).join('\n');

      return {
        url: torrent.download_link,
        title,
        name: `FileList ${quality}`,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `filelist-${imdbId}`
        }
      };
    });

    console.log(`[FileList] Found ${streams.length} streams for ${imdbId}`);
    return { streams };

  } catch (err) {
    console.error('[FileList] Error:', err.message);
    return { streams: [] };
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const { getRouter } = require('stremio-addon-sdk');
const express = require('express');

const addonRouter = getRouter(builder.getInterface());
const app = express();

// Logo endpoint
app.get('/logo', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
    <rect width="200" height="200" rx="20" fill="#1a1a2e"/>
    <text x="100" y="80" font-family="Arial Black,Arial" font-size="38" font-weight="900" text-anchor="middle" fill="#e94560">FILE</text>
    <text x="100" y="130" font-family="Arial Black,Arial" font-size="38" font-weight="900" text-anchor="middle" fill="#ffffff">LIST</text>
    <text x="100" y="170" font-family="Arial Black,Arial" font-size="22" font-weight="900" text-anchor="middle" fill="#e94560">.io</text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.end(svg);
});

app.use(addonRouter);

app.listen(PORT, () => {
  console.log(`\n🎬 FileList Addon pornit!`);
  console.log(`➡️  Adaugă în Stremio: ${BASE_URL}/manifest.json\n`);
  console.log(`👤 User: ${FL_USERNAME}`);
});
