// Load dotenv only in local development (not on Vercel)
// Vercel automatically sets VERCEL=1, so we skip dotenv there
if (!process.env.VERCEL) {
  require("dotenv").config();
}

const express = require("express");
const OpenAI = require("openai");

const app = express();

app.use(express.json());

// Validate required environment variables
function validateEnvVars() {
  const missing = [];
  if (!process.env.OPENAI_API_KEY) {
    missing.push("OPENAI_API_KEY");
  }
  return missing;
}

// Middleware to check environment variables before handling requests
app.use((req, res, next) => {
  // Skip validation for health endpoint
  if (req.path === "/health") {
    return next();
  }

  const missing = validateEnvVars();
  if (missing.length > 0) {
    return res.status(500).json({
      error: "Server configuration error",
      message: `Missing required environment variables: ${missing.join(", ")}`,
      details: "Please configure the required environment variables in your deployment settings.",
    });
  }
  next();
});

// Initialize OpenAI client (will fail gracefully if key is missing due to middleware)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_COUNT = 30;

// --- simple in-memory poster cache ---
const posterCache = Object.create(null);

const ITUNES_COUNTRY = "us";
const POSTER_PLACEHOLDER = "https://dummyimage.com/600x600/111/fff&text=No+Cover";

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
  const text = `${String(title || "").trim()} ${String(artist || "").trim()}`.trim() || "No Cover";
  return `https://dummyimage.com/600x600/111/fff&text=${encodeURIComponent(text.slice(0, 60))}`;
}

async function fetchItunesPoster(title, artist) {
  const k = keyOf(title, artist);
  if (posterCache[k] !== undefined) return posterCache[k]; // cache hit

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

    // ilk artwork olan nəticəni seç
    const artworkUrl100 = results.find((x) => x?.artworkUrl100)?.artworkUrl100 || null;
    const posterUrl = toHiResArtwork(artworkUrl100);

    const finalPoster = posterUrl || buildPlaceholderPoster(title, artist) || POSTER_PLACEHOLDER;
    posterCache[k] = finalPoster;
    return finalPoster;
  } catch {
    const ph = buildPlaceholderPoster(title, artist) || POSTER_PLACEHOLDER;
    posterCache[k] = ph;
    return ph;
  }
}

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
    if (!res.ok) {
      return null;
    }
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
    if (id && id.length === 11) {
      return id;
    }
  }
  return null;
}

// ---------------- AI FUNCTION ----------------
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

// ---------------- HEALTH CHECK ENDPOINT ----------------
// GET /health
app.get("/health", (req, res) => {
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
  return res.json({
    ok: true,
    hasOpenAIKey,
  });
});

// ---------------- GET ENDPOINT ----------------
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
          posterUrl: await fetchItunesPoster(title, artist), // artıq null qaytarmır
        };
      })
    );

    return res.json(result);
  } catch (error) {
    console.error("Server error:", error);
    return res.json([]);
  }
});

// ---------------- POST ENDPOINT ----------------
// POST /resolve/music-url
app.post("/resolve/music-url", async (req, res) => {
  try {
    const body = req.body || {};
    const youtubeSearchUrlInput = typeof body.youtubeSearchUrl === "string" ? body.youtubeSearchUrl.trim() : "";
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

    const youtubeSearchUrl =
      youtubeSearchUrlInput ||
      buildYoutubeSearchUrl(queryInput, "");

    const html = await fetchYoutubeSearchHtml(youtubeSearchUrl);
    const videoId = extractFirstVideoId(html);

    if (!videoId) {
      setResolveCache(cacheKey, null, null);
      return res.json({
        musicUrl: null,
        youtubeUrl: null,
      });
    }

    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const musicUrl = `https://music.youtube.com/watch?v=${videoId}`;

    setResolveCache(cacheKey, youtubeUrl, musicUrl);

    return res.json({
      musicUrl,
      youtubeUrl,
    });
  } catch {
    return res.json({
      musicUrl: null,
      youtubeUrl: null,
    });
  }
});

// Export the app for Vercel serverless functions
module.exports = app;

// For local development
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
  });
}