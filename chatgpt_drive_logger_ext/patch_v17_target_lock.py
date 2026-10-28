import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
def rep(old, new):
    global s
    n = s.count(old)
    if n != 1: sys.exit(f"見つからない/複数あり({n}): {old[:80]!r}")
    s = s.replace(old, new)

# 1) 監査対象の記事を固定する部品（articleGuardNewest の後ろ）
rep('''  function articleGuardNewest(answer) {
    return articleGuardSplit(answer).articles.find(b => /^#\\s+\\S/.test(b.trim()) && b.replace(/\\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS) || "";
  }
''', '''  function articleGuardNewest(answer) {
    return articleGuardSplit(answer).articles.find(b => /^#\\s+\\S/.test(b.trim()) && b.replace(/\\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS) || "";
  }
  // v17（2026-10-29）Dan「冒頭でどの記事か固定させろ、最初の監査指示で出せばできるだろ」
  // 会話 6ae251cf：日本語の記事452を監査中、GPTが英語版453の原稿を出した → 見張りが英語版を「直した原稿」として監査対象を
  // 差し替え、日本語版の結果と英語版の結果が1つの監査に混ざった。最初の監査依頼で記事（題名・言語・URL）を固定し、
  // 違う記事の原稿は監査対象にしない。言語が違えば別の記事。日本語どうしは本文の重なり（3文字の組）も見る
  // （同じ記事の直し 0.75、別の記事 0.23 を実測）。英語どうしは重なりで見分けられない（別記事でも0.8）ので言語だけ。
  const ARTICLE_GUARD_SAME_MIN = 0.45;
  const ARTICLE_GUARD_SWITCH_WORDS = { en: /(英語版|英語|英訳|English)/i, ja: /(日本語版|日本語)/ , any: /(別の記事|次の記事|新しい記事|対象を変え|対象を切り替え)/ };
  function articleGuardPlainText(text) { return String(text || "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " "); }
  function articleGuardLang(text) {
    const p = articleGuardPlainText(text);
    const jp = (p.match(/[ぁ-んァ-ヶ一-龥]/g) || []).length, la = (p.match(/[A-Za-z]/g) || []).length;
    return jp * 3 >= la ? "ja" : "en";
  }
  function articleGuardLangName(lang) { return lang === "en" ? "英語" : "日本語"; }
  function articleGuardTitleOf(text) {
    const line = String(text || "").trim().split("\\n").find(x => /^#\\s+\\S/.test(x.trim())) || "";
    return line.replace(/^#\\s+/, "").replace(/<[^>]+>/g, "").trim().slice(0, 120);
  }
  function articleGuardGrams(text) {
    const p = articleGuardPlainText(text).toLowerCase().replace(/[\\s\\p{P}\\p{S}]+/gu, "");
    const g = new Set();
    for (let i = 0; i + 3 <= p.length; i++) g.add(p.slice(i, i + 3));
    return g;
  }
  function articleGuardSimilarity(a, b) {
    const A = articleGuardGrams(a), B = articleGuardGrams(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    for (const x of A) if (B.has(x)) n++;
    return n / Math.min(A.size, B.size);
  }
  function articleGuardMakeTarget(source, humanText) {
    const url = (String(humanText || "").match(/https?:\\/\\/[^\\s)\\]>」]+/) || [""])[0];
    return { title: articleGuardTitleOf(source), lang: articleGuardLang(source), url, first: String(source || "").slice(0, 40000) };
  }
  // 監査対象の記事かどうか。current＝今監査している版（直した原稿どうしの比較にも使う）
  function articleGuardIsTarget(target, text, current = "") {
    if (!target || !target.lang) return { ok: true, why: "" };
    const lang = articleGuardLang(text);
    if (lang !== target.lang) return { ok: false, why: `言語が違う（監査対象は${articleGuardLangName(target.lang)}、出た原稿は${articleGuardLangName(lang)}）` };
    if (lang === "ja") {
      const sim = Math.max(articleGuardSimilarity(target.first, text), current ? articleGuardSimilarity(current, text) : 0);
      if (sim < ARTICLE_GUARD_SAME_MIN) return { ok: false, why: `本文が監査対象とほとんど重ならない（重なり${Math.round(sim * 100)}%）` };
    }
    return { ok: true, why: "" };
  }
  // 答えの中の記事から、監査対象の記事を選ぶ。対象でない記事は other に入れる（監査には使わない）
  function articleGuardPickArticle(answer, target, current = "") {
    const list = articleGuardSplit(answer).articles.filter(b => /^#\\s+\\S/.test(b.trim()) && b.replace(/\\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS);
    let article = "", other = "", why = "";
    for (const b of list) {
      const t = articleGuardIsTarget(target, b, current);
      if (t.ok) { article = b; break; }
      if (!other) { other = b; why = t.why; }
    }
    return { article, other, why };
  }
  // Danが自分の言葉で、別の記事（英語版など）へ監査を移すと言った時だけ、対象を変えてよい
  function articleGuardWantsSwitch(humanText, text) {
    const h = String(humanText || "");
    if (!h || h.startsWith("【PGから")) return false;
    return ARTICLE_GUARD_SWITCH_WORDS.any.test(h) || ARTICLE_GUARD_SWITCH_WORDS[articleGuardLang(text)].test(h);
  }
  function articleGuardTargetLine(state) {
    const t = state && state.target;
    if (!t || !t.title) return "";
    return `【監査対象の記事（最初の監査依頼で固定）】題名「${t.title}」・${articleGuardLangName(t.lang)}${t.url ? "・" + t.url : ""}。この監査が終わるまで対象は変えない。英語版・翻訳・別の記事の原稿はこの監査に出さない（出してもPGは監査対象にせず、その答えの表も使わない）。題名や本文を直した時も、この記事の全文を出す。`;
  }
''')

# 2) 判定：対象を固定・違う記事は差し替えない
rep('''    if (state && (state.mode !== ARTICLE_GUARD_MODE || (state.anchorId && state.anchorId !== anchorId))) state = null;
    state = articleGuardRefreshRuleSnapshot(state);
    let newestArticle = articleGuardNewest(answer);
''', '''    // v17：止めた・終わった後にDanが（URLなしで）発言して見張りを始め直す時も、前の監査対象の記事を引き継ぐ
    let carryTarget = null;
    if (state && state.mode === ARTICLE_GUARD_MODE && state.target && state.anchorId && anchorId && state.anchorId !== anchorId
        && typeof humanText === "string" && !/https?:\\/\\//i.test(humanText)) carryTarget = state.target;
    if (state && (state.mode !== ARTICLE_GUARD_MODE || (state.anchorId && state.anchorId !== anchorId))) state = null;
    state = articleGuardRefreshRuleSnapshot(state);
    if (state && !state.target && state.source) state = Object.assign({}, state, { target: articleGuardMakeTarget(state.source, "") });   // v17：v16以前に始めた見張りは今の原稿で固定
    const lockTarget = (state && state.target) || carryTarget;
    const picked = articleGuardPickArticle(answer, lockTarget, (state && state.source) || "");
    let newestArticle = picked.article, otherArticle = picked.other, otherWhy = picked.why, switchTarget = false;
    if (!newestArticle && otherArticle && typeof humanText === "string" && (danCont || carryTarget) && articleGuardWantsSwitch(humanText, otherArticle)) {
      newestArticle = otherArticle; otherArticle = ""; switchTarget = true;   // Danが別の記事へ移すと言った
    }
''')

rep('''      if (/^#\\s+\\S/.test(plain) && plain.replace(/\\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS && !/【監査バッチ結果/.test(plain)) newestArticle = plain;
    }
''', '''      if (/^#\\s+\\S/.test(plain) && plain.replace(/\\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS && !/【監査バッチ結果/.test(plain)) {
        const t = articleGuardIsTarget(lockTarget, plain, (state && state.source) || "");
        if (t.ok) newestArticle = plain; else if (!otherArticle) { otherArticle = plain; otherWhy = t.why; }
      }
    }
''')

rep('''    if (!state) {
      if (!newestArticle) return {state:null, send:false, gaveUp:false};
      const n = { mode:ARTICLE_GUARD_MODE, anchorId, source:newestArticle, batch:0, tries:0, total:0, kind:"start", records:{}, lastFails:[], lastReason:"", sent:0, retryAt:0, blocked:false, complete:false, audit:!!audit, auditFails:[], rules:articleGuardCurrentRules() };
      return {state:n, send:true, gaveUp:false};
    }
''', '''    if (!state) {
      if (!newestArticle) return {state:null, send:false, gaveUp:false};
      const target = (carryTarget && !switchTarget) ? carryTarget : articleGuardMakeTarget(newestArticle, humanText);
      const n = { mode:ARTICLE_GUARD_MODE, anchorId, source:newestArticle, target, batch:0, tries:0, total:0, kind:"start", records:{}, lastFails:[], lastReason:"", sent:0, retryAt:0, blocked:false, complete:false, audit:!!audit, auditFails:[], rules:articleGuardCurrentRules() };
      return {state:n, send:true, gaveUp:false, blockReason: switchTarget ? `Danの指示で監査対象を「${target.title}」（${articleGuardLangName(target.lang)}）に変えて最初から` : ""};
    }
''')

rep('''      if (!newestArticle) newestArticle = articleGuardCodeBlockArticle(answer);   // v4：「# 題名」＋コードの枠で出した全文も読む
      if (newestArticle) {
        const n = { mode:ARTICLE_GUARD_MODE, anchorId, source:newestArticle, batch:0,''', '''      if (!newestArticle) {   // v4：「# 題名」＋コードの枠で出した全文も読む（v17：監査対象の記事の時だけ）
        const cb = articleGuardCodeBlockArticle(answer);
        if (cb && articleGuardIsTarget(lockTarget, cb, state.source || "").ok) newestArticle = cb;
      }
      if (newestArticle) {
        const n = { mode:ARTICLE_GUARD_MODE, anchorId, source:newestArticle, target: state.target || articleGuardMakeTarget(newestArticle, humanText), batch:0,''')

rep('''    let s = Object.assign({}, state);
    if (newestArticle && newestArticle !== s.source) {''', '''    let s = Object.assign({}, state);
    if (switchTarget && newestArticle) {   // v17：Danの指示で別の記事へ。前の記事の結果は混ぜずに最初から
      const target = articleGuardMakeTarget(newestArticle, humanText);
      const n = Object.assign({}, s, { source:newestArticle, sources:[], target, batch:0, tries:0, total:0, kind:"start", records:{}, lastFails:[], lastReason:"", sent:0, retryAt:0, wrongTitle:"", wrongWhy:"" });
      return {state:n, send:true, gaveUp:false, blockReason:`Danの指示で監査対象を「${target.title}」（${articleGuardLangName(target.lang)}）に変えて最初から`};
    }
    if (newestArticle && newestArticle !== s.source) {''')

rep('''    const items = articleGuardBatchItems(s.batch, s);
    const parsed = articleGuardBatchParse(answer, s);
''', '''    const items = articleGuardBatchItems(s.batch, s);
    const parsed = articleGuardBatchParse(answer, s);
    // v17：監査対象と違う記事の原稿だけが出た → 差し替えず、その答えの表も使わない。対象の記事で同じ項目をやり直させる
    if (otherArticle && !newestArticle) {
      if (s.kind === "wrongtarget" && (s.tries || 0) >= ARTICLE_GUARD_MAX_TRIES) {
        return articleGuardStop(s, `監査対象（「${(s.target || {}).title || ""}」${articleGuardLangName((s.target || {}).lang)}）と違う記事の原稿が${ARTICLE_GUARD_MAX_TRIES}回続いた（${otherWhy}）`);
      }
      const n = Object.assign({}, s, { kind:"wrongtarget", tries: s.kind === "wrongtarget" ? s.tries : 0, wrongTitle: articleGuardTitleOf(otherArticle), wrongWhy: otherWhy, lastReason:"", sent:0, retryAt:0 });
      return {state:n, send:true, gaveUp:false, blockReason:`監査対象と違う記事の原稿（「${n.wrongTitle}」：${otherWhy}）→ 監査対象にしない`};
    }
''')

