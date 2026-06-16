// Shared global REO vote tally + optional usernames.
// Storage: Upstash Redis via REST (no SDK; raw fetch keeps this build-free).
// Env: UPSTASH_REDIS_REST_URL / _TOKEN  (or Vercel's KV_REST_API_URL / _TOKEN).
// Degrades gracefully to {configured:false} so the page falls back to local.

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const K_YES = "reo:yes";
const K_NO = "reo:no";
const K_RECENT = "reo:recent";
const SEED_YES = 2814; // so the market opens at the established ~28% / 72%
const SEED_NO = 7239;
const RECENT_MAX = 30;

async function pipeline(commands) {
  const r = await fetch(`${REST_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`upstash ${r.status}`);
  return r.json(); // [{result}, ...]
}

function cleanName(name) {
  if (!name || typeof name !== "string") return "";
  return name.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
}

function parseRecent(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => {
      try { return JSON.parse(s); } catch (e) { return null; }
    })
    .filter(Boolean);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!REST_URL || !REST_TOKEN) {
    return res.status(200).json({ configured: false, yes: SEED_YES, no: SEED_NO, recent: [] });
  }

  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      body = body || {};
      const side = body.side === "yes" ? "yes" : body.side === "no" ? "no" : null;
      if (!side) return res.status(400).json({ error: "side must be 'yes' or 'no'" });

      const name = cleanName(body.name) || "anon";
      const entry = JSON.stringify({ n: name, s: side, t: Date.now() });

      const out = await pipeline([
        ["INCR", side === "yes" ? K_YES : K_NO],
        ["LPUSH", K_RECENT, entry],
        ["LTRIM", K_RECENT, "0", String(RECENT_MAX - 1)],
        ["GET", K_YES],
        ["GET", K_NO],
        ["LRANGE", K_RECENT, "0", String(RECENT_MAX - 1)],
      ]);

      return res.status(200).json({
        configured: true,
        yes: (parseInt(out[3].result, 10) || 0) + SEED_YES,
        no: (parseInt(out[4].result, 10) || 0) + SEED_NO,
        recent: parseRecent(out[5].result),
      });
    }

    // GET — current state
    const out = await pipeline([
      ["GET", K_YES],
      ["GET", K_NO],
      ["LRANGE", K_RECENT, "0", String(RECENT_MAX - 1)],
    ]);

    return res.status(200).json({
      configured: true,
      yes: (parseInt(out[0].result, 10) || 0) + SEED_YES,
      no: (parseInt(out[1].result, 10) || 0) + SEED_NO,
      recent: parseRecent(out[2].result),
    });
  } catch (e) {
    // store hiccup — let the client fall back to local rather than error out
    return res.status(200).json({ configured: false, yes: SEED_YES, no: SEED_NO, recent: [], error: "store_unavailable" });
  }
}
