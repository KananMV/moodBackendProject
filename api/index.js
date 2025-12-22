// Load dotenv only in local development (not on Vercel)
// Vercel automatically sets VERCEL=1, so we skip dotenv there
if (!process.env.VERCEL) {
  require("dotenv").config();
}

const express = require("express");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ---------------- ENV VALIDATION ----------------
function validateEnvVars() {
  const missing = [];
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  return missing;
}

app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const missing = validateEnvVars();
  if (missing.length > 0) {
    return res.status(500).json({
      error: "Server configuration error",
      message: `Missing required environment variables: ${missing.join(", ")}`,
      details:
        "Please configure the required environment variables in your deployment settings.",
    });
  }
  next();
});

// ---------------- OPENAI ----------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------- CONSTANTS ----------------
const DEFAULT_COUNT = 30;
const ITUNES_COUNTRY = "us";
const POSTER_PLACEHOLDER =
  "https://dummyimage.com/600x600/111/fff&text=No+Cover";

// ---------------- POSTER CACHE ----------------
const posterCache = Object.create(null);

function keyOf(title, artist) {
  return `${String(title || "").trim().toLowerCase()} - ${String(artist || "")
    .trim()
    .toLowerCase()}`;
}

function toHiResArtwork(url100) {
  if (!url100) return null;
  return url100.replace(/\/100x100bb\./, "/600x600bb.");
}

function buildPlaceholderPoster(title, artist) {
  const text =
    `${String(title || "").trim()} ${String(artist || "").trim()}`.trim() ||
    "No Cover";
  return `https://dummyimage.com/600x600/111/fff&text=${encodeURIComponent(
    text.slice(0, 60)
  )}`;
}

async function fetchItunesPoster(title, artist) {
  const k = keyOf(title, artist);
  if (posterCache[k] !== undefined) return posterCache[k];

  const term = `${title || ""} ${artist || ""}`.trim();
  if (!term) {
    const ph = buildPlaceholderPoster(title, artist);
    posterCache[k] = ph;
    return ph;
  }

  const params = new URLSearchParams({
    term,
    entity: "song",
    limit: "5",
    country: ITUNES_COUNTRY,
  });

  const url = `https://itunes.apple.com/search?${params.toString()}`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);

    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(t);

    if (!r.ok) {
      const ph = buildPlaceholderPoster(title, artist) || POSTER_PLACEHOLDER;
      posterCache[k] = ph;
      return ph;
    }

    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];

    const artworkUrl100 =
      results.find((x) => x?.artworkUrl100)?.artworkUrl100 || null;
    const posterUrl = toHiResArtwork(artworkUrl100);

    const finalPoster =
      posterUrl || buildPlaceholderPoster(title, artist) || POSTER_PLACEHOLDER;

    posterCache[k] = finalPoster;
    return finalPoster;
  } catch {
    const ph = buildPlaceholderPoster(title, artist) || POSTER_PLACEHOLDER;
    posterCache[k] = ph;
    return ph;
  }
}

// ---------------- YOUTUBE SEARCH URL ----------------
function buildYoutubeSearchUrl(title, artist) {
  const q = `${title} ${artist}`.trim();
  const params = new URLSearchParams({ search_query: q });
  return `https://www.youtube.com/results?${params.toString()}`;
}

// ---------------- RESOLVE MUSIC URL HELPERS ----------------
const resolveCache = Object.create(null);
const RESOLVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getFromResolveCache(key) {
  if (!key) return null;
  const entry = resolveCache[key];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    delete resolveCache[key];
    return null;
  }
  return { youtubeUrl: entry.youtubeUrl, musicUrl: entry.musicUrl };
}

function setResolveCache(key, youtubeUrl, musicUrl) {
  if (!key) return;
  resolveCache[key] = {
    youtubeUrl,
    musicUrl,
    expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS,
  };
}

async function fetchYoutubeSearchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractFirstVideoId(html) {
  if (!html) return null;
  const re = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const id = match[1];
    if (id && id.length === 11) return id;
  }
  return null;
}

// ---------------- AI: SONGS ----------------
async function generateSongsWithAI(mood, count) {
  const prompt = `
Generate ${count} real songs suitable for the mood "${mood}".

Return ONLY valid JSON array.
Format:
[
  { "title": "...", "artist": "..." }
]

Rules:
- No explanations
- No links
- No emojis
- No duplicates
`.trim();

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) return [];

  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------- PODCAST (iTunes + AI terms) ----------------
const PODCAST_DEFAULT_LIMIT = 20;
const podcastCache = Object.create(null);
const PODCAST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

function getPodcastCache(key) {
  const e = podcastCache[key];
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    delete podcastCache[key];
    return null;
  }
  return e.value;
}
function setPodcastCache(key, value) {
  podcastCache[key] = { value, expiresAt: Date.now() + PODCAST_CACHE_TTL_MS };
}

async function generatePodcastTermsWithAI(mood) {
  const prompt = `
Generate 5 podcast search queries (keywords) that match the mood "${mood}".

Return ONLY valid JSON array of strings.
Example:
["stress relief", "calm mind", "sleep stories", "anxiety help", "guided meditation"]

Rules:
- Only strings
- No explanations
- No emojis
`.trim();

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.5,
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) return [];

  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr)
      ? arr.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

async function fetchItunesPodcastsByTerm(term, country = "us", limit = 10) {
  const t = String(term || "").trim();
  if (!t) return [];

  const params = new URLSearchParams({
    term: t,
    media: "podcast",
    entity: "podcast",
    limit: String(limit),
    country,
  });

  const url = `https://itunes.apple.com/search?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return [];

    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];

    return results.map((p) => ({
      collectionId: p.collectionId ?? null,
      title: p.collectionName ?? null,
      author: p.artistName ?? null,
      artworkUrl: p.artworkUrl600 || p.artworkUrl100 || null,
      trackViewUrl: p.trackViewUrl || null, // Apple Podcasts web/universal link
      feedUrl: p.feedUrl || null, // RSS (optional)
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------- ROOT ----------------
app.get("/", (req, res) => {
  return res.json({
    message: "Mood Backend API",
    endpoints: {
      health: "GET /health",
      moodSongs: "GET /mood/songs?mood=happy",
      moodPodcasts: "GET /mood/podcasts?mood=calm",
      resolveMusicUrl: "POST /resolve/music-url",
    },
  });
});

// ---------------- HEALTH ----------------
app.get("/health", (req, res) => {
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
  return res.json({ ok: true, hasOpenAIKey });
});

// ---------------- SONGS ----------------
// GET /mood/songs?mood=happy
app.get("/mood/songs", async (req, res) => {
  try {
    const mood = String(req.query.mood || "").trim();
    if (!mood) return res.status(400).json([]);

    const songs = await generateSongsWithAI(mood, DEFAULT_COUNT);

    const result = await Promise.all(
      (songs || []).map(async (song) => {
        const title = song?.title;
        const artist = song?.artist;

        return {
          title,
          artist,
          youtubeSearchUrl: buildYoutubeSearchUrl(title, artist),
          posterUrl: await fetchItunesPoster(title, artist),
        };
      })
    );

    return res.json(result);
  } catch (error) {
    console.error("Server error:", error);
    return res.json([]);
  }
});

// ---------------- PODCASTS ----------------
// GET /mood/podcasts?mood=calm
app.get("/mood/podcasts", async (req, res) => {
  try {
    const mood = String(req.query.mood || "").trim();
    if (!mood) return res.status(400).json([]);

    const cacheKey = `podcasts:${mood.toLowerCase()}`;
    const cached = getPodcastCache(cacheKey);
    if (cached) return res.json(cached);

    let terms = await generatePodcastTermsWithAI(mood);

    // fallback if AI returns empty
    if (!terms || terms.length === 0) {
      terms = [mood, `${mood} podcast`, "mindfulness", "motivation", "self improvement"];
    }

    const all = [];
    for (const term of terms) {
      const chunk = await fetchItunesPodcastsByTerm(term, ITUNES_COUNTRY, 10);
      all.push(...chunk);
      if (all.length >= PODCAST_DEFAULT_LIMIT * 2) break;
    }

    // dedupe + keep usable items
    const seen = new Set();
    const unique = [];
    for (const p of all) {
      const id = p.collectionId || `${p.title}-${p.author}`;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      if (!p.title || !p.trackViewUrl) continue;

      unique.push(p);
      if (unique.length >= PODCAST_DEFAULT_LIMIT) break;
    }

    setPodcastCache(cacheKey, unique);
    return res.json(unique);
  } catch (e) {
    console.error("Podcast error:", e);
    return res.json([]);
  }
});

// ---------------- RESOLVE MUSIC URL ----------------
// POST /resolve/music-url
app.post("/resolve/music-url", async (req, res) => {
  try {
    const body = req.body || {};
    const youtubeSearchUrlInput =
      typeof body.youtubeSearchUrl === "string" ? body.youtubeSearchUrl.trim() : "";
    const queryInput = typeof body.query === "string" ? body.query.trim() : "";

    if (!youtubeSearchUrlInput && !queryInput) {
      return res.status(400).json({
        error: "Provide either 'youtubeSearchUrl' or 'query' in the JSON body.",
      });
    }

    const cacheKey = queryInput || youtubeSearchUrlInput;
    const cached = getFromResolveCache(cacheKey);
    if (cached) {
      return res.json({
        musicUrl: cached.musicUrl,
        youtubeUrl: cached.youtubeUrl,
      });
    }

    const youtubeSearchUrl = youtubeSearchUrlInput || buildYoutubeSearchUrl(queryInput, "");

    const html = await fetchYoutubeSearchHtml(youtubeSearchUrl);
    const videoId = extractFirstVideoId(html);

    if (!videoId) {
      setResolveCache(cacheKey, null, null);
      return res.json({ musicUrl: null, youtubeUrl: null });
    }

    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const musicUrl = `https://music.youtube.com/watch?v=${videoId}`;

    setResolveCache(cacheKey, youtubeUrl, musicUrl);
    return res.json({ musicUrl, youtubeUrl });
  } catch {
    return res.json({ musicUrl: null, youtubeUrl: null });
  }
});

// Export the app for Vercel serverless functions
module.exports = app;