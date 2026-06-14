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
const DAILY_LIMIT = 2;                          // free generations per device per day
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;      // 10 MB

// ---- PROMPTS (from VISUAL_RECIPES.md) ------------------------------------
const SYSTEM = `You are transforming an uploaded portrait into a member of the 1986 France national football team (the "Mexico 86" squad). CRITICAL RULES: Preserve the subject's facial identity, bone structure, skin tone, and expression exactly. Do NOT beautify, slim, or alter the face — keep it clearly recognizable. Only change hairstyle, facial hair, clothing, and background. Photoreal 1980s analog film look: slight grain, warm Kodachrome tones, soft flash. Square 1:1 head-and-shoulders framing like a 1986 team photo / Panini sticker. No text, no real-brand logos, no FIFA/FFF/Adidas marks — use a generic royal-blue football shirt. Output one clean image.`;

const PROMPTS = {
  homme: `${SYSTEM}
Transform this person into a 1986 France footballer.
HAIR: thick voluminous early-80s style — feathered on top with a curly/permed mullet, longer at the back, slightly sweat-damp as if mid-tournament in the Mexican heat.
FACIAL HAIR: a bushy 1980s mustache, density adapted to look natural on this face.
KIT: a plain royal-blue 1980s football shirt with a simple white collar and thin red-and-white shoulder trim, vintage matte fabric, no branding.
BACKGROUND: a sun-drenched 1986 stadium pitch, slightly faded, shallow depth of field.
MOOD: proud, squinting slightly into bright sunlight, classic team-photo posture.`,

  femme: `${SYSTEM}
Transform this person into an iconic mid-1980s glamour portrait, styled as a France '86 superfan of the era.
HAIR: big voluminous 1980s permed hair — full body, soft curls, height and volume, feathered fringe, the quintessential 80s blowout, slightly windswept.
MAKEUP: subtle period 80s makeup (warm blush, soft eye), tasteful and natural on the subject's real features. Do NOT change face shape or identity.
OUTFIT: a plain royal-blue 80s football shirt or blue supporter top with a white collar, optional thin red-white-blue trim, vintage matte fabric, no branding.
BACKGROUND: a sun-drenched 1986 stadium, faded, shallow depth of field.
MOOD: confident, glamorous, smiling, classic 80s portrait energy.`
};

// ---- HELPERS --------------------------------------------------------------
const cors = {
  "Access-Control-Allow-Origin": "*",                  // tighten to https://bleus86.fr in prod
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

      const prompt = PROMPTS[look] || PROMPTS.homme;
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
