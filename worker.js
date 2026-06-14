/**
 * BLEUS 86 — Image generation backend (Cloudflare Worker)
 * --------------------------------------------------------
 * POST /api/generate   (multipart/form-data: photo=<file>, look=homme|femme)
 *   -> { imageUrl: "data:image/png;base64,..." }
 *
 * Secrets / vars needed (set in Cloudflare dashboard, see SETUP at bottom):
 *   GEMINI_API_KEY   (secret)  — your Google AI Studio key
 *   RATE_LIMIT_KV    (KV binding, optional) — enables 2/day per-device limit
 *
 * The same Worker also serves your static index.html (it's already deployed
 * as static assets), so you only need to ADD this fetch handler logic.
 */

// ---- CONFIG ---------------------------------------------------------------
const MODEL = "gemini-2.5-flash-image";       // swap to a newer image model here if desired
const DAILY_LIMIT = 100;                          // free generations per device per day
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;      // 10 MB

// ---- PROMPTS --------------------------------------------------------------
// Shared rules. Note the deliberate "spice": we EXAGGERATE the 1980s STYLING
// (hair volume, mustache, sweaty glow) for comedic/viral effect, while keeping
// the FACE strictly recognizable — distorting the face is what makes these
// tools feel creepy and kills shares, so we never touch it.
const SYSTEM = `You are transforming an uploaded portrait into a member of the 1986 France national football team (the "Mexico 86" squad), in the style of a vintage Panini sticker card.
CRITICAL RULES:
- Preserve the subject's facial identity, bone structure, skin tone, and expression EXACTLY. Keep the face clearly recognizable — do NOT beautify, slim, age, or distort it.
- You MAY exaggerate the 1980s STYLING for comedic effect: bigger hair, bolder mustache, glossier sweaty sun-glow, more saturated retro colors. Push the era hard. Never push the face.
- Only change hairstyle, facial hair, clothing, background, and add the caption described below.
- Photoreal 1980s analog film look: visible film grain, warm Kodachrome tones, slight soft flash, faded edges.
- Square 1:1 head-and-shoulders framing, like a 1986 Panini football sticker portrait.
- Use a generic royal-blue football shirt with a white collar and thin red-and-white shoulder trim. NO real-brand logos, NO FIFA/FFF/Adidas marks, no modern branding.`;

// Caption instruction appended last so the model burns the epithet into the image.
function captionRule(epithet) {
  return `
CAPTION: Across the BOTTOM of the image, add a clean vintage Panini-style caption banner with the exact text "${epithet}" in bold retro 1980s sticker lettering (white or gold text on a royal-blue strip). Spell it EXACTLY as written, correct French spelling, no other text anywhere else on the image.`;
}

// --- Male archetypes (one picked at random per generation for variety) -----
const MALE_STYLES = [
  // 1. The classic permed mullet + mustache
  `HAIR: thick voluminous permed MULLET — curly feathered volume on top, distinctly longer at the back, slightly sweat-damp from the Mexican heat. Push the volume for comedic 80s effect.
FACIAL HAIR: a big bushy 1980s mustache, adapted to look natural but generously full.`,
  // 2. The feathered "footballer flick" (no mullet) — tidier star-player look
  `HAIR: a glamorous mid-80s feathered hairstyle, parted, blow-dried with lots of body and a soft flick — the elegant "playmaker / star" look, not a mullet.
FACIAL HAIR: light designer stubble or a neat thin mustache, whichever suits the face.`,
  // 3. The tight curly perm / afro-perm — full-on 80s curls
  `HAIR: a big tight curly PERM / afro-perm, rounded high volume, the unmistakable 80s footballer curls, slightly damp and bouncy.
FACIAL HAIR: a full horseshoe 1980s mustache, bold and proud.`,
];

// --- Female archetypes ------------------------------------------------------
const FEMALE_STYLES = [
  `HAIR: enormous voluminous 1980s permed hair — full body, soft bouncy curls, big height and volume, feathered fringe, the quintessential 80s blowout, slightly windswept. Push the volume for fun 80s drama.
MAKEUP: tasteful period 80s makeup (warm blush, soft eye), natural on the subject's real features. Do NOT change face shape.`,
  `HAIR: a big crimped/teased 80s style with feathered bangs and lots of height, bold and glamorous but tasteful.
MAKEUP: subtle warm 80s tones, natural on the subject's real features. Do NOT change face shape.`,
];

const SCENE = `
KIT: a plain royal-blue 1980s football shirt with a white collar and thin red-and-white shoulder trim, vintage matte fabric.
BACKGROUND: a sun-drenched 1986 stadium pitch, slightly faded, shallow depth of field.
MOOD: proud, confident, squinting slightly into bright sunlight, classic team-photo posture.`;

