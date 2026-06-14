# Bleus 86 — Deployment (browser-only, no terminal)

This repo deploys to Cloudflare Workers automatically via GitHub.

## Structure
- `public/index.html` — the website (served as static assets)
- `worker.js` — backend: adds `/api/generate` (calls Gemini), serves the site
- `wrangler.toml` — tells Cloudflare how to build/deploy

## One-time setup (all in the browser)

### 1. Put this repo on GitHub
- Create a free account at github.com if needed.
- Create a new repository named `bleus86` (Public or Private both fine).
- Upload these files keeping the structure:
  `public/index.html`, `worker.js`, `wrangler.toml`, `README.md`.

### 2. Connect the repo to Cloudflare
- Cloudflare dashboard → Workers & Pages → Create → Connect to Git.
- Select your `bleus86` repo. Cloudflare reads `wrangler.toml` and deploys.

### 3. Create the KV namespace + paste its ID
- Cloudflare → Storage & Databases → KV → Create namespace → name `bleus86-rate`.
- Copy its ID.
- Edit `wrangler.toml` on GitHub → replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`
  with that ID → commit. Cloudflare redeploys automatically.

### 4. Add the Gemini secret
- Get a key at aistudio.google.com/apikey.
- Cloudflare → your Worker → Settings → Variables and Secrets → Add →
  Type: Secret, Name: `GEMINI_API_KEY`, Value: your key. Save.
  (This section is now available because the project has a real Worker.)

### 5. Point your domain
- Once bleus86.fr is Active in Cloudflare, attach it to this Worker under
  Domains → Connect domain.

Done. Visit your site → upload → generate.