# 3) 依頼文：最初の依頼から毎回、固定した記事を書く。違う記事が出た時の文
rep('''    if (kind === "needtext") {
      return [
        ...(state?.danSaid ?''', '''    if (kind === "needtext") {
      return [
        ...(articleGuardTargetLine(state) ? [articleGuardTargetLine(state)] : []),
        ...(state?.danSaid ?''')

rep('''    if (kind === "done") {
      return [
        ARTICLE_GUARD_MARK + `${articleGuardCheckCount(state)}項目すべて○`,
        "これは拡張PGが自動で送った文で、本人の発言ではない。",''', '''    if (kind === "done") {
      return [
        ARTICLE_GUARD_MARK + `${articleGuardCheckCount(state)}項目すべて○`,
        "これは拡張PGが自動で送った文で、本人の発言ではない。",
        ...(state?.target?.title ? [`○になったのは監査対象の記事「${state.target.title}」（${articleGuardLangName(state.target.lang)}）だけ。ほかの記事・英語版は監査していない。`] : []),''')

rep('''      : kind === "format"
        ? ARTICLE_GUARD_MARK + `表が読めなかったので同じ項目をもう一度（No.${items.join("・")}、${tryNo}回目／${ARTICLE_GUARD_MAX_TRIES}回まで）`''', '''      : kind === "format"
        ? ARTICLE_GUARD_MARK + `表が読めなかったので同じ項目をもう一度（No.${items.join("・")}、${tryNo}回目／${ARTICLE_GUARD_MAX_TRIES}回まで）`
      : kind === "wrongtarget"
        ? ARTICLE_GUARD_MARK + `監査対象と違う記事の原稿が出たので使わない。同じ項目を監査対象の記事でもう一度（No.${items.join("・")}、${tryNo}回目／${ARTICLE_GUARD_MAX_TRIES}回まで）`''')

rep('''    const lines = [head, "これは拡張PGが自動で送った検査依頼で、本人の発言ではない。"];
''', '''    const lines = [head, "これは拡張PGが自動で送った検査依頼で、本人の発言ではない。"];
    if (articleGuardTargetLine(state)) lines.push(articleGuardTargetLine(state));   // v17：最初の依頼から毎回、固定した記事を示す
''')

rep('''    } else if (kind === "format") {
      lines.push(`前の答えはPGが読めなかった：${state?.lastReason || ""}`);
      lines.push("原稿はそのままでよい。同じ項目を下の表の形で書き直す。");
    }
''', '''    } else if (kind === "format") {
      lines.push(`前の答えはPGが読めなかった：${state?.lastReason || ""}`);
      lines.push("原稿はそのままでよい。同じ項目を下の表の形で書き直す。");
    } else if (kind === "wrongtarget") {
      lines.push(`前の答えの原稿「${state?.wrongTitle || ""}」は監査対象の記事ではない（${state?.wrongWhy || ""}）。PGはこの原稿を監査対象にせず、その答えの表も使わない。`);
      lines.push("監査対象の記事の原稿（直していなければ前の原稿のまま）で、同じ項目を下の表で調べ直す。監査対象の記事を直した時は、その全文を「# 」で始まるドキュメントで出す。別の記事の修正は、この監査が終わってから、Danの指示で別に行う。");
    }
''')

# 4) 試験用の出口に追加
rep('''articleGuardPgOf,setRulesForTest:''', '''articleGuardPgOf,articleGuardLang,articleGuardTitleOf,articleGuardSimilarity,articleGuardMakeTarget,articleGuardIsTarget,articleGuardPickArticle,articleGuardWantsSwitch,articleGuardTargetLine,setRulesForTest:''')

open(p, "w", encoding="utf-8").write(s)
print("OK")
