# 🔍 Search Engine — Reverse Engineered, Then Rebuilt

A tiny, explainable search engine built by **reverse engineering a real product's search API**
(the hellointerview.com command palette) with the [REA — Reverse Engineer Anything](https://github.com/morluto/rea)
methodology and agent, then **vibe-coding** the whole engine from scratch in one dependency-free file.

```powershell
node server.mjs          # http://127.0.0.1:8130  (press Ctrl+K in the page)
node test/api.test.mjs   # 17/17 tests
```

**Zero npm dependencies.** Pure Node (`node:http`), one server file, static frontend.

---

## What it does

A **Ctrl+K command palette** over a BM25 index, like every modern product's global search:

| Feature | Try it |
|---|---|
| 🔤 **Letter-by-letter live search** | type just `c`, then `ca`, then `caf`… results narrow per keystroke |
| 🩹 **Typo tolerance** | `cachin` → Caching · `kafke` → Kafka · `cassndra` → Cassandra |
| 🌐 **Global search** | one endpoint over every content type + live per-tab counts |
| 📖 **Lesson reader** | click any result → a full generated listening/article page opens |
| ⌨️ **Keyboard-first** | `Ctrl+K` open · `↑↓` navigate · `↵` open · `esc` back |

## How REA was used

Following the [REA five-stage framework](https://github.com/morluto/rea), a browser-scenario
capture observed the real site's palette and its `/trpc/search/query` endpoint:

**Observed (captured evidence):**
- the contract: `GET /trpc/search/query → { hits, found, out_of }`
- one **global** endpoint — all content types in a single response; tabs are client-side filters
- the displayed `score` is only one signal — a 0.54-scored hit ranked behind a 0.514 hit,
  implying a two-stage pipeline (fused ranking)

**Reconstructed (inference, honestly labeled in the code):**
- the fuzzy fallback that makes `cachin` work
- per-keystroke latency behavior

## How this engine works

```
query ─► tokenize/stem ─► inverted index ─► BM25 (lexical)
       └─────────► prefix expansion (letter-by-letter: c → cach → caching)
       └─────────► fuzzy expansion (typo tolerance: kafke → kafka)
  └──► reciprocal-rank fusion ─► phrase + priority boosts ─► hits
```

One readable score, one fused rank — exactly the mismatch the real API showed.

## Vibe coding

This was built **conversationally with an AI agent** (vibe coding style) — prompts →
code → test → review → repeat. Nothing was hand-typed from memory; the loop was:
*the REA agent captured evidence → the coding agent rebuilt the ideas → 17 contract tests
check every claim*. Every observed fact vs. inference is labeled in the code comments.

## Deploy it

```bash
# Render (free): push this repo → "New Web Service" → start command:
node server.mjs          # + health check path /stats

# Fly.io (uses the included Dockerfile):
fly launch && fly deploy

# Docker anywhere:
docker build -t search-rebuild . && docker run -p 8130:8130 search-rebuild
```

## Files

```
server.mjs              tokenizer → index → BM25 → fuzzy/prefix → RRF fusion → HTTP
data/docs.json          44 seeded documents
public/index.html       the command palette UI (tabs, keyboard, lessons)
test/api.test.mjs       17 contract + behavior tests (17/17 ✅)
Dockerfile              for Fly.io / any container host
```

## Limits

A study rebuild from **public** responses captured on one day. It does not claim to
reproduce the site's real ranking service — the corpus is seeded, the fuzzy pass is a
readable approximation, and the lesson bodies are generated (clearly, not secretively).

Built with the REA agent + vibe coding. ⭐ if you learned something.

---

*Observed: 44 docs · 400 terms · 17/17 tests · 0 dependencies · <3 MB of code+data.*
