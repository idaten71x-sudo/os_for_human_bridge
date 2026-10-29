// v18 途中経過を「表が読めない答え」として差し戻さない試験（会話 6ae251cf の流れ）
// 使い方: node tests/test_format_wait.js content.js
const fs = require("fs"), path = require("path"), assert = require("assert");
const FX = fs.existsSync(path.join(__dirname, "fixtures")) ? path.join(__dirname, "fixtures") : __dirname;
const g = require("./harness.js").load(process.argv[2] || path.join(__dirname, "..", "content.js"));
const ctx = g.__ctx, CID = "6ae251cf-test", KEY = "osfhArticleGuard:" + CID;
const read = n => fs.readFileSync(path.join(FX, n), "utf8");
const JA1 = fs.existsSync(path.join(FX, "ja_452_v1.md")) ? read("ja_452_v1.md") : null;
const rules = JSON.parse(read(fs.existsSync(path.join(FX, "rules_numbers_only.json")) ? "rules_numbers_only.json" : "rules_from_conv.json"));
g.setRulesForTest(rules);
const wb = t => `<WritingBlock id="1" variant="document">${t}</WritingBlock>`;
// 会話の記録を作る
let lastConv = null;
ctx.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => lastConv, text: async () => JSON.stringify(lastConv) });
function conv(nodes) {
  const mapping = {}; let parent = null;
  nodes.forEach((n, i) => { const id = "n" + i; mapping[id] = { id, parent, message: { author: { role: n.role }, recipient: "all", end_turn: n.end_turn, content: { content_type: "text", parts: [n.text] } } }; parent = id; });
  lastConv = { mapping, current_node: parent };
  return lastConv;
}
const batch0 = g.articleGuardBatchItems(0, { rules: g.articleGuardNormalizeRules(rules) });
const article = JA1;
const quote = article.split("\n").find(l => l.replace(/\s/g, "").length > 30 && !l.startsWith("#") && !l.startsWith("|")).trim().slice(0, 20);
const table = ["【監査バッチ結果】", "| No. | 監査項目 | 結果 | 位置 | 原文引用 | 判定根拠 |", "|---|---|---|---|---|---|",
  ...batch0.map(no => `| ${no} | 項目${no} | ○ | 導入 | 「${quote}」 | 導入の段落で条件を満たしていることを原文で確かめた。根拠は引用の通り。 |`)].join("\n");
const base = [
  { role: "user", text: "https://kenshonote.com/ai-settings-not-provided-run-log/\n\n監査修正して" },
  { role: "assistant", text: wb(article) },
  { role: "user", text: "【PGから：記事報告の見張り】大項目4つずつ検査" },
];
function startState() {
  const d = g.articleGuardDecide(null, wb(article), Date.now(), "n0", false, base[0].text);
  return Object.assign({}, d.state, { sent: 1, tries: 1, total: 1, readNode: "n1" });
}
let pass = 0; const t = async (name, fn) => { await fn(); pass++; console.log("OK", name); };
(async () => {
  await t("途中経過（表なし）を読んでも差し戻さず待つ", async () => {
    ctx.localStorage.setItem(KEY, JSON.stringify(startState()));
    await g.articleGuardEvaluate(CID, conv([...base, { role: "assistant", text: "指定された項目について、監査正本と前回の修正原稿を直接照合します。" }]));
    const s = JSON.parse(ctx.localStorage.getItem(KEY));
    assert.strictEqual(s.kind, "start"); assert(s.formatWait && s.formatWait.node === "n3");
  });
  await t("そのあと表が出たら、読める表として次の組へ進む（「表が読めなかった」は出ない）", async () => {
    await g.articleGuardEvaluate(CID, conv([...base, { role: "assistant", text: "指定された項目について照合します。" }, { role: "assistant", text: table }]));
    const s = JSON.parse(ctx.localStorage.getItem(KEY));
    assert.strictEqual(s.kind, "next"); assert.strictEqual(s.batch, 1); assert.strictEqual(s.formatWait, null);
  });
  await t("同じ答えのまま2分たっても表が無ければ、その時に差し戻す", async () => {
    const st = Object.assign(startState(), { formatWait: { node: "n3", at: Date.now() - 121000 } });
    ctx.localStorage.setItem(KEY, JSON.stringify(st));
    await g.articleGuardEvaluate(CID, conv([...base, { role: "assistant", text: "表を出し忘れた答え。" }]));
    const s = JSON.parse(ctx.localStorage.getItem(KEY));
    assert.strictEqual(s.kind, "format"); // 送信は台では失敗し retryAt 付きで保存される
  });
  await t("2分たつ前は、まだ差し戻さない", async () => {
    const st = Object.assign(startState(), { formatWait: { node: "n3", at: Date.now() - 30000 } });
    ctx.localStorage.setItem(KEY, JSON.stringify(st));
    await g.articleGuardEvaluate(CID, conv([...base, { role: "assistant", text: "まだ作業中の途中経過。" }]));
    assert.strictEqual(JSON.parse(ctx.localStorage.getItem(KEY)).kind, "start");
  });
  await t("画面の最後の答えが記録の答えと違う時は、画面の表（前の回の表）を使わない", async () => {
    const old = { innerText: table, textContent: table, querySelectorAll: () => [] };
    ctx.document.querySelectorAll = sel => /assistant/.test(sel) ? [old] : [];
    const ans = g.articleGuardReadAnswer(conv([...base, { role: "assistant", text: "照合します。少し待ってください。" }]));
    assert(!/監査項目/.test(ans));
    ctx.document.querySelectorAll = () => [];
  });
  console.log(`全${pass}件 合格`);
})().catch(e => { console.error(e); process.exit(1); });
