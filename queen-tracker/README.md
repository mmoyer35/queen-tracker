# 🐝👑 Queen Tracker

A private web app for logging and tracking queen bees you rear (by grafting, cells, splits, or purchase). Record hives, laying pattern, genetics, and lifecycle; attach photos; and visualize **lineage across years** as an interactive family tree or a collapsible list.

Your data and photos live in your own free **Supabase** project and sync across every device you sign in on. The app itself is static files, hosted free on **GitHub Pages**.

---

## What you can track

- **Core rearing** — queen code, name, source method (grafting / cell / split / swarm / purchased), graft & emergence dates, year, season, **mother queen** (for lineage), drone source.
- **Hive & performance** — current hive, mated status, mating date, and 1–5 ratings for laying pattern, brood quality, temperament, honey production.
- **Genetics & traits** — race/line, marking color, hygienic behavior, mite resistance, notable traits.
- **Status & lifecycle** — alive / dead / superseded / requeened / sold / lost / banked, status date, "replaced by" link, notes.
- **Photos** — multiple per queen, stored privately in the cloud.
- **Timeline** — dated inspection/observation entries per queen.
- **Lineage** — interactive tree (grouped by year) + collapsible list, toggle between them.
- **Overview** — totals and queens-reared-by-year chart.
- **Export** — download all data as JSON or CSV anytime.

---

## One-time setup (about 10 minutes)

### 1. Create a free Supabase project
1. Go to **https://supabase.com** → sign up (free, no credit card).
2. Click **New project**. Give it a name (e.g. `queen-tracker`), set a database password (save it somewhere), pick a region near you, and create it. Wait ~2 minutes for it to finish provisioning.

### 2. Create the database tables
1. In your project, open **SQL Editor** (left sidebar) → **New query**.
2. Open the file [`supabase/schema.sql`](supabase/schema.sql) from this repo, copy **all** of it, paste into the editor, and click **Run**.
3. You should see "Success. No rows returned." This created your tables, security rules, and the private photo storage bucket.

### 3. Get your API keys
1. Go to **Project Settings** (gear icon) → **API**.
2. Copy the **Project URL** and the **anon / public** key.
   - The `anon` key is safe to put in the app — your data is protected by row-level security. **Never** use the `service_role` key here.

### 4. Add your keys to the app
Edit [`js/config.js`](js/config.js) and replace the two placeholders:

```js
window.QUEEN_TRACKER_CONFIG = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",   // your Project URL
  SUPABASE_ANON_KEY: "eyJhbGciOi...",              // your anon public key
};
```

You can edit this file directly on GitHub (open the file → pencil icon → paste → commit), or locally and push.

### 5. Turn on GitHub Pages (free hosting)
1. In the GitHub repo → **Settings** → **Pages**.
2. Under *Build and deployment* → *Source*, choose **Deploy from a branch**.
3. Branch: **main**, folder: **/ (root)** → **Save**.
4. Wait a minute; GitHub shows your live URL, e.g. `https://mmoyer35.github.io/queen-tracker/`. Bookmark it on your phone and computer.

### 6. Create your login
1. Open the live URL. You'll see a sign-in screen.
2. Click **"New here? Create an account"**, enter your email + a password (6+ chars), and submit.
   - Supabase may send a confirmation email depending on your project settings. If sign-in says "email not confirmed," either click the link in that email, or in Supabase go to **Authentication → Providers → Email** and turn **Confirm email** off for a solo/simple setup.
3. Sign in. You're ready to add queens. 🐝

> Signing in with the same email/password on your phone gives you the same data — that's your cloud sync.

---

## Running it locally (optional)

Because the app uses ES modules only via CDN and plain scripts, you can just open it with any static server:

```bash
# from the project folder
python3 -m http.server 8000
# then visit http://localhost:8000
```

(Opening `index.html` directly as a `file://` may work, but a local server avoids browser quirks.)

---

## Project structure

```
queen-tracker/
├── index.html              # the whole UI
├── js/
│   ├── config.js           # <-- your Supabase URL + anon key go here
│   ├── config.example.js   # template
│   ├── supabaseClient.js   # Supabase init + data access
│   ├── app.js              # app logic (auth, CRUD, list, detail, stats, export)
│   └── lineage.js          # tree + list lineage rendering
├── supabase/
│   └── schema.sql          # run once in Supabase SQL editor
└── README.md
```

## Privacy & cost

- **Free.** Supabase free tier and GitHub Pages both cost nothing for this scale.
- **Private.** Row-level security means only *your* logged-in account can read/write your queens and photos. Even though the repo can be public, your data is not in the repo — it's in your Supabase project.
- **Portable.** Export to JSON/CSV whenever you want a backup.

## Troubleshooting

- **"One quick setup step" screen** → `js/config.js` still has placeholder values. Add your real keys.
- **Sign-in fails with "Email not confirmed"** → confirm via email, or disable email confirmation in Supabase (Authentication → Providers → Email).
- **Photos won't upload** → make sure step 2 (schema.sql) ran fully; it creates the `queen-photos` storage bucket and its policies.
- **Nothing loads / console errors about supabase** → check the Project URL and anon key are pasted correctly (no stray spaces or quotes).

---

Made for tracking a real apiary. Happy queen rearing! 🍯
