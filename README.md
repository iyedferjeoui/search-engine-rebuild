# 🔍 Search Engine — Reverse Engineered, Then Rebuilt

I observed a real product's search API with [REA](https://github.com/morluto/rea) (Reverse Engineer Anything),
then rebuilt it from scratch with an AI agent — one Node file, zero dependencies.

## Demo

🚀 **Live: https://search-engine-rebuild.onrender.com**

(Takes ~30 s to wake on the free tier.)

```powershell
node server.mjs          # http://127.0.0.1:8130  (press Ctrl+K in the page)
node test/api.test.mjs   # 17/17 tests
```

## Features

- 🔤 **Letter-by-letter search** — type `c`, then `ca`, then `cach`… results narrow as you type
- 🩹 **Typo tolerance** — `kafke` finds Kafka, `cachin` finds Caching
- 🌐 **Global search** — one endpoint, every content type, live tab counts
- 📖 **Lesson reader** — click any result to open a full article
- ⌨️ **Keyboard shortcuts** — `Ctrl+K`, arrows, `Enter`, `Esc`

## How it works

```
query → tokenize → index → BM25 → fuzzy + prefix expansion → fusion → hits
```

## How REA was used

A browser capture recorded the real site's `Ctrl+K` palette and its `/trpc/search` endpoint.
The captured response showed: one global endpoint, a `{hits, found, out_of}` contract, and a
ranking where score and order disagree — so the rebuild uses two-stage fusion to match it.
Every fact from evidence vs. my guess is labeled in the code comments.

## Vibe coding

All of this was built by prompting an AI agent and testing its output — code → test → review → repeat.
The 17 tests are what keep the generated code honest.

## Deploy

```bash
node server.mjs         # Render: just set this as the start command
docker run -p 8130:8130 search-rebuild   # or use the included Dockerfile
```

## Files

| File | Purpose |
|---|---|
| `server.mjs` | the whole engine |
| `data/docs.json` | 44 documents |
| `public/index.html` | the Ctrl+K UI |
| `test/api.test.mjs` | 17 tests |

⭐ if you learned something.
