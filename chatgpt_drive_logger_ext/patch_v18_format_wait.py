import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
def rep(old, new):
    global s
    n = s.count(old)
    if n != 1: sys.exit(f"見つからない/複数あり({n}): {old[:80]!r}")
    s = s.replace(old, new)

# 1) 画面の表で補うのは、書き終わっていて、画面の最後の答えが記録の答えと同じ時だけ
rep('''  function articleGuardDomAuditTable() {
    try {
      if (typeof document === "undefined") return "";
      const turns = Array.from(document.querySelectorAll('main [data-message-author-role="assistant"]'));
      const last = turns[turns.length - 1];
      if (!last) return "";
''', '''  // v18（2026-10-29）：画面の最後の答えの文字だけを比べる形にする
  function articleGuardLetters(text) { return String(text || "").replace(/<[^>]+>/g, "").replace(/[^\\p{L}\\p{N}]+/gu, ""); }
  function articleGuardDomAuditTable(expectTail = "") {
    try {
      if (typeof document === "undefined") return "";
      if (findStopButton()) return "";   // v18：GPTが書いている途中の表（書きかけの行）は読まない
      const turns = Array.from(document.querySelectorAll('main [data-message-author-role="assistant"]'));
      const last = turns[turns.length - 1];
      if (!last) return "";
      // v18：画面の最後の答えが、記録で読んだ答えと同じ時だけ使う（前の回の表を今回の表として読まない）
      if (expectTail && !articleGuardLetters(last.innerText || last.textContent || "").includes(expectTail)) return "";
''')

rep('''    if (!/^\\s*\\|\\s*No\\.?\\s*\\|\\s*監査項目\\s*\\|\\s*結果\\s*\\|/m.test(answer)) {
      const domTable = articleGuardDomAuditTable();
''', '''    if (!/^\\s*\\|\\s*No\\.?\\s*\\|\\s*監査項目\\s*\\|\\s*結果\\s*\\|/m.test(answer)) {
      const tail = articleGuardLetters(lastText).slice(-12);
      const domTable = tail ? articleGuardDomAuditTable(tail) : "";
''')

rep('''      if (m?.author?.role === "assistant" && (m.recipient || "all") === "all" && c.content_type === "text") answer += (c.parts || []).join("\\n") + "\\n";''',
'''      if (m?.author?.role === "assistant" && (m.recipient || "all") === "all" && c.content_type === "text") { lastText = (c.parts || []).join("\\n"); answer += lastText + "\\n"; }''')

rep('''    let answer = "", drive = "";
    const hidden = [];
    for (const node of path.slice(start)) {''', '''    let answer = "", drive = "", lastText = "";
    const hidden = [];
    for (const node of path.slice(start)) {''')

# 2) 表が読めない答えは、同じ答えのまま2分動かないのを確かめてから差し戻す
rep('''  async function articleGuardEvaluate(conversationId, conv) {''', '''  // v18（2026-10-29）Dan「表が読めなかったので同じ項目をもう一度、って毎回出る」
  // 会話 6ae251cf：GPTは依頼を受けるとまず短い途中経過（「確認します」等）を出し、数分作業してから表を出す。
  // 記録では途中経過も「書き終わった文章の答え」に見えるため、見張りは表のない途中経過を読み、画面の前の回の表や
  // 書きかけの表で補って「読めない」と判定していた（No.1-1が入っている／3-2の引用が無い／14-1に左右対応が無い）。
  // 表が読めない時の判定は、同じ答えのまま一定時間動かないのを確かめてから出す。
  const ARTICLE_GUARD_FORMAT_SETTLE_MS = 120000;
  function articleGuardUnsureRead(d) {
    if (!d || !d.send || !d.state) return false;
    const why = String(d.blockReason || "");
    return d.state.kind === "format" || (d.gaveUp && /読める表/.test(why)) || /読める表が出ず/.test(why)
      || (d.state.kind === "needtext" && !d.state.danSaid);
  }
  async function articleGuardEvaluate(conversationId, conv) {''')

rep('''    const d=anchorId?articleGuardDecide(before,answer,Date.now(),anchorId,articleGuardAnchorIsAudit(conv,anchorId),articleGuardHumanTextOf(conv,anchorId)):{state:null,send:false,gaveUp:false};
    if(d.state) d.state=Object.assign({},d.state,{readNode:conv?.current_node||""});''', '''    const d=anchorId?articleGuardDecide(before,answer,Date.now(),anchorId,articleGuardAnchorIsAudit(conv,anchorId),articleGuardHumanTextOf(conv,anchorId)):{state:null,send:false,gaveUp:false};
    // v18：表が読めない答えは、GPTが途中経過を出しただけかもしれない。同じ答えのまま2分動かないのを見てから差し戻す
    if(before&&articleGuardUnsureRead(d)){
      const node=conv?.current_node||"", w=before.formatWait;
      if(!w||w.node!==node){
        articleGuardSave(conversationId,Object.assign({},before,{formatWait:{node,at:Date.now()}}));
        articleGuardLastDomSeen="";   // 画面が変わらなくても後読みでもう一度読む
        osfhEvent("article_guard_format_wait",`表が読めない答え（${String(d.blockReason||"").slice(0,60)}）→ 途中経過かもしれないので待つ ${node}`);
        return;
      }
      if(Date.now()-w.at<ARTICLE_GUARD_FORMAT_SETTLE_MS||findStopButton()){ articleGuardLastDomSeen=""; return; }
    }
    if(d.state) d.state=Object.assign({},d.state,{readNode:conv?.current_node||"",formatWait:null});''')

# 試験用の出口
rep('''articleGuardTargetLine,setRulesForTest:''', '''articleGuardTargetLine,articleGuardUnsureRead,articleGuardLetters,articleGuardEvaluate,setRulesForTest:''')

open(p, "w", encoding="utf-8").write(s)
print("OK")
