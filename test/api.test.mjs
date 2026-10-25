import assert from "node:assert/strict";
import { createServer } from "../server.mjs";
import { search, tokenize, stem } from "../server.mjs";

let base;

async function api(q, limit = 20) {
  const res = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  return { status: res.status, json: await res.json() };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("response mirrors the observed envelope", async () => {
  const { status, json } = await api("caching");
  assert.equal(status, 200);
  for (const k of ["hits", "found", "out_of"]) assert.ok(k in json, `missing ${k}`);
  assert.ok(Array.isArray(json.hits));
});

test("found and out_of report the page, not the corpus", async () => {
  const { json } = await api("caching", 5);
  assert.equal(json.found, 5);
  assert.equal(json.out_of, 5);
  assert.equal(json.hits.length, 5);
});

test("every hit carries the observed fields", async () => {
  const { json } = await api("caching");
  const h = json.hits[0];
  for (const k of ["id", "slug", "path", "title", "blurb", "tier", "tags", "priority", "type", "score"]) {
    assert.ok(k in h, `missing ${k}`);
  }
});

test("exact title match ranks first", async () => {
  const { json } = await api("rate limiter");
  assert.match(json.hits[0].title, /Rate Limiter/i);
});

test("typo tolerance: cachin still finds caching", async () => {
  const { json } = await api("cachin");
  assert.ok(json.hits.slice(0, 3).some((h) => /cach/i.test(h.title)));
});

test("score is a normalised 0..1 relevance", async () => {
  const { json } = await api("caching", 50);
  for (const h of json.hits) {
    assert.ok(h.score >= 0 && h.score <= 1, `score out of range: ${h.score}`);
  }
});

test("empty query is a 400", async () => {
  const { status } = await api("");
  assert.equal(status, 400);
});

test("stemming folds caching/cache/caches together", () => {
  assert.equal(stem("caching"), "cach");
  assert.equal(stem("cache"), "cach");
  assert.equal(stem("limiting"), "limit");
  assert.equal(stem("limiter"), "limit");
});

test("tokenizer drops stopwords", () => {
  assert.deepEqual(tokenize("How to design a system"), ["design", "system"]);
});

test("the index is populated", () => {
  const { json } = api("caching");
  void json; // placeholder; index stats checked via /stats below
});

test("stats reports a non-empty index", async () => {
  const res = await fetch(`${base}/stats`);
  const s = await res.json();
  assert.ok(s.docs >= 20);
  assert.ok(s.terms > 100);
  assert.ok(s.postings > 200);
});

test("letter-by-letter: a single letter still retrieves via prefix expansion", async () => {
  const { status, json } = await api("c", 10);
  assert.equal(status, 200);
  assert.ok(json.hits.length > 0, "no hits for a single letter");
});

test("letter-by-letter: partial word narrows to the real doc", async () => {
  const { json: partial } = await api("cach", 10);
  assert.ok(partial.hits.slice(0, 3).some((h) => /cach/i.test(h.title)));
});

test("global endpoint reports per-type group counts", async () => {
  const res = await fetch(`${base}/api/global?q=caching`);
  const g = await res.json();
  assert.equal(res.status, 200);
  for (const k of ["hits", "found", "out_of", "groups"]) assert.ok(k in g, `missing ${k}`);
  for (const t of ["content", "community", "feature"]) {
    assert.equal(typeof g.groups[t], "number", `groups.${t} not numeric`);
  }
  assert.ok(g.groups.content >= 1, "caching should match content docs");
});

test("global endpoint is a 400 on empty query", async () => {
  const res = await fetch(`${base}/api/global?q=`);
  assert.equal(res.status, 400);
});

test("lesson endpoint opens a generated body", async () => {
  const res = await fetch(`${base}/api/lesson?id=SYSTEM_DESIGN-core-concepts-caching`);
  const l = await res.json();
  assert.equal(res.status, 200);
  assert.equal(l.title, "Caching for System Design Interviews");
  assert.ok(Array.isArray(l.body) && l.body.length >= 3, "expected structured sections");
  for (const s of l.body) {
    assert.ok(s.h && s.p, "section shape missing");
    assert.ok(!/lorem/i.test(s.p), "no lorem ipsum");
  }
});

test("unknown lesson is a 404", async () => {
  const res = await fetch(`${base}/api/lesson?id=does-not-exist`);
  assert.equal(res.status, 404);
});

const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`PASS  ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${t.name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
server.close();
process.exit(failed ? 1 : 0);