// --- Epithets: catchy 1986-flavored player nicknames, picked at random ------
// Tied to the real archetypes of that France side (the "carré magique" midfield,
// the libero, the poacher, the keeper, the hard man, etc.) — kept generic, no real names.
const EPITHETS = [
  "LE MAESTRO",
  "LE GÉNÉRAL DU MILIEU",
  "LE ROC DE LA DÉFENSE",
  "LE RENARD DES SURFACES",
  "LE MÉTRONOME",
  "LE LIBÉRO DE LÉGENDE",
  "LE DERNIER REMPART",
  "LE FEU FOLLET",
  "LE PATRON",
  "LA GÂCHETTE",
  "LE CHEF D'ORCHESTRE",
  "LE MUR INFRANCHISSABLE",
  "LE NUMÉRO 10 DE RÊVE",
  "LE TANK DU COULOIR",
  "LA TERREUR DES ATTAQUANTS",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Build a full prompt for a given look, with a random style + random epithet.
function buildPrompt(look) {
  const epithet = pick(EPITHETS);
  if (look === "femme") {
    return `${SYSTEM}
Transform this person into an iconic mid-1980s France '86 portrait.
${pick(FEMALE_STYLES)}
OUTFIT: a royal-blue 80s football shirt or blue supporter top with a white collar and thin red-white trim, vintage matte fabric.
BACKGROUND: a sun-drenched 1986 stadium, faded, shallow depth of field.
MOOD: confident, glamorous, smiling, classic 80s portrait energy.${captionRule(epithet)}`;
  }
  // default: homme
  return `${SYSTEM}
Transform this person into a 1986 France footballer.
${pick(MALE_STYLES)}${SCENE}${captionRule(epithet)}`;
}

// ---- HELPERS --------------------------------------------------------------
const cors = {
  "Access-Control-Allow-Origin": "https://bleus86.fr",                  // tighten to https://bleus86.fr in prod
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function todayKey(request) {
  // device-ish identifier: IP + UA. Not bulletproof, fine for a fun MVP.
  const ip = request.headers.get("CF-Connecting-IP") || "0";
  const ua = request.headers.get("User-Agent") || "0";
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `rl:${day}:${ip}:${ua}`.slice(0, 480);
}

// ---- MAIN HANDLER ---------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only intercept the API path; everything else falls through to static assets.
    if (url.pathname !== "/api/generate") {
      // env.ASSETS is the static-assets binding Cloudflare adds for uploaded sites.
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);

    try {
      // ---- rate limit (only if KV is bound) ----
      if (env.RATE_LIMIT_KV) {
        const key = todayKey(request);
        const count = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
        if (count >= DAILY_LIMIT) {
          return json({ error: "limit", message: `Tu as atteint ta limite de ${DAILY_LIMIT} looks par jour. Reviens demain ! ⚽` }, 429);
        }
      }

      // ---- parse upload ----
      const form = await request.formData();
      const photo = form.get("photo");
      const look = (form.get("look") || "homme").toString();
      if (!photo || typeof photo === "string") return json({ error: "Aucune photo reçue." }, 400);
      if (photo.size > MAX_UPLOAD_BYTES) return json({ error: "Photo trop lourde (max 10 Mo)." }, 400);

      const prompt = buildPrompt(look);
      const buf = await photo.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      const mime = photo.type || "image/jpeg";

      // ---- call Gemini ----
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
      const gemRes = await fetch(endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: b64 } },
          ]}],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
      });

      if (!gemRes.ok) {
        const errTxt = await gemRes.text();
        console.log("Gemini error:", gemRes.status, errTxt);
        return json({ error: "Le générateur est surchargé, réessaie dans quelques secondes." }, 502);
      }

      const data = await gemRes.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(p => p.inline_data || p.inlineData);
      const inline = imgPart?.inline_data || imgPart?.inlineData;
      if (!inline?.data) {
        console.log("No image in response:", JSON.stringify(data).slice(0, 800));
        return json({ error: "Génération impossible avec cette photo, essaie-en une autre." }, 502);
      }

      // ---- success: increment limit + return image ----
      if (env.RATE_LIMIT_KV) {
        const key = todayKey(request);
        const count = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
        await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 60 * 60 * 26 }); // ~26h
      }

      const outMime = inline.mime_type || inline.mimeType || "image/png";
      return json({ imageUrl: `data:${outMime};base64,${inline.data}` });

    } catch (err) {
      console.log("Worker error:", err.message);
      return json({ error: "Une erreur est survenue, réessaie." }, 500);
    }
  }
};

/* ============================================================
   SETUP (one-time, in Cloudflare dashboard)
   ------------------------------------------------------------
   1. Get a Gemini API key: https://aistudio.google.com/apikey
   2. Your Worker project -> Settings -> Variables and Secrets:
        Add secret  GEMINI_API_KEY = <your key>   (type: Secret)
   3. (Optional but recommended) enable the 2/day limit:
        - Storage & Databases -> KV -> Create namespace "bleus86-rate"
        - Worker -> Settings -> Bindings -> Add -> KV namespace
              Variable name: RATE_LIMIT_KV   Namespace: bleus86-rate
        (If you skip this, generation still works with no limit.)
   4. Make sure the static-assets binding exists (it does, since you
      uploaded index.html). Its binding name should be ASSETS.
   5. Re-deploy. Test:  https://bleus86.fr  -> upload -> generate.
   ============================================================ */
