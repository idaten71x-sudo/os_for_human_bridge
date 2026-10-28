// v17 監査対象の記事の固定の試験（会話 6ae251cf の取り違えの再現を含む）
// 使い方: node tests/test_target_lock.js content.js
const fs = require("fs"), path = require("path"), assert = require("assert");
const g = require("./harness.js").load(process.argv[2] || path.join(__dirname, "..", "content.js"));
const F = n => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
g.setRulesForTest(JSON.parse(F("rules_numbers_only.json")));
const wb = t => `<WritingBlock id="1" variant="document">${t}</WritingBlock>`;
const JA1 = F("ja_452_v1.md"), JA2 = F("ja_452_v2.md"), EN = F("en_453.md");
const OTHER_JA = "# AI導入やシステム開発を発注する人へ\n\n" + F("other_ja_article.html");
const URL = "https://kenshonote.com/ai-settings-not-provided-run-log/";
let pass = 0; const t = (name, fn) => { fn(); pass++; console.log("OK", name); };
const sent = d => Object.assign({}, d.state, { tries: (d.state.tries || 0) + 1, sent: 1 });

t("最初の監査依頼に固定した記事（題名・言語・URL）が出る", () => {
  const d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL + "\n\n監査修正して");
  assert.strictEqual(d.state.target.lang, "ja"); assert.strictEqual(d.state.target.url, URL);
  const text = g.articleGuardText(1, d.state);
  assert(text.includes("【監査対象の記事（最初の監査依頼で固定）】題名「ChatGPTに作らせた作業画面で、AIの設定値が確認できない」・日本語・" + URL), text.slice(0, 400));
});
t("同じ記事を直した原稿（題名も変わる）は監査対象のまま差し替わる", () => {
  let d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  d = g.articleGuardDecide(sent(d), wb(JA2) + "\n表なし", 0, "dan0", false, URL);
  assert.strictEqual(d.state.source, JA2); assert.notStrictEqual(d.state.kind, "wrongtarget");
});
t("英語版の原稿が出ても監査対象を差し替えない（今回の事故）", () => {
  let d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  d = g.articleGuardDecide(sent(d), wb(EN) + "\n【監査バッチ結果】", 0, "dan0", false, URL);
  assert.strictEqual(d.state.kind, "wrongtarget"); assert.strictEqual(d.state.source, JA1);
  const text = g.articleGuardText(1, d.state);
  assert(text.includes("監査対象と違う記事の原稿が出たので使わない")); assert(text.includes("言語が違う（監査対象は日本語、出た原稿は英語）"));
});
t("別の日本語記事の原稿も差し替えない", () => {
  let d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  d = g.articleGuardDecide(sent(d), wb(OTHER_JA), 0, "dan0", false, URL);
  assert.strictEqual(d.state.kind, "wrongtarget"); assert.strictEqual(d.state.source, JA1);
});
t("違う記事が3回続いたら止める", () => {
  let d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  for (let i = 0; i < 3; i++) { d = g.articleGuardDecide(sent(d), wb(EN), 0, "dan0", false, URL); assert.strictEqual(d.state.kind, "wrongtarget"); }
  d = g.articleGuardDecide(sent(d), wb(EN), 0, "dan0", false, URL);
  assert.strictEqual(d.state.kind, "stop"); assert(d.blockReason.includes("違う記事の原稿が3回続いた"));
});
t("Danの発言（URLなし・英語の指示なし）の後に英語版が出ても差し替えない", () => {
  let d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  d = g.articleGuardDecide(sent(d), wb(EN), 0, "dan17", false, "本文取得せんでもええようにSIRIUS型にしたのに");
  assert.strictEqual(d.state.kind, "wrongtarget"); assert.strictEqual(d.state.source, JA1);
});
t("止めた後にDanが（URLなしで）発言しても、前の記事を引き継ぐ", () => {
  let d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  const stopped = Object.assign({}, sent(d), { blocked: true, kind: "stop" });
  d = g.articleGuardDecide(stopped, wb(EN), 0, "dan17", false, "続けて");
  assert.strictEqual(d.state, null); // 英語版では始めない
  d = g.articleGuardDecide(stopped, wb(JA2), 0, "dan17", false, "続けて");
  assert.strictEqual(d.state.target.title, "ChatGPTに作らせた作業画面で、AIの設定値が確認できない"); assert.strictEqual(d.state.source, JA2);
});
t("Danが「英語版を監査して」と言った時だけ対象を変え、最初から（結果を混ぜない）", () => {
  let d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  const mid = Object.assign({}, sent(d), { batch: 2, records: { "1-1": { verdict: "○" } } });
  d = g.articleGuardDecide(mid, wb(EN), 0, "dan17", false, "次は英語版を監査して");
  assert.strictEqual(d.state.target.lang, "en"); assert.strictEqual(d.state.batch, 0); assert.strictEqual(Object.keys(d.state.records).length, 0); assert.strictEqual(d.state.kind, "start");
});
t("v16以前に始めた見張り（targetなし）は今の原稿で固定する", () => {
  let d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  const old = Object.assign({}, sent(d)); delete old.target;
  d = g.articleGuardDecide(old, wb(EN), 0, "dan0", false, URL);
  assert.strictEqual(d.state.kind, "wrongtarget"); assert.strictEqual(d.state.target.lang, "ja");
});
t("1つの答えに日本語と英語の原稿がある時は、監査対象の方を使う", () => {
  let d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  d = g.articleGuardDecide(sent(d), wb(EN) + wb(JA2), 0, "dan0", false, URL);
  assert.strictEqual(d.state.source, JA2); assert.notStrictEqual(d.state.kind, "wrongtarget");
});
t("終わりの文にも監査対象の記事を書く", () => {
  const d = g.articleGuardDecide(null, wb(JA1), 0, "dan0", false, URL);
  const text = g.articleGuardText(1, Object.assign({}, d.state, { kind: "done" }));
  assert(/^【PGから：記事報告の見張り】\d+項目すべて○/.test(text)); assert(text.includes("○になったのは監査対象の記事「ChatGPTに作らせた"));
});
console.log(`全${pass}件 合格`);
