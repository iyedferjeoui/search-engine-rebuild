// A small, explainable search engine that mirrors the shape of
// hellointerview.com's observed `/trpc/search/query` contract:
//
//   { hits: [...], found: n, out_of: n }
//
// but keeps the pipeline readable: tokenize -> inverted index -> BM25 ->
// fuzzy expansion -> reciprocal-rank fusion -> response.

import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = JSON.parse(readFileSync(path.join(HERE, "data", "docs.json"), "utf8"));

// ---------------------------------------------------------------------------
// 1. text analysis
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  "a an and are as at be by for from how in into is it its of on or that the this to vs what when where which who why with your you".split(" ")
);

export function stem(word) {
  let w = word;
  if (w.length > 4) w = w.replace(/(ing|ed|es|er|s)$/, "");
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  const raw = String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  return raw.filter((t) => !STOPWORDS.has(t) && t.length > 1).map(stem);
}

// ---------------------------------------------------------------------------
// 2. index build
// ---------------------------------------------------------------------------

const FIELD_WEIGHTS = { title: 3, tags: 2.5, blurb: 1 };

function fieldCounts(doc, field) {
  const value = field === "tags" ? (doc.tags || []).join(" ") : doc[field] || "";
  const counts = new Map();
  for (const t of tokenize(value)) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

export function buildIndex(docs) {
  const postings = new Map(); // term -> Map(docId -> weighted tf)
  const docLen = new Map();
  const vocab = new Set();
  const df = new Map();

  for (const doc of docs) {
    let len = 0;
    const perDoc = new Map(); // term -> weighted tf
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      for (const [term, count] of fieldCounts(doc, field)) {
        perDoc.set(term, (perDoc.get(term) || 0) + count * weight);
      }
    }
    for (const [term, wtf] of perDoc) {
      if (!postings.has(term)) postings.set(term, new Map());
      postings.get(term).set(doc.id, wtf);
      df.set(term, (df.get(term) || 0) + 1);
      vocab.add(term);
      len += wtf;
    }
    docLen.set(doc.id, len);
  }

  const avgdl = [...docLen.values()].reduce((a, b) => a + b, 0) / (docs.length || 1);
  return { docs, postings, docLen, avgdl, vocab: [...vocab], df, N: docs.length };
}

const INDEX = buildIndex(DOCS);

// ---------------------------------------------------------------------------
// 3. BM25
// ---------------------------------------------------------------------------

const K1 = 1.2;
const B = 0.75;

function idf(term) {
  const n = INDEX.df.get(term) || 0;
  return Math.log(1 + (INDEX.N - n + 0.5) / (n + 0.5));
}

