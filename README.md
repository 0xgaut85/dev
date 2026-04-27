# Crunchbase Lead Finder

A two-part system for prospecting leads from Crunchbase People search:

1. **Chrome extension** — scrapes the search results pages you visit while logged into your Crunchbase Pro account.
2. **Next.js dashboard** (hosted on Railway) — stores leads in Postgres, enriches photos via Face++ for inferred age/ethnicity, and lets you filter for "no X account" prospects to export for outreach.

## Repository layout

```
.
├── extension/      Chrome MV3 extension (Vite + TypeScript)
└── dashboard/      Next.js 15 app (App Router + Prisma + Postgres)
```

## ⚠️ Important caveats

- **Crunchbase ToS**: automated reading is technically prohibited. Risk is account suspension, not legal action — use a secondary CB Pro account.
- **Crunchbase Pro (~€49/mo) is required** for usable search filters and pagination.
- **Face++ ethnicity classes**: `WHITE / BLACK / ASIAN / INDIA`. Geography-agnostic visual classifier.
- **Data minimization**: enrichment results auto-purge after `RETENTION_DAYS` (default 90).
- **GDPR**: hosting prospect data with inferred ethnicity carries compliance considerations even if you don't target EU residents. Review with counsel before commercial use.

---

## 1. Deploy the dashboard to Railway

### a) Create services

1. Create a new Railway project.
2. Add the **Postgres** plugin (autoinjects `DATABASE_URL`).
3. Add a service from this repo, pointing it at the `dashboard/` directory (Settings → Root Directory).

### b) Set environment variables

| Var                 | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`      | Auto-set by the Postgres plugin                                    |
| `FACEPP_API_KEY`    | From [Face++ console](https://www.faceplusplus.com/)               |
| `FACEPP_API_SECRET` | From Face++ console                                                |
| `INGEST_TOKEN`      | Long random string. Paste the same value into the extension popup. |
| `DASHBOARD_PASSWORD`| Password for the dashboard UI login page.                          |
| `RETENTION_DAYS`    | Optional. Default `90`.                                            |
| `CLEANUP_TOKEN`     | Long random string. Used by the cron service to call cleanup.      |

Generate tokens with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### c) Cron for retention cleanup

Add a Railway **Cron** service (or any external cron) to GET this URL daily:

```
https://<your-app>.up.railway.app/api/cleanup?token=$CLEANUP_TOKEN
```

### d) Deploy

Push to your repo. Nixpacks will run:

```
npm install
npx prisma generate
npx prisma migrate deploy
npm run build
npm run start
```

On first deploy you need to create the initial migration locally:

```bash
cd dashboard
echo 'DATABASE_URL="postgresql://..."' > .env
npx prisma migrate dev --name init
git add prisma/migrations
git commit -m "init migration"
git push
```

---

## 2. Build & install the Chrome extension

```bash
cd extension
npm install
npm run build
```

Then in Chrome:

1. `chrome://extensions` → enable **Developer mode**.
2. Click **Load unpacked** → select `extension/dist/`.
3. Pin the extension; click its icon to open the popup.
4. Fill in:
   - **API URL**: your Railway URL, e.g. `https://your-app.up.railway.app`
   - **API Token**: the `INGEST_TOKEN` you set on Railway
   - **Page delay**: `4500` (ms, jittered)
   - **Max pages**: `20` (hard cap is 50)
5. Click **Save settings**.

---

## 3. Workflow

1. Log into Crunchbase Pro in Chrome.
2. Build a People search with native filters:
   - **Industry**: include AI; exclude Finance, Banking, etc.
   - **CB Rank**: sort/filter to top 1–1000.
   - **Country**: US, ZA, AU, CA, UK — whatever you target.
   - **Job role**: Founder / CEO / etc.
3. Click the extension popup → **Auto-scrape N pages**. Watch the status box.
4. Open `https://<your-app>.up.railway.app`, log in.
5. Filter to **Has X = No**.
6. Select promising leads → **Enrich with Face++** (50 max per batch, ~$0.05).
7. Filter by **Ethnicity = WHITE**, **Min confidence = 0.7**, **Age range**.
8. Select results → **Export CSV** → import into your outreach tool.
9. Mark leads contacted to keep your pipeline clean.

---

## 4. API endpoints

All token-protected endpoints use `Authorization: Bearer <INGEST_TOKEN>`.

| Method | Path                      | Auth        | Purpose                              |
| ------ | ------------------------- | ----------- | ------------------------------------ |
| POST   | `/api/ingest`             | Bearer      | Upsert scraped leads (used by ext.)  |
| POST   | `/api/enrich`             | Bearer      | Run Face++ on selected lead IDs      |
| POST   | `/api/enrich-ui`          | Cookie      | Same, called from dashboard UI       |
| POST   | `/api/outreach`           | Cookie      | Set outreach status                  |
| GET    | `/api/cleanup?token=...`  | Query token | Purge old enrichments + stale leads  |
| POST   | `/api/login`              | —           | Dashboard login                      |

---

## 5. Updating Crunchbase selectors

Crunchbase ships markup changes ~quarterly. When scraping breaks, update only one file:

```
extension/src/selectors.ts
```

Then `npm run build` and reload the extension.

---

## 6. Cost estimate

- Railway Hobby: ~$5/mo (Next.js + Postgres at this scale)
- Face++: free 1000 calls/day in QPS-limited mode; paid ~$0.001/call
- Crunchbase Pro: ~€49/mo