export function bm25(terms) {
  const scores = new Map();
  for (const term of terms) {
    const postings = INDEX.postings.get(term);
    if (!postings) continue;
    const weight = idf(term);
    for (const [docId, tf] of postings) {
      const len = INDEX.docLen.get(docId) || 1;
      const denom = tf + K1 * (1 - B + (B * len) / INDEX.avgdl);
      const s = weight * ((tf * (K1 + 1)) / denom);
      scores.set(docId, (scores.get(docId) || 0) + s);
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// 4. fuzzy expansion (handles "cachin" -> "cach")
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

export function fuzzyMatches(term) {
  if (term.length < 4) return [];
  const out = [];
  for (const candidate of INDEX.vocab) {
    if (candidate === term) continue;
    const prefix = candidate.startsWith(term) || term.startsWith(candidate);
    const distance = levenshtein(term, candidate);
    const similarity = 1 - distance / Math.max(term.length, candidate.length);
    if (prefix || similarity >= 0.72) {
      out.push({ term: candidate, similarity: prefix ? Math.max(similarity, 0.8) : similarity });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, 8);
}

// ---------------------------------------------------------------------------
// 4a. prefix matching (letter-by-letter: "c" -> "ca" -> "cach" -> "caching")
// ---------------------------------------------------------------------------

// When a query term is shorter than a full vocabulary word — typical of
// typing letter by letter — expand it to vocabulary words that start with
// it, ranked by document frequency (common words first, like a trie root).
export function prefixMatches(term) {
  if (!term) return [];
  const out = [];
  for (const candidate of INDEX.vocab) {
    if (candidate === term || !candidate.startsWith(term)) continue;
    out.push({ term: candidate, similarity: 0.9, df: INDEX.df.get(candidate) || 0 });
  }
  return out.sort((a, b) => (b.similarity - a.similarity) || (b.df - a.df)).slice(0, 10);
}

// ---------------------------------------------------------------------------
// 5. query pipeline
// ---------------------------------------------------------------------------

const RRF_K = 60;

function rank(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([id], i) => [id, i + 1]);
}

function fuse(lists) {
  const fused = new Map();
  for (const list of lists) {
    for (const [docId, position] of list) {
      fused.set(docId, (fused.get(docId) || 0) + 1 / (RRF_K + position));
    }
  }
  return fused;
}

export function search(query, limit = 20) {
  const started = performance.now();
  const terms = tokenize(query);
  // letter-by-letter queries like "c" or "ca" produce no full tokens, so an
  // early return here would kill them before prefix expansion can help
  const hasLetters = /[a-z0-9]/.test(String(query || "").toLowerCase());
  if (!terms.length && !hasLetters) {
    return { hits: [], found: 0, out_of: 0, terms };
  }

  // lexical pass needs the tokenizer's full tokens; letter-by-letter queries
  // shorter than two characters are invisible to it, so recover them raw
  const letters = String(query || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  const shortTerms = terms.length
    ? []
    : letters
        .filter((t) => !STOPWORDS.has(t))
        .map(stem)
        .filter((t) => !terms.includes(t));

  // exact lexical pass
  const lexical = bm25(terms);

  // fuzzy + prefix pass: expand only terms the index does not know as-is
  const unknowns = [
    ...terms.filter((t) => !INDEX.postings.has(t)),
    ...shortTerms,
  ];
  const expanded = [];
  const expansions = [];
  for (const term of unknowns) {
    // letter-by-letter first: a partial word still retrieves via vocabulary prefixes
    const candidates = term.length >= 4 ? fuzzyMatches(term) : [];
    const prefixes = prefixMatches(term);
    const seen = new Set(candidates.map((m) => m.term));
    for (const m of prefixes) if (!seen.has(m.term)) { seen.add(m.term); candidates.push(m); }
    for (const m of candidates) {
      expanded.push(m.term);
      expansions.push({ from: term, to: m.term, similarity: Number(m.similarity.toFixed(2)) });
    }
  }
  const fuzzy = expanded.length ? bm25(expanded) : new Map();

  // reciprocal-rank fusion of the two retrievers
  const fused = fuse([rank(lexical), rank(fuzzy)]);

  // bonuses: whole-query phrase, editorial priority
  const normalizedQuery = terms.join(" ");
  const phraseBonus = new Map(); // docId -> 1 (title) | 0.3 (blurb) | 0
  for (const doc of INDEX.docs) {
    const title = tokenize(doc.title).join(" ");
    const blurb = tokenize(doc.blurb).join(" ");
    if (title.includes(normalizedQuery)) phraseBonus.set(doc.id, 1);
    else if (blurb.includes(normalizedQuery)) phraseBonus.set(doc.id, 0.3);
  }

  // BM25 magnitude must survive RRF: fused ranks only encode *position*, so a
  // dominant hit (huge idf) would otherwise tie with a weak one.
  const maxLex = Math.max(0, ...lexical.values()) || 1;

  const ranked = [...fused.entries()]
    .map(([docId, rrf]) => {
      const lexRatio = (lexical.get(docId) || 0) / maxLex;
      return {
        docId,
        final:
          rrf +
          0.15 * lexRatio + // relevance strength (BM25-shaped signal)
          0.05 * (phraseBonus.get(docId) || 0) + // exact-phrase nudge
          0.002 * (INDEX.docs.find((d) => d.id === docId)?.priority || 0), // editorial nudge
      };
    })
    .sort((a, b) => b.final - a.final)
    .slice(0, Math.min(Math.max(1, Number(limit) || 20), 50));

  const hits = ranked.map(({ docId, final }) => {
    const doc = INDEX.docs.find((d) => d.id === docId);
    const lexScore = lexical.get(docId) || 0;
    return {
      id: doc.id,
      slug: doc.slug,
      path: doc.path,
      title: doc.title,
      blurb: doc.blurb,
      tier: doc.tier,
      tags: doc.tags,
      priority: doc.priority,
      type: doc.type,
      // displayed relevance is the lexical signal only — ordering uses the
      // fused rank, which is why the two can disagree (as the real API does).
      score: Number((lexScore / (lexScore + 6)).toFixed(4)),
      signals: {
        lexical: Number(lexScore.toFixed(3)),
        fused: Number(final.toFixed(4)),
        phrase: (phraseBonus.get(docId) || 0) > 0,
        priorityBoost: 0.002 * (doc.priority || 0),
      },
    };
  });

  return {
    hits,
    found: hits.length,
    out_of: hits.length, // the observed API reports the page, not the corpus
    tookMs: Number((performance.now() - started).toFixed(2)),
    terms,
    expansions,
  };
}

// ---------------------------------------------------------------------------
// 5a. lesson bodies — one click from a hit should actually open something
// ---------------------------------------------------------------------------

function lessonBody(doc) {
  const kind = doc.tags?.[0] || "CONTENT";
  const t = doc.title;
  if (kind === "SYSTEM_DESIGN") {
    const isDesign = /^design /i.test(t);
    const subject = t.replace(/^Design (an?|the) /i, "").replace(/[?.!]$/, "");
    const ask = isDesign
      ? `who uses a ${subject.toLowerCase()}, and what must it guarantee?`
      : `what does ${t.toLowerCase()} have to serve, and what must it guarantee?`;
    return [
      { h: "Requirements", p: `Before drawing any boxes: ${ask} State the read/write split, the consistency you refuse to give up, and the latency you promise. ${t} is graded on exactly those three declarations.` },
      { h: "Back-of-envelope", p: "Assume about one hundred million operations per day — roughly 1,200 requests per second, with reads outnumbering writes around 10:1. Multiply storage by 5 for replication, halve it for compression, and say every number out loud: the estimate itself is a deliverable." },
      { h: "Core design", p: doc.blurb },
      { h: "Trade-offs the interviewer will push on", p: "Strong consistency costs availability exactly when the network disagrees. A cache costs staleness. A queue costs a second copy of the truth. Name what this design gives up first, then defend why that is acceptable here — silence is what fails the round." },
    ];
  }
  if (kind === "CODING") {
    return [
      { h: "Pattern overview", p: doc.blurb },
      { h: "The template", p: `Recognise the shape, then reach for the standard skeleton: define the state (${t.split(" ")[0].toLowerCase()} level), write the transition in one plain-English sentence, and only then translate it into code. Most solutions fail at the state definition, not the syntax.` },
      { h: "Complexity", p: "Say both bounds and why: the time bound comes from the state space, the space bound from what you keep alive. If a naive solution is quadratic, say so, then show the reduction." },
      { h: "Pitfalls", p: "Off-by-one bounds, forgetting the empty input, and testing only the happy path. Interviewers add one adversarial case on purpose — narrate your handling of it before they ask." },
    ];
  }
  if (kind === "COMMUNITY") {
    return [
      { h: "The loop", p: `${t} typically pair two design discussions with one code round. Recent reports describe a 45-minute design session that begins with a one-liner prompt and grows via follow-up questions.` },
      { h: "What they score", p: doc.blurb },
      { h: "How to prepare", p: `Drill two or three of their repeated problems end to end, practise stating trade-offs before being asked, and keep a notes file of the follow-up questions each loop produced.` },
    ];
  }
  // features and anything else
  return [
    { h: "What you get", p: doc.blurb },
    { h: "How it fits your prep", p: `${t} slots into a weekly cycle: learn a concept, drill it timed, then verify it in a mock. Use it between design sessions rather than in place of them.` },
    { h: "Access", p: `This is ${doc.tier === "PREMIUM" ? "part of the paid tier" : "free to use"} — the tier badge in search results reflects the same gate the real product applies.` },
  ];
}

// ---------------------------------------------------------------------------
// 6. HTTP
// ---------------------------------------------------------------------------

const PUBLIC = path.join(HERE, "public");

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") || "";
      const limit = url.searchParams.get("limit") || "20";
      if (!q.trim()) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "q is required" }));
      }
      const result = search(q, limit);
      if (!url.searchParams.has("debug")) delete result.signals;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
      return res.end(JSON.stringify(result));
    }
    if (url.pathname === "/api/global") {
      // global search: one query over every content type — exactly what the
      // observed palette does with its single /trpc endpoint — plus explicit
      // group counts so the UI can show how results split across tabs.
      const q = url.searchParams.get("q") || "";
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 50);
      if (!q.trim()) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "q is required" }));
      }
      const result = search(q, limit);
      const groups = { content: 0, community: 0, feature: 0 };
      for (const h of result.hits) if (h.type in groups) groups[h.type]++;
      const { tookMs, ...payload } = result;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
      return res.end(JSON.stringify({ ...payload, groups, tookMs }));
    }
    if (url.pathname === "/api/lesson") {
      const id = url.searchParams.get("id");
      const doc = INDEX.docs.find((d) => d.id === id);
      if (!doc) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unknown lesson" }));
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
      return res.end(JSON.stringify({ ...doc, body: lessonBody(doc) }));
    }
    if (url.pathname === "/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        docs: INDEX.N,
        terms: INDEX.vocab.length,
        postings: [...INDEX.postings.values()].reduce((a, m) => a + m.size, 0),
        avgDocLength: Number(INDEX.avgdl.toFixed(2)),
      }));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(path.join(PUBLIC, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8130);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`search demo on http://127.0.0.1:${port}`);
  });
}

export { INDEX };
