(() => {
  "use strict";
 
 
  // Instance handoff: the background re-injects this file into open tabs after
  // an extension reload. The newest instance stamps its id on <html>; any older
  // instance that sees a different id retires (stops timers, observer and hotkeys)
  // so auto-retry / stop-resume never run twice.
  const OSFH_INSTANCE_ATTR = "data-osfh-drive-logger-instance";
  const OSFH_INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const osfhIntervals = new Set();
  const osfhKeyHandlers = [];
  let osfhRetired = false;
  const setInterval = (fn, ms, ...args) => {
    const id = window.setInterval(fn, ms, ...args);
    osfhIntervals.add(id);
    return id;
  };
  document.documentElement.setAttribute(OSFH_INSTANCE_ATTR, OSFH_INSTANCE_ID);
 
 
  function osfhRetire() {
    if (osfhRetired) return;
    osfhRetired = true;
    for (const id of osfhIntervals) window.clearInterval(id);
    osfhIntervals.clear();
    window.clearInterval(osfhWatchId);
    try { observer?.disconnect(); } catch (_) {}
    for (const handler of osfhKeyHandlers) document.removeEventListener("keydown", handler, true);
    console.info("ChatGPT Drive Logger: newer content script took over; old instance retired.");
  }
 
 
  const osfhWatchId = window.setInterval(function osfhInstanceWatch() {
    if (osfhRetired) return;
    if (document.documentElement.getAttribute(OSFH_INSTANCE_ATTR) !== OSFH_INSTANCE_ID) osfhRetire();
  }, 1000);
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  const ROLE_SELECTOR = "[data-message-author-role='user'], [data-message-author-role='assistant']";
  const TURN_SELECTOR = "[data-testid^='conversation-turn-']";
  const SHELL_SELECTOR = "#thread section[data-turn-id][data-turn], [data-testid^='conversation-turn-'], #thread [data-turn-key]";
  const USER_CONTENT_SELECTOR = "[data-user-message-bubble], [data-testid='collapsible-user-message-content']";
  const ASSISTANT_CONTENT_SELECTOR = "[data-markdown-text-style], .markdown, [class*='markdown']";
  const SCROLL_SELECTOR = "[data-scroll-root]";
  const EXPORTABLE_CONTENT_TYPES = new Set(["text", "multimodal_text"]);
  const STABLE_MS = 1800;
  const RETRY_ROUTE_MS = 1500;
  const BACKFILL_AFTER_CHANGE_MS = 4500;
  const FALLBACK_WAIT_MS = 900;
  const AUTO_RETRY_TIMEOUT_TEXT = "メッセージ配信がタイムアウトしました";
  const AUTO_RETRY_STREAM_ERROR_TEXT = "メッセージ ストリームでエラーが発生しました";
  const AUTO_RETRY_RESUME_UNAVAILABLE_TEXT = "Resume stream unavailable";
  const AUTO_RETRY_RECOVERY_POLLING_TIMEOUT_TEXT = "ChatGPT stream recovery polling timed out";
  const AUTO_RETRY_NETWORK_ERROR_TEXT = "A network error occurred. Please check your connection and try again.";
  // Short prefix so punctuation/wording variants of the generic error still match.
  const AUTO_RETRY_GENERIC_ERROR_TEXT = "問題が発生しました";
  const AUTO_RETRY_STREAM_ERROR_TEXTS = [AUTO_RETRY_STREAM_ERROR_TEXT, AUTO_RETRY_RESUME_UNAVAILABLE_TEXT, AUTO_RETRY_RECOVERY_POLLING_TIMEOUT_TEXT, AUTO_RETRY_NETWORK_ERROR_TEXT, AUTO_RETRY_GENERIC_ERROR_TEXT];
  const AUTO_RETRY_BUTTON_TEXT = "再試行";
  const AUTO_RETRY_REPEAT_MS = 20000;
  const AUTO_RETRY_FALLBACK_SCAN_MS = 15000;
  const AUTO_RETRY_STREAM_ERROR_MAX_CLICKS = 3;
  const AUTO_RETRY_STREAM_ERROR_GAP_MS = 10000;
  const SAFETY_CHECK_TEXT = "追加の安全性チェックを行っています";
  // 2026-09 wording; contains SAFETY_CHECK_TEXT, kept explicit for readability.
  const SAFETY_CHECK_TEXT_2026_09 = "回答前に、このリクエストについて追加の安全性チェックを行っています";
  const CONNECTION_INTERRUPTED_TEXT = "接続が中断されました。回答の完了を待っています";
  // 2026-10 wording of the same notice.
  const CONNECTION_INTERRUPTED_TEXT_2026_10 = "接続が途切れました。回答全体の受信を待っています";
  const SAFETY_CHECK_RETRY_MS = 1200;
  const SAFETY_CHECK_FALLBACK_SCAN_MS = 3000;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  const timers = new WeakMap();
  const lastFingerprintByRecordKey = new Map();
  let observer = null;
  let observerStarted = false;
  let backfillTimer = null;
  let backfillInFlight = null;
  let backfillConversationId = null;
  let lastHref = location.href;
  let autoRetryLastButton = null;
  let autoRetryLastClickAt = 0;
  let autoRetryStreamErrorLatched = false;
  let autoRetryStreamErrorClicks = 0;
  let autoRetryStreamErrorLastClickAt = 0;
  let autoRetryScanTimer = null;
  let stopResumeInFlight = false;
  let safetyCheckLatched = false;
  let safetyCheckLastAttemptAt = 0;
  let safetyCheckScanTimer = null;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  // OS_FOR_HUMAN periodic self-audit guard.
  // The logger no longer tries to infer correctness from isolated words such as
  // PASS / 完了 / 不能. Instead, it asks for a seven-point self-check after a
  // small number of genuinely new assistant turns.
  const REPORT_GUARD_ID = "osfh-report-self-audit-warning";
  const REPORT_GUARD_HOTKEY = "Alt+V";
  const STOP_RESUME_HOTKEY = "Ctrl+Alt+M";
  // The composer can re-render line breaks, so the first line is the key that
  // identifies an already-inserted resume prompt.
  const STOP_RESUME_KEY = "再開する。すぐに作業を続けず、先に頭をリセットする。";
  const STOP_RESUME_TEXT = `${STOP_RESUME_KEY}
 
1. 今の状況を、このチャットに5行以内で書き出す：いま何の作業をしているか／最後に何をしたか／次に何をするつもりだったか。
2. 作業台帳「作業台帳・作業テンプレ_CURRENT」（Spreadsheet ID: 1F7P9xyVtJ6CR2bVezmvcExVzzwJdgEGOas1Fy62vbDY）の「作業ファイル目次」で対象work_idの作業ファイルIDを確認し、その作業ファイル（スプレッドシート）を直接開く。作業ファイルの対象作業シートの番号付き最新行（状態／現在地／次の1手／未完了）と、同じ作業ファイルの「作業工程設計」の branch_id / parent_branch_id / branch_objective / branch_completion_condition / return_to_branch_id / branch_terminal / branch_state / ACTIVE を読み直す。依存スタックだけは台帳本体の状態管理U:AGが正本。Drive全体検索はしない。
3. 1で書いた自分の認識と、2の台帳を突き合わせる。今回ユーザーが依頼した目的地を current_branch_id として復元し、ACTIVEがその枝に属するかを確認する。ずれがあれば台帳を正として認識を直し、台帳の方が古ければ先に台帳を直してreadbackする。branch_id未設定で今回枝を一意に決められない場合は推測せずHOLDする。
4. 直近のやり取りで、本題から逸れて始めた作業や、頼まれていない作業がないか確認する。context_lock確定後に正規の子枝OPEN／BRANCH_RETURN／ユーザー明示切替なしで別work_id・別branch_idを進めていた場合は BRANCH_DEVIATION とする。誤枝への追加操作だけを即停止し、「逸脱に気付いたので停止」で終わらせず、最後に有効だった current_branch_id へ戻す。阻害原因修理の正規子枝なら parent/return先を確認し、修理完了後は元枝へ戻す。
5. 元current_branch_idへ戻ったら work_id／対象作業シート／current_branch_id／ACTIVE工程／次の1手を1回だけ再確定する。元枝がOPENならACTIVE不在だけでHOLDせず、同枝の直近工程status・next_phase_id・branch_objective・branch_completion_conditionから一意な正規次工程を復元し、必要ゲートがPASSならそのまま続行する。HOLDしてよいのは元枝CLOSED、次工程一意化不能、SOURCE_BROKEN等の必須ゲート故障、または元枝自身の実測blockerが残る場合だけ。branch_completion_condition＋readback PASSの正規子枝はCLOSEDとしてreturn_to_branch_idへ戻すが、無関係な別枝・別workのACTIVEへ自動進行しない。\n6. ユーザー向け報告は普通の日本語で書く。内部記録には識別子・状態名・証拠を正確に残すが、work_id／branch_id／phase_id／ACTIVE／HOLD／PASS／Direct番号／job_id／SHA／各種英字コードなどは、ユーザーが技術詳細を求めた時か操作に必要な時以外は本文に出さない。key=value羅列、状態コードだけの報告、専門語を別の専門語へ言い換えただけの説明は禁止。送信前に「仕組みを知らない人が、この本文だけで今どうなっているか／今回やったこと／結果／次にやることが分かるか」を確認し、分からなければ書き直す。事実・失敗・未完了は隠さず、表現だけを平文化する。D03を正本とする。`;
  const STOP_RESUME_WAIT_MS = 7000;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function currentLogThreadUrl() {
    const url = String(location.href || "").trim();
    return /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/c\/[A-Za-z0-9_-]+(?:[/?#].*)?$/.test(url) ? url : "";
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  const HANDOFF_ID_PATTERN = /(?:^|\n)HANDOFF_ID:\s*((?:GPT|EXT)-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})(?=\s|$)/g;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function extractHandoffIds(text) {
    const ids = [];
    const seen = new Set();
    const source = String(text || "");
    HANDOFF_ID_PATTERN.lastIndex = 0;
    let match;
    while ((match = HANDOFF_ID_PATTERN.exec(source)) !== null) {
      const id = String(match[1] || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    HANDOFF_ID_PATTERN.lastIndex = 0;
    return ids;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  // Thread identity for the chat AI. Ctrl+M uses HANDOFF_ID as the primary
  // identity because a brand-new ChatGPT thread has no stable /c/<id> URL yet.
  // If a generic new-chat page later resolves to /c/<id>, keep the same HANDOFF_ID;
  // the logger can associate the resolved URL afterward without putting it in Ctrl+M.
  let handoffConversationId = null;
  let handoffIdValue = "";
 
 
  function currentHandoffId() {
    const conversationId = conversationIdFromUrl();
    if (!handoffIdValue) {
      handoffIdValue = `EXT-${crypto.randomUUID()}`;
      handoffConversationId = conversationId;
      return handoffIdValue;
    }
    if (conversationId) {
      if (handoffConversationId && handoffConversationId !== conversationId) {
        handoffIdValue = `EXT-${crypto.randomUUID()}`;
      }
      handoffConversationId = conversationId;
      return handoffIdValue;
    }
    if (handoffConversationId) {
      handoffIdValue = `EXT-${crypto.randomUUID()}`;
      handoffConversationId = null;
    }
    return handoffIdValue;
  }
 
 
  function buildHandoffPrompt(promptBase) {
    const handoffId = currentHandoffId();
    const identity = `【スレッドID】
HANDOFF_ID: ${handoffId}
このHANDOFF_IDをこのスレッドの識別子として持つ。Ctrl+M本文にはスレッドURLを付加しない。最初の回答の末尾に「HANDOFF_ID: ${handoffId}」を1行だけそのまま出力し、作業台帳の最新作業行の「作業スレッドURL」欄にはURLではなくこのHANDOFF_IDを記録してreadbackする。拡張ログ側で確定URLを取得できた場合はHANDOFF_IDとの対応付けに使う。原因調査などで他のAI（Claude Code等）にこのスレッドを渡す時は、このHANDOFF_IDを渡す。
拡張の無い端末（スマホ等）で「CtrlM」とだけ言われた場合は、自分で「HANDOFF_ID: GPT-<UUID形式（8-4-4-4-12桁の16進）>」を1つ決めて最初の回答の末尾に1行出力し、同じく記録する。`;
    // Each blank line becomes an empty paragraph in the ChatGPT composer, so
    // collapse runs of blank lines to a single one.
    const fixedText = String(promptBase || "").replace(/\r\n?/g, "\n").trim();
    if (!fixedText) throw new Error("Ctrl+M引継ぎ本文がローカル同期されていません。");
    return `${fixedText}\n\n${identity}`.replace(/\r\n?/g, "\n").replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, "\n\n").trim();
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  const REPORT_AUDIT_STABLE_MS = 900;
  const REPORT_SELF_AUDIT_INTERVAL = 1;
  const REPORT_GUARD_VISIBLE_MS = 8000;
  const reportAuditTimers = new WeakMap();
  const reportGuardKnownTurnKeys = new Set();
  let reportGuardBaselineReady = false;
  let reportGuardArmed = false;
  let reportGuardAssistantTurnCount = 0;
  let reportGuardAuditDue = false;
  let reportGuardIgnoreNextAssistant = false;
  let reportGuardHideTimer = null;
  let reportGuardVisualSuppressed = false;
  let latestReportWarning = null;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  const REPORT_SELF_AUDIT_PROMPT = `直近の回答を、事故ログから抽出した次の7観点で自己点検してください。
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
1. 確認していないことを、推測で事実・原因・成功・失敗・不能として断定していないか。
2. 作成／送信／修正／STATIC確認などの途中状態を、起動・LIVE・完了・成功へ繰り上げていないか。
3. ユーザーの主語・目的・条件・指定経路を変えたり、別の問題へすり替えていないか。
4. 古い情報・別対象・別バージョン・推測したIDなどを現在の正本として扱っていないか。
5. 安全策・説明・曖昧表現・ユーザーへの作業返しによって、本来できる作業から逃げていないか。
6. 「直した／できた」と言う前に、対象を再確認し、関連箇所・回帰・最終状態まで必要な範囲で確認したか。
7. 人間向けの報告を、内部用語・英字コード・作業ID・枝名・状態名の羅列で説明していないか。BR_ / WORK_ / ACTIVE / HOLD / PASS / readback / gate 等は、ユーザーがその語を求めた場合を除き本文に並べない。必要なら普通の日本語へ言い換える。報告は原則「今やっていること／何が分かった／何を直した／次に何をする」の4点だけにし、内部名は正確な識別に必要な場合だけ末尾へ補足する。
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
ここまでの会話を振り返って、Codexに渡して進めるべき未処理の実作業が残っていないか確認してから次の会話に移ってください。
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
判定は、今見えている会話と、このrunで実際に確認できるtool結果・現物だけを根拠にしてください。推測で穴埋めしないでください。
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
出力規則:
- 問題がなければ「自己点検: 問題なし」の1行だけ。
- 問題があれば、監査項目一覧や長い解説は出さず、誤っていた箇所を普通の日本語で短く書き直す。内部用語・英字コードの羅列で説明しない。
- 自分で今確認できることは、ユーザーへ返さずその場で確認してから訂正する。
- 確認不能な点は確認不能と明示し、成功・失敗・不能へ勝手に繰り上げない。`;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function conversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([A-Za-z0-9_-]{8,})(?:[/?#]|$)/);
    if (match) return match[1];
    const share = location.pathname.match(/\/share\/([A-Za-z0-9_-]{8,})(?:[/?#]|$)/);
    if (share) return `share-${share[1]}`;
    return null;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function localDateStamp(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function pageTitle() {
    return document.title.replace(/\s*[|·-]\s*ChatGPT\s*$/i, "").trim() || "ChatGPT conversation";
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function dateFromCreateTime(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    const date = Number.isFinite(numeric)
      ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function attachmentIdentityValues(attachment) {
    const values = new Set();
    if (!attachment || typeof attachment !== "object") return values;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const add = (value) => {
      const text = String(value || "").trim();
      if (!text) return;
      values.add(text);
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
      // ChatGPT can expose the same upload as both:
      //   sediment://file_abc...
      //   file_abc...
      // Normalize both to the same stable file identity.
      const fileMatch = text.match(/(?:sediment:\/\/)?(file_[A-Za-z0-9_-]+)/i);
      if (fileMatch) values.add(fileMatch[1]);
    };
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    add(attachment.assetPointer);
    add(attachment.fileId);
    return values;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function mergeAttachment(existing, incoming) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming || {})) {
      if (value === null || value === undefined || value === "") continue;
      if (merged[key] === null || merged[key] === undefined || merged[key] === "") merged[key] = value;
    }
    return merged;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function attachmentRecordsFromMetadata(message) {
    const attachments = [];
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const add = (attachment) => {
      if (!attachment) return;
      const incomingIds = attachmentIdentityValues(attachment);
      let existingIndex = -1;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
      if (incomingIds.size) {
        existingIndex = attachments.findIndex(existing => {
          const existingIds = attachmentIdentityValues(existing);
          for (const id of incomingIds) if (existingIds.has(id)) return true;
          return false;
        });
      }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
      // Only use the filename as a fallback when neither representation exposes a
      // stable file identity. This avoids merging two distinct uploads with the
      // same filename.
      if (existingIndex < 0 && !incomingIds.size && attachment.name) {
        existingIndex = attachments.findIndex(existing =>
          !attachmentIdentityValues(existing).size &&
          existing.name && existing.name === attachment.name && existing.kind === attachment.kind
        );
      }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
      if (existingIndex >= 0) {
        attachments[existingIndex] = mergeAttachment(attachments[existingIndex], attachment);
      } else {
        attachments.push({ ...attachment });
      }
    };
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    for (const part of message?.content?.parts || []) {
      if (!part || typeof part !== "object") continue;
      if (part.content_type === "image_asset_pointer" || part.asset_pointer) {
        add({
          kind: "image",
          assetPointer: part.asset_pointer || null,
          name: part.name || null,
          width: Number.isFinite(part.width) ? part.width : null,
          height: Number.isFinite(part.height) ? part.height : null
        });
      } else if (part.content_type === "file_asset_pointer" || part.file_id || part.name) {
        add({
          kind: "file",
          fileId: part.file_id || null,
          assetPointer: part.asset_pointer || null,
          name: part.name || null,
          mimeType: part.mime_type || null
        });
      }
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    for (const item of message?.metadata?.attachments || []) {
      if (!item || typeof item !== "object") continue;
      add({
        kind: String(item.mime_type || "").startsWith("image/") ? "image" : "file",
        fileId: item.id || item.file_id || null,
        assetPointer: item.asset_pointer || null,
        name: item.name || item.file_name || null,
        mimeType: item.mime_type || null,
        size: Number.isFinite(item.size) ? item.size : null
      });
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    return attachments;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function attachmentLabel(attachment) {
    if (attachment.kind === "image") return attachment.name ? `[Image: ${attachment.name}]` : "[Image attachment]";
    return attachment.name ? `[Attachment: ${attachment.name}]` : "[File attachment]";
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function messageTextFromMetadata(message, attachments = []) {
    const content = message?.content;
    if (!content) return attachments.map(attachmentLabel).join("\n");
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const pieces = [];
    if (typeof content.text === "string") pieces.push(content.text);
    if (Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (typeof part === "string") {
          pieces.push(part);
        } else if (typeof part?.text === "string") {
          pieces.push(part.text);
        } else if (typeof part?.content === "string") {
          pieces.push(part.content);
        }
      }
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const normalizedText = normalizeText(pieces.filter(Boolean).join("\n\n"));
    const labels = attachments.map(attachmentLabel);
    return normalizeText([normalizedText, ...labels].filter(Boolean).join("\n\n"));
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function isVisibleMetadataMessage(message) {
    const role = message?.author?.role;
    if (role !== "user" && role !== "assistant") return false;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const type = message?.content?.content_type;
    if (!EXPORTABLE_CONTENT_TYPES.has(type)) return false;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const metadata = message?.metadata || {};
    if (metadata.is_visually_hidden_from_conversation || metadata.is_hidden || metadata.hidden || metadata.is_redacted) return false;
    if (Number(message?.weight) === 0) return false;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    // Tool calls are frequently stored with author.role=assistant. Visible chat replies
    // are addressed to "all" (or omit recipient in some exports); tool calls are
    // addressed to web/python/container/connectors/etc. Do not log those internals.
    const recipient = message?.recipient;
    if (role === "assistant" && recipient && recipient !== "all") return false;
    if (role === "user" && recipient && recipient !== "all") return false;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    return true;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function selectedMetadataNodes(payload) {
    const mapping = payload?.mapping || {};
    const currentNode = payload?.current_node;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (currentNode && mapping[currentNode]) {
      const path = [];
      const seen = new Set();
      let nodeId = currentNode;
      while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
        seen.add(nodeId);
        path.push([nodeId, mapping[nodeId]]);
        nodeId = mapping[nodeId]?.parent || null;
      }
      return path.reverse();
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    return Object.entries(mapping).sort(([, left], [, right]) => {
      return Number(left?.message?.create_time || 0) - Number(right?.message?.create_time || 0);
    });
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  // 2026-10-28 17:4x: 会話の記録の読みすぎで ChatGPT が 429（会話が「読み込めませんでした」になる）。
  // 同じ会話を15秒以内に読むなら使い回す・鍵は5分覚える（保存しない）・429なら全タブ5分休む・全タブで3秒あける
  const OSFH_CONV_MEMO_MS = 15000;
  const OSFH_CONV_BACKOFF_KEY = "osfhConvFetchBackoffUntil";
  const OSFH_CONV_LAST_KEY = "osfhConvFetchLastAt";
  const osfhConvMemo = new Map();
  let osfhSessionToken = "", osfhSessionTokenAt = 0;
  function osfhConvLs(key) { try { return Number(localStorage.getItem(key) || 0); } catch (_) { return 0; } }
  async function fetchConversationMetadata(conversationId) {
    const hit = osfhConvMemo.get(conversationId);
    if (hit && Date.now() - hit.at < OSFH_CONV_MEMO_MS) return hit.promise;
    if (Date.now() < osfhConvLs(OSFH_CONV_BACKOFF_KEY)) throw new Error("Conversation metadata request failed (429: waiting).");
    const wait = osfhConvLs(OSFH_CONV_LAST_KEY) + 3000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 3000)));
    try { localStorage.setItem(OSFH_CONV_LAST_KEY, String(Date.now())); } catch (_) {}
    const promise = osfhFetchConversationRaw(conversationId).catch((e) => {
      osfhConvMemo.delete(conversationId);
      if (/\b429\b/.test(String(e?.message || e))) { try { localStorage.setItem(OSFH_CONV_BACKOFF_KEY, String(Date.now() + 5 * 60 * 1000)); } catch (_) {} }
      throw e;
    });
    osfhConvMemo.set(conversationId, { at: Date.now(), promise });
    if (osfhConvMemo.size > 20) osfhConvMemo.delete(osfhConvMemo.keys().next().value);
    return promise;
  }
  async function osfhFetchConversationRaw(conversationId) {
    if (conversationId.startsWith("share-")) throw new Error("Shared conversation metadata endpoint is unavailable.");
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const metadataUrl = new URL(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, location.origin).href;
    if (osfhSessionToken && Date.now() - osfhSessionTokenAt < 5 * 60 * 1000) {
      const r0 = await fetch(metadataUrl, { credentials: "include", cache: "no-store", headers: { Authorization: `Bearer ${osfhSessionToken}` } });
      if (r0.ok) return r0.json();
      if (r0.status === 429) throw new Error("Conversation metadata request failed (429).");
      osfhSessionToken = "";   // 鍵が古い：最初からやり直す
    }
    let response = await fetch(metadataUrl, { credentials: "include", cache: "no-store" });
    if (response.ok) return response.json();
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (![401, 403, 404].includes(response.status)) {
      throw new Error(`Conversation metadata request failed (${response.status}).`);
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    // Some ChatGPT deployments require the same short-lived bearer token used by the web app.
    // Keep it only in this function; never persist, log, or send it to the extension background.
    const sessionUrl = new URL("/api/auth/session", location.origin).href;
    const sessionResponse = await fetch(sessionUrl, { credentials: "include", cache: "no-store" });
    if (!sessionResponse.ok) throw new Error(`ChatGPT session request failed (${sessionResponse.status}).`);
    const session = await sessionResponse.json();
    const token = session?.accessToken;
    if (!token) throw new Error("ChatGPT session did not provide a temporary access token.");
    osfhSessionToken = token; osfhSessionTokenAt = Date.now();   // このタブの中だけで5分覚える（保存しない）
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    response = await fetch(metadataUrl, {
      credentials: "include",
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error(`Conversation metadata request failed (${response.status}).`);
    return response.json();
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function metadataRecords(payload, conversationId) {
    const records = [];
    const title = normalizeText(payload?.title) || pageTitle();
    const capturedAt = new Date().toISOString();
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    for (const [nodeId, node] of selectedMetadataNodes(payload)) {
      const message = node?.message;
      if (!isVisibleMetadataMessage(message)) continue;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
      const attachments = attachmentRecordsFromMetadata(message);
      const text = messageTextFromMetadata(message, attachments);
      if (!text && !attachments.length) continue;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
      const role = message.author.role;
      const messageId = message.id || node?.id || nodeId;
      const createdDate = dateFromCreateTime(message.create_time);
      const createdAt = createdDate ? createdDate.toISOString() : null;
      const logDate = localDateStamp(createdDate || new Date());
      const recordKey = await sha256(`chatgpt-web\n${conversationId}\n${messageId}\n${role}`);
      const textHash = await sha256(text);
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
      records.push({
        schema: "chatgpt-drive-log-v3",
        source: "chatgpt-web",
        captureMethod: "metadata",
        snapshotComplete: true,
        conversationId,
        conversationTitle: title,
        pageUrl: location.href,
        logDate,
        createdAt,
        capturedAt,
        turnIndex: records.length,
        turnDomId: `metadata-${nodeId}`,
        metadataNodeId: nodeId,
        messageId,
        role,
        model: message?.metadata?.model_slug || message?.metadata?.model || null,
        attachments,
        text,
        handoffIds: extractHandoffIds(text),
        textHash,
        recordKey,
        fingerprint: `${recordKey}:${textHash}`
      });
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    return records;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function reportHandoffSightings(handoffIds) {
    const ids = Array.from(new Set((handoffIds || []).map(id => String(id || "").trim()).filter(Boolean)));
    if (!ids.length) return;
    const seenAt = new Date().toISOString();
    const pageUrl = currentLogThreadUrl() || null;
    try {
      await chrome.runtime.sendMessage({
        type: "HANDOFF_ID_SIGHTING",
        sightings: ids.map(handoffId => ({
          handoffId,
          pageUrl,
          seenAt,
          pageTitle: pageTitle()
        }))
      });
    } catch (_) {}
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function sendCaptureStatus(status) {
    try {
      await chrome.runtime.sendMessage({
        type: "CAPTURE_STATUS",
        status: { ...status, at: new Date().toISOString() }
      });
    } catch (_) {}
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function sendSnapshot(records) {
    const response = await chrome.runtime.sendMessage({ type: "LOG_SNAPSHOT", records });
    if (!response?.ok) throw new Error(response?.error || "snapshot enqueue failed");
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function canonicalTurnFromRoleNode(roleNode) {
    if (!roleNode) return null;
    return roleNode.closest?.(TURN_SELECTOR) || roleNode.closest?.("section[data-turn-id][data-turn]") || roleNode;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function closestTurn(node) {
    if (!node) return null;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return null;
    const roleNode = el.matches?.(ROLE_SELECTOR) ? el : el.closest?.(ROLE_SELECTOR);
    if (roleNode) return canonicalTurnFromRoleNode(roleNode);
    const shell = el.matches?.(SHELL_SELECTOR) ? el : el.closest?.(SHELL_SELECTOR);
    if (shell && roleOf(shell) !== "unknown") return shell;
    return null;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function turnElements() {
    const unique = [];
    const seen = new Set();
    const add = (turn) => {
      if (!turn || seen.has(turn) || roleOf(turn) === "unknown") return;
      seen.add(turn);
      unique.push(turn);
    };
    for (const shell of document.querySelectorAll(SHELL_SELECTOR)) add(shell);
    for (const roleNode of document.querySelectorAll(ROLE_SELECTOR)) add(canonicalTurnFromRoleNode(roleNode));
    return unique;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function roleNodeOf(turn) {
    if (turn?.matches?.(ROLE_SELECTOR)) return turn;
    return turn?.querySelector?.(ROLE_SELECTOR) || null;
  }


  function contentRootOf(turn, role) {
    const roleNode = roleNodeOf(turn);
    if (roleNode) return roleNode;
    if (role === "user") return turn?.querySelector?.(USER_CONTENT_SELECTOR) || turn || null;
    if (role === "assistant") return turn?.querySelector?.(ASSISTANT_CONTENT_SELECTOR) || turn || null;
    return turn || null;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function roleOf(turn) {
    const explicit = roleNodeOf(turn)?.getAttribute("data-message-author-role");
    if (explicit === "user" || explicit === "assistant") return explicit;


    const shellRole = turn?.getAttribute?.("data-turn");
    if (shellRole === "user" || shellRole === "assistant") return shellRole;


    const hasUserContent = Boolean(turn?.matches?.(USER_CONTENT_SELECTOR) || turn?.querySelector?.(USER_CONTENT_SELECTOR));
    const hasAssistantContent = Boolean(turn?.matches?.(ASSISTANT_CONTENT_SELECTOR) || turn?.querySelector?.(ASSISTANT_CONTENT_SELECTOR));
    if (hasUserContent && !hasAssistantContent) return "user";
    if (hasAssistantContent && !hasUserContent) return "assistant";
    return "unknown";
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function messageIdOf(turn) {
    const roleNode = roleNodeOf(turn);
    const root = roleNode || turn;
    if (!root) return null;
    const node = root.matches?.("[data-message-id]") ? root : root.querySelector?.("[data-message-id]");
    return node?.getAttribute?.("data-message-id") || null;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function domAttachmentsOf(turn) {
    const role = roleOf(turn);
    const root = contentRootOf(turn, role);
    if (!root) return [];
    const attachments = [];
    const seen = new Set();
    for (const image of root.querySelectorAll?.("img") || []) {
      const src = image.currentSrc || image.src || "";
      const alt = normalizeText(image.alt || "");
      if (!src && !alt) continue;
      const key = src || alt;
      if (seen.has(key)) continue;
      seen.add(key);
      attachments.push({ kind: "image", name: alt || null, assetPointer: null });
    }
    return attachments;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function textOf(turn, role) {
    const root = contentRootOf(turn, role);
    if (!root) return "";
    if (role === "assistant") {
      const markdown = root.matches?.(ASSISTANT_CONTENT_SELECTOR) ? root : root.querySelector?.(ASSISTANT_CONTENT_SELECTOR);
      if (markdown) return normalizeText(markdown.innerText);
    }
    if (role === "user") {
      const userText = root.matches?.(USER_CONTENT_SELECTOR)
        ? root
        : root.querySelector?.(".whitespace-pre-wrap, [class*='whitespace-pre-wrap'], [data-testid='collapsible-user-message-content'], [data-user-message-bubble]");
      if (userText) return normalizeText(userText.innerText);
    }
    return normalizeText(root.innerText);
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function turnDomId(turn, index) {
    const turnId = turn?.getAttribute?.("data-turn-id");
    if (turnId) return `turn-${turnId}`;
    const testId = turn?.getAttribute?.("data-testid");
    if (testId) return testId;
    const messageId = messageIdOf(turn);
    if (messageId) return `message-${messageId}`;
    if (turn?.id) return `id-${turn.id}`;
    return `index-${index}`;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function domTurnIndex(turn, fallbackIndex) {
    const testId = turn?.getAttribute?.("data-testid") || "";
    const match = testId.match(/conversation-turn-(\d+)/i);
    return match ? Number(match[1]) : fallbackIndex;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function captureTurn(turn, indexOverride = null) {
    if (!turn?.isConnected) return false;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const allTurns = turnElements();
    const fallbackIndex = Math.max(0, allTurns.indexOf(turn));
    const index = Number.isFinite(indexOverride) ? indexOverride : domTurnIndex(turn, fallbackIndex);
    const role = roleOf(turn);
    if (role === "unknown") return false;
    const attachments = domAttachmentsOf(turn);
    let text = textOf(turn, role);
    if (!text && attachments.length) text = attachments.map(attachmentLabel).join("\n");
    if (!text) return false;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const handoffIds = extractHandoffIds(text);
    if (handoffIds.length) await reportHandoffSightings(handoffIds);
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const conversationId = conversationIdFromUrl();
    if (!conversationId) {
      scheduleTurn(turn, RETRY_ROUTE_MS);
      return false;
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const messageId = messageIdOf(turn);
    const domId = turnDomId(turn, index);
    const identity = messageId || domId;
    const recordKey = await sha256(`chatgpt-web\n${conversationId}\n${identity}\n${role}`);
    const textHash = await sha256(text);
    const fingerprint = `${recordKey}:${textHash}`;
    if (lastFingerprintByRecordKey.get(recordKey) === fingerprint) return true;
    lastFingerprintByRecordKey.set(recordKey, fingerprint);
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const now = new Date();
    const record = {
      schema: "chatgpt-drive-log-v3",
      source: "chatgpt-web",
      captureMethod: "dom",
      snapshotComplete: false,
      conversationId,
      conversationTitle: pageTitle(),
      pageUrl: location.href,
      logDate: localDateStamp(now),
      createdAt: null,
      capturedAt: now.toISOString(),
      turnIndex: index,
      turnDomId: domId,
      metadataNodeId: null,
      messageId,
      role,
      model: roleNodeOf(turn)?.getAttribute?.("data-message-model-slug") || null,
      attachments,
      text,
      handoffIds,
      textHash,
      recordKey,
      fingerprint
    };
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    try {
      const response = await chrome.runtime.sendMessage({ type: "LOG_RECORD", record });
      if (!response?.ok) throw new Error(response?.error || "enqueue failed");
      scheduleBackfill(BACKFILL_AFTER_CHANGE_MS);
      return true;
    } catch (error) {
      lastFingerprintByRecordKey.delete(recordKey);
      console.debug("ChatGPT Drive Logger: enqueue failed", error);
      return false;
    }
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function isLatestAssistantTurn(turn) {
    const assistants = turnElements().filter(candidate => roleOf(candidate) === "assistant");
    return assistants.length > 0 && assistants[assistants.length - 1] === turn;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function ensureReportGuard() {
    let chip = document.getElementById(REPORT_GUARD_ID);
    if (chip) return chip;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    chip = document.createElement("div");
    chip.id = REPORT_GUARD_ID;
    chip.setAttribute("role", "status");
    chip.setAttribute("aria-live", "polite");
    Object.assign(chip.style, {
      position: "fixed",
      right: "18px",
      top: "18px",
      bottom: "auto",
      zIndex: "2147483646",
      display: "none",
      maxWidth: "460px",
      padding: "12px 15px",
      border: "2px solid #7f1d1d",
      borderRadius: "10px",
      background: "#dc2626",
      color: "#fff",
      fontSize: "14px",
      fontWeight: "800",
      lineHeight: "1.45",
      boxShadow: "0 8px 28px rgba(127, 29, 29, .42)",
      pointerEvents: "none"
    });
    document.documentElement.appendChild(chip);
    return chip;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function renderReportWarning(warning) {
    const chip = ensureReportGuard();
    latestReportWarning = warning || null;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (!warning) {
      if (reportGuardHideTimer) clearTimeout(reportGuardHideTimer);
      reportGuardHideTimer = null;
      reportGuardVisualSuppressed = false;
      chip.style.display = "none";
      chip.textContent = "";
      return;
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    // Keep the audit action available after the visual warning disappears.
    // Auto-hide only affects the red chip; Alt+V still works until the audit is handled.
    if (reportGuardVisualSuppressed) return;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    chip.textContent = `⚠ ${warning.label}  —  ${REPORT_GUARD_HOTKEY} で確認文を入力`;
    chip.style.display = "block";
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (!reportGuardHideTimer) {
      reportGuardHideTimer = setTimeout(() => {
        reportGuardHideTimer = null;
        reportGuardVisualSuppressed = true;
        chip.style.display = "none";
        chip.textContent = "";
      }, REPORT_GUARD_VISIBLE_MS);
    }
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function reportGuardTurnKey(turn) {
    if (!turn) return null;
    const role = roleOf(turn);
    const messageId = messageIdOf(turn);
    if (messageId) return `${role}:message:${messageId}`;
    const turnId = turn.getAttribute?.("data-turn-id");
    if (turnId) return `${role}:turn:${turnId}`;
    const testId = turn.getAttribute?.("data-testid");
    if (testId) return `${role}:test:${testId}`;
    const text = textOf(turn, role);
    return text ? `${role}:text:${text.slice(0, 240)}` : null;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function isReportAuditSubmission(turn) {
    if (roleOf(turn) !== "user") return false;
    const text = normalizeText(textOf(turn, "user"));
    // A hotkey insertion is not a submission. Recognize the actual user turn
    // before excluding its response from the next five-answer interval.
    return text.replace(/\s+/g, "").includes(
      normalizeText(REPORT_SELF_AUDIT_PROMPT).replace(/\s+/g, "")
    );
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function primeReportGuardBaseline() {
    reportGuardKnownTurnKeys.clear();
    for (const turn of turnElements()) {
      const key = reportGuardTurnKey(turn);
      if (key) reportGuardKnownTurnKeys.add(key);
    }
    reportGuardBaselineReady = true;
    reportGuardArmed = false;
    reportGuardAssistantTurnCount = 0;
    reportGuardAuditDue = false;
    reportGuardIgnoreNextAssistant = false;
    reportGuardVisualSuppressed = false;
    renderReportWarning(null);
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function noteReportGuardTurn(turn) {
    if (!reportGuardBaselineReady || !turn?.isConnected) return;
    const role = roleOf(turn);
    if (role !== "user" && role !== "assistant") return;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const key = reportGuardTurnKey(turn);
    const isNewTurn = Boolean(key && !reportGuardKnownTurnKeys.has(key));
    if (key) reportGuardKnownTurnKeys.add(key);
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (role === "user" && isNewTurn) {
      reportGuardArmed = true;
      reportGuardIgnoreNextAssistant = isReportAuditSubmission(turn);
      if (reportGuardIgnoreNextAssistant) {
        reportGuardAssistantTurnCount = 0;
        reportGuardAuditDue = false;
        renderReportWarning(null);
      }
      return;
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (role !== "assistant" || !isLatestAssistantTurn(turn)) return;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (isNewTurn) {
      reportGuardArmed = true;
      if (reportGuardIgnoreNextAssistant) {
        reportGuardIgnoreNextAssistant = false;
      } else if (!reportGuardAuditDue) {
        reportGuardAssistantTurnCount += 1;
        if (reportGuardAssistantTurnCount >= REPORT_SELF_AUDIT_INTERVAL) {
          reportGuardAuditDue = true;
          reportGuardVisualSuppressed = false;
        }
      }
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (reportGuardArmed && reportGuardAuditDue) scheduleReportAudit(turn);
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function auditAssistantTurn(turn) {
    if (
      !reportGuardArmed ||
      !reportGuardAuditDue ||
      !turn?.isConnected ||
      roleOf(turn) !== "assistant" ||
      !isLatestAssistantTurn(turn)
    ) return;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    renderReportWarning({
      id: "PERIODIC_SELF_AUDIT",
      label: `自己チェック時点（直近${REPORT_SELF_AUDIT_INTERVAL}回答）`,
      severity: 3,
      matched: null,
      prompt: REPORT_SELF_AUDIT_PROMPT
    });
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function scheduleReportAudit(turn, delay = REPORT_AUDIT_STABLE_MS) {
    if (!turn || roleOf(turn) !== "assistant") return;
    const previous = reportAuditTimers.get(turn);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      reportAuditTimers.delete(turn);
      auditAssistantTurn(turn);
    }, delay);
    reportAuditTimers.set(turn, timer);
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function activeComposer() {
    const active = document.activeElement;
    if (!active) return null;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const isTextArea = active.tagName === "TEXTAREA" || active.tagName === "INPUT";
    const isEditable = active.isContentEditable || active.getAttribute?.("contenteditable") === "true";
    if (!isTextArea && !isEditable) return null;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (
      active.id === "prompt-textarea" ||
      active.matches?.("textarea[data-id='root'], textarea[placeholder], [data-testid='composer-text-input'], .ProseMirror[contenteditable='true'], [contenteditable='true'][data-lexical-editor='true']") ||
      active.closest?.("form")?.querySelector?.("#prompt-textarea") === active
    ) return active;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const prompt = document.querySelector("#prompt-textarea");
    if (prompt && (active === prompt || prompt.contains(active))) return active;
    return null;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function insertIntoComposer(composer, text) {
    const prefix = (() => {
      if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
        const start = Number.isFinite(composer.selectionStart) ? composer.selectionStart : composer.value.length;
        return start > 0 && !String(composer.value || "").slice(0, start).endsWith("\n") ? "\n\n" : "";
      }
      return normalizeText(composer.innerText || composer.textContent || "") ? "\n\n" : "";
    })();
    const payload = prefix + text;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
      const start = Number.isFinite(composer.selectionStart) ? composer.selectionStart : composer.value.length;
      const end = Number.isFinite(composer.selectionEnd) ? composer.selectionEnd : start;
      composer.setRangeText(payload, start, end, "end");
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: payload }));
      return true;
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    composer.focus();
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !composer.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, payload);
    } catch (_) {}
    if (inserted) return true;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    // Last-resort DOM fallback for UI variants where execCommand is unavailable.
    // Dispatching input lets React/Lexical observe the change; no automatic send occurs.
    composer.appendChild(document.createTextNode(payload));
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: payload }));
    return true;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function reportGuardHotkey(event) {
    if (!(event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyV")) return;
    const composer = activeComposer();
    if (!composer || !latestReportWarning || !reportGuardAuditDue) return;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    event.preventDefault();
    event.stopPropagation();
    const composerText = composer.tagName === "TEXTAREA" || composer.tagName === "INPUT"
      ? composer.value : composer.innerText || composer.textContent || "";
    // Repeated Alt+V must not insert duplicate audit prompts.
    if (normalizeText(composerText).includes(normalizeText(latestReportWarning.prompt))) return;
    if (!insertIntoComposer(composer, latestReportWarning.prompt)) return;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    // Insertion alone does not finish the audit. Keep the due state until the
    // matching user turn is actually submitted; hide only the visual notice.
    if (reportGuardHideTimer) clearTimeout(reportGuardHideTimer);
    reportGuardHideTimer = null;
    reportGuardVisualSuppressed = true;
    const chip = ensureReportGuard();
    chip.style.display = "none";
    chip.textContent = "";
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function insertHandoffPrompt(promptBase) {
    const composer = activeComposer() ||
      document.querySelector("#prompt-textarea, textarea[data-id='root'], [data-testid='composer-text-input'], .ProseMirror[contenteditable='true'], [contenteditable='true'][data-lexical-editor='true']");
    if (!composer) return false;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const composerText = composer.tagName === "TEXTAREA" || composer.tagName === "INPUT"
      ? composer.value : composer.innerText || composer.textContent || "";
    const handoffPrompt = buildHandoffPrompt(promptBase);
    // A new content-script instance may generate another HANDOFF_ID for the
    // same prompt. Comparing the whole prompt then treats an existing Ctrl+M
    // insertion as different and appends a second copy. Compare the stable
    // canonical base independently of the per-instance thread ID.
    const normalizedComposer = String(composerText).replace(/\s+/g, "");
    const normalizedBase = String(promptBase || "").replace(/\s+/g, "").trim();
    if (normalizedBase && normalizedComposer.includes(normalizedBase)) return true;
    // Protect a draft inserted from an older revision of the canonical prompt.
    if (normalizedComposer.includes("作業引継ぎを開始する。") &&
        /HANDOFF_ID\s*:\s*(?:EXT|GPT)-[0-9a-fA-F-]{36}/.test(String(composerText))) return true;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    composer.focus();
    return insertIntoComposer(composer, handoffPrompt);
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  const OSFH_COMPOSER_SELECTOR = "#prompt-textarea, textarea[data-id='root'], [data-testid='composer-text-input'], .ProseMirror[contenteditable='true'], [contenteditable='true'][data-lexical-editor='true']";
  function composerElement() {
    const active = activeComposer();
    if (active && active.closest?.("form")) return active;
    return Array.from(document.querySelectorAll(OSFH_COMPOSER_SELECTOR)).find(el => el.closest("form")) || null;
  }
 
 
  function composerTextOf(composer) {
    if (!composer) return "";
    return String(
      composer.tagName === "TEXTAREA" || composer.tagName === "INPUT"
        ? composer.value
        : composer.innerText || composer.textContent || ""
    ).trim();
  }
 
 
  function buttonUsable(node) {
    if (!node || node.disabled) return false;
    if (String(node.getAttribute?.("aria-disabled") || "").toLowerCase() === "true") return false;
    if (String(node.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") return false;
    return node.getClientRects?.().length !== 0;
  }
 
 
  function controlButtonLabel(node) {
    return String(
      node?.getAttribute?.("aria-label") ||
      node?.getAttribute?.("title") ||
      node?.innerText ||
      node?.textContent ||
      ""
    ).trim();
  }
 
 
  function findStopButton() {
    const exact = document.querySelector("button[data-testid='stop-button'], [data-testid='stop-button']");
    if (buttonUsable(exact)) return exact;
 
 
    for (const node of document.querySelectorAll("button, [role='button']")) {
      if (!buttonUsable(node)) continue;
      const label = controlButtonLabel(node);
      if (label === "停止" || label === "応答を停止" || label === "Stop" || label === "Stop generating") return node;
    }
 
    // The 2026-09 ChatGPT UI dropped data-testid on composer buttons; accept any
    // composer button whose label mentions stop, except voice controls.
    const composerRoot = composerElement()?.closest?.("form") || document;
    for (const node of composerRoot.querySelectorAll("button, [role='button']")) {
      if (!buttonUsable(node)) continue;
      const label = String(node.getAttribute?.("aria-label") || node.getAttribute?.("title") || "").trim();
      if (!label || label.includes("音声") || /voice/i.test(label)) continue;
      if (label.includes("停止") || /\bstop\b/i.test(label)) return node;
    }
    return null;
  }
 
 
  function composerButtonLabels() {
    const composerRoot = composerElement()?.closest?.("form") || document;
    return [...composerRoot.querySelectorAll("button, [role='button']")]
      .map(node => controlButtonLabel(node))
      .filter(Boolean)
      .slice(0, 12);
  }
 
 
  function findSendButton() {
    const exact = document.querySelector("button[data-testid='send-button'], [data-testid='send-button']");
    if (buttonUsable(exact)) return exact;
 
 
    for (const node of document.querySelectorAll("button, [role='button']")) {
      if (!buttonUsable(node)) continue;
      const label = controlButtonLabel(node);
      if (label === "送信" || label === "メッセージを送信" || label === "Send" || label === "Send message") return node;
    }
    return null;
  }
 
 
  function waitForCondition(check, timeoutMs = STOP_RESUME_WAIT_MS, intervalMs = 80) {
    return new Promise(resolve => {
      const started = Date.now();
      const tick = () => {
        let value = null;
        try { value = check(); } catch (_) {}
        if (value) return resolve(value);
        if (Date.now() - started >= timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }
 
 
  // Event trail in the page's localStorage (shared with chatgpt.com pages of this
  // profile) so a monitor can later see what happened in the user's own tabs.
  const OSFH_EVENTS_KEY = "osfh_drive_logger_events";
  const OSFH_EVENTS_MAX = 200;
 
 
  function osfhEvent(type, detail = "") {
    try {
      const list = JSON.parse(localStorage.getItem(OSFH_EVENTS_KEY) || "[]");
      list.push({
        t: new Date().toISOString(),
        type,
        detail: String(detail || "").slice(0, 300),
        conv: (location.pathname.match(/\/c\/([^/]+)/) || [])[1] || "",
        vis: document.visibilityState,
        focus: document.hasFocus(),
        inst: OSFH_INSTANCE_ID
      });
      localStorage.setItem(OSFH_EVENTS_KEY, JSON.stringify(list.slice(-OSFH_EVENTS_MAX)));
    } catch (_) {}
    console.info(`ChatGPT Drive Logger: [${type}] ${detail}`);
  }
 
 
  // After the stop button was clicked, keep trying to send the resume text for
  // this long; a stopped response without "再開" leaves the work silently halted.
  const STOP_RESUME_PENDING_MS = 120000;
  let stopResumePendingUntil = 0;
 
 
  async function trySendResume(composerWaitMs) {
    // 2026-10-28 Dan「監査の続きなら監査、他の作業なら再開文やで」
    if (await articleGuardResumeInstead(conversationIdFromUrl())) {
      stopResumePendingUntil = 0;
      osfhEvent("resume_audit_instead", "最後の依頼が見張りの監査：再開の型ではなく同じ監査の依頼を送り直す");
      return true;
    }
    const composer = await waitForCondition(() => {
      if (findStopButton()) return null;
      return composerElement();
    }, composerWaitMs);
    if (!composer) {
      osfhEvent("resume_fail", "composer_not_ready");
      return false;
    }
 
 
    const existing = composerTextOf(composer);
    if (existing && !normalizeText(existing).includes(STOP_RESUME_KEY)) {
      osfhEvent("resume_abort", "unsent_user_text_in_composer");
      stopResumePendingUntil = 0;
      return false;
    }
 
 
    if (!existing) {
      composer.focus();
      if (!insertIntoComposer(composer, STOP_RESUME_TEXT)) {
        osfhEvent("resume_fail", "insert_failed");
        return false;
      }
    }
 
 
    // After stop, ChatGPT can take several seconds to show the send button (seen live 2026-09-26).
    const sendButton = await waitForCondition(() => findSendButton(), 10000, 100);
    if (!sendButton) {
      osfhEvent("resume_fail", `send_not_ready buttons=${composerButtonLabels().join("/")}`);
      return false;
    }
 
 
    sendButton.click();
    const sent = await waitForCondition(() => {
      if (findStopButton()) return true;
      return composerTextOf(composerElement()) ? null : true;
    }, 5000, 100);
    if (!sent) {
      osfhEvent("resume_fail", "send_not_confirmed");
      return false;
    }
 
 
    stopResumePendingUntil = 0;
    osfhEvent("resume_sent");
    return true;
  }
 
 
  async function runStopResumeShortcut() {
    if (stopResumeInFlight) return false;
    const stopButton = findStopButton();
    if (!stopButton) {
      osfhEvent("stop_not_found", `buttons=${composerButtonLabels().join("/")}`);
      return false;
    }
 
 
    stopResumeInFlight = true;
    try {
      stopButton.click();
      stopResumePendingUntil = Date.now() + STOP_RESUME_PENDING_MS;
      osfhEvent("stop_clicked", controlButtonLabel(stopButton));
      return await trySendResume(15000);
    } catch (error) {
      osfhEvent("resume_fail", `error ${error?.message || error}`);
      return false;
    } finally {
      stopResumeInFlight = false;
    }
  }
 
 
  // Called from the periodic scan: finish a resume that failed right after stop.
  async function maybeRetryPendingResume() {
    if (!stopResumePendingUntil || stopResumeInFlight) return false;
    if (Date.now() > stopResumePendingUntil) {
      stopResumePendingUntil = 0;
      osfhEvent("resume_gave_up", "pending window expired");
      return false;
    }
    if (findStopButton()) return false;
    stopResumeInFlight = true;
    try {
      osfhEvent("resume_retry");
      return await trySendResume(3000);
    } catch (error) {
      osfhEvent("resume_fail", `retry error ${error?.message || error}`);
      return false;
    } finally {
      stopResumeInFlight = false;
    }
  }
 
 
  function stopResumeHotkey(event) {
    if (!(event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && event.code === "KeyM")) return;
    event.preventDefault();
    event.stopPropagation();
    runStopResumeShortcut().catch(() => {});
  }
 
 
  function isSafetyCheckStatusTextNode(textNode) {
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return false;
    const text = String(textNode.nodeValue || "");
    if (!text.includes(SAFETY_CHECK_TEXT) && !text.includes(CONNECTION_INTERRUPTED_TEXT) && !text.includes(CONNECTION_INTERRUPTED_TEXT_2026_10)) return false;
    const parent = textNode.parentElement;
    if (!parent || parent.getClientRects?.().length === 0) return false;
    if (parent.closest?.(ROLE_SELECTOR) || parent.closest?.(TURN_SELECTOR)) return false;
    // 2026-09 UI: turns lost the role attributes, so skip message bodies
    // (assistant markdown / user bubbles) explicitly; status lines are outside them.
    // Do not exclude [data-selected-text-overlay-target]: the safety-check status line carries it too.
    if (parent.closest?.("[data-markdown-text-style], [data-user-message-bubble], .markdown, .prose")) return false;
    if (parent.closest?.("#prompt-textarea, textarea, input, [contenteditable='true']")) return false;
    return true;
  }
 
 
  // The interrupted-connection notice is rendered as the composer placeholder
  // (<p class="placeholder" data-placeholder="...">), which is an attribute,
  // not a text node, so the text walker below never sees it.
  const STATUS_PLACEHOLDER_SELECTOR = "[data-placeholder], [placeholder], [aria-placeholder]";
 
 
  function placeholderTextOf(el) {
    return String(
      el?.getAttribute?.("data-placeholder") ||
      el?.getAttribute?.("placeholder") ||
      el?.getAttribute?.("aria-placeholder") ||
      ""
    );
  }
 
 
  function isStatusPlaceholderText(text) {
    return text.includes(SAFETY_CHECK_TEXT) || text.includes(CONNECTION_INTERRUPTED_TEXT) || text.includes(CONNECTION_INTERRUPTED_TEXT_2026_10);
  }
 
 
  function findSafetyCheckStatusNode() {
    if (!document.body) return null;
    for (const el of document.querySelectorAll(STATUS_PLACEHOLDER_SELECTOR)) {
      if (el.getClientRects?.().length === 0) continue;
      if (isStatusPlaceholderText(placeholderTextOf(el))) return el;
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (isSafetyCheckStatusTextNode(node)) return node.parentElement;
    }
    return findSplitStatusElement();
  }
 
 
  // The 2026-09 status line ("回答前に、このリクエストについて追加の安全性チェックを
  // 行っています。") is drawn with a shimmer effect that splits the sentence
  // across many spans, so no single text node holds the whole phrase. Match on
  // the smallest ancestor whose combined text contains it instead.
  const STATUS_SPLIT_MAX_CHARS = 200;
  const STATUS_SPLIT_MAX_DEPTH = 6;
 
 
  function compactStatusText(text) {
    return String(text || "").replace(/\s+/g, "");
  }
 
 
  function findSplitStatusElement() {
    if (!document.body) return null;
    const keys = [SAFETY_CHECK_TEXT_2026_09, SAFETY_CHECK_TEXT, CONNECTION_INTERRUPTED_TEXT, CONNECTION_INTERRUPTED_TEXT_2026_10].map(compactStatusText);
    // Do not read document.body.textContent: ChatGPT embeds ~20MB of script
    // data, which makes that read take about a second. Walk visible text only.
    const checked = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      if (!compactStatusText(node.nodeValue)) continue;
      if (node.parentElement.closest?.("[data-markdown-text-style], [data-user-message-bubble]")) continue;
      let el = node.parentElement;
      for (let depth = 0; el && el !== document.body && depth < STATUS_SPLIT_MAX_DEPTH; depth++, el = el.parentElement) {
        if (checked.has(el)) break;
        checked.add(el);
        const text = compactStatusText(el.textContent);
        if (text.length > STATUS_SPLIT_MAX_CHARS) break;
        if (!keys.some(key => text.includes(key))) continue;
        if (el.getClientRects?.().length === 0) break;
        if (el.closest?.(ROLE_SELECTOR) || el.closest?.(TURN_SELECTOR)) break;
        if (el.closest?.("[data-markdown-text-style], [data-user-message-bubble], .markdown, .prose")) break;
        if (el.closest?.("#prompt-textarea, textarea, input, [contenteditable='true']")) break;
        return el;
      }
    }
    return null;
  }
 
 
  // Stall watch: while a response is generating (stop button visible), if the
  // latest turn's text does not change for STALL_RESUME_MS, stop and send "再開".
  // Threshold can be overridden per profile via localStorage "osfh_stall_resume_ms".
  // At most STALL_RESUME_MAX_CONSECUTIVE automatic resumes per conversation until a
  // response finishes on its own, so an unattended loop cannot burn usage.
  const STALL_RESUME_DEFAULT_MS = 10 * 60 * 1000;
  const STALL_RESUME_MAX_CONSECUTIVE = 3;
  let stallFingerprint = "";
  let stallSince = 0;
  let stallConv = "";
  let stallResumeCount = 0;
 
 
  function stallResumeThresholdMs() {
    try {
      const v = Number(localStorage.getItem("osfh_stall_resume_ms"));
      if (Number.isFinite(v) && v >= 10000) return v;
    } catch (_) {}
    return STALL_RESUME_DEFAULT_MS;
  }
 
 
  function latestTurnFingerprint() {
    const turns = document.querySelectorAll("[data-turn-key], " + TURN_SELECTOR);
    const last = turns[turns.length - 1];
    if (!last) return "";
    const text = String(last.textContent || "");
    return `${turns.length}:${text.length}:${text.slice(-80)}`;
  }
 
 
  async function maybeStallResume() {
    const conv = (location.pathname.match(/\/c\/([^/]+)/) || [])[1] || "";
    if (conv !== stallConv) {
      stallConv = conv;
      stallResumeCount = 0;
      stallFingerprint = "";
      stallSince = 0;
    }
    if (!conv || stopResumeInFlight) return false;
    if (!findStopButton()) {
      // Response finished (or idle): a natural finish clears the consecutive count.
      if (stallSince && stallFingerprint) stallResumeCount = 0;
      stallFingerprint = "";
      stallSince = 0;
      return false;
    }
 
 
    const now = Date.now();
    const fingerprint = latestTurnFingerprint();
    if (fingerprint !== stallFingerprint || !stallSince) {
      stallFingerprint = fingerprint;
      stallSince = now;
      return false;
    }
 
 
    const threshold = stallResumeThresholdMs();
    if (now - stallSince < threshold) return false;
    if (stallResumeCount >= STALL_RESUME_MAX_CONSECUTIVE) {
      if (stallResumeCount === STALL_RESUME_MAX_CONSECUTIVE) {
        osfhEvent("stall_limit_reached", `no auto resume after ${STALL_RESUME_MAX_CONSECUTIVE} consecutive stalls`);
        stallResumeCount += 1;
      }
      return false;
    }
 
 
    stallResumeCount += 1;
    stallSince = now;
    osfhEvent("stall_detected", `no change for ${Math.round(threshold / 60000 * 10) / 10}min (auto resume ${stallResumeCount}/${STALL_RESUME_MAX_CONSECUTIVE})`);
    const ok = await runStopResumeShortcut();
    stallFingerprint = "";
    stallSince = 0;
    return ok;
  }
 
 
  async function maybeAutoStopResumeSafetyCheck() {
    if (stopResumePendingUntil) {
      const retried = await maybeRetryPendingResume();
      if (retried) safetyCheckLatched = true;
      if (stopResumePendingUntil) return retried;
    }
    const statusNode = findSafetyCheckStatusNode();
    if (!statusNode) {
      safetyCheckLatched = false;
      safetyCheckLastAttemptAt = 0;
      return maybeStallResume();
    }
    if (safetyCheckLatched || stopResumeInFlight) return false;
 
 
    const now = Date.now();
    if (safetyCheckLastAttemptAt && (now - safetyCheckLastAttemptAt) < SAFETY_CHECK_RETRY_MS) return false;
    safetyCheckLastAttemptAt = now;
 
 
    osfhEvent("status_detected", compactStatusText(statusNode.textContent).slice(0, 60));
    const ok = await runStopResumeShortcut();
    if (ok) safetyCheckLatched = true;
    return ok;
  }
 
 
  function scheduleSafetyCheckStopResume(delay = 80) {
    if (osfhRetired || safetyCheckScanTimer) return;
    safetyCheckScanTimer = setTimeout(() => {
      safetyCheckScanTimer = null;
      maybeAutoStopResumeSafetyCheck().catch(() => {});
    }, delay);
  }
 
 
  function mutationMayContainSafetyCheckUi(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const text = String(mutation.target?.nodeValue || "");
        if (text.includes(SAFETY_CHECK_TEXT) || text.includes(CONNECTION_INTERRUPTED_TEXT) || text.includes(CONNECTION_INTERRUPTED_TEXT_2026_10)) return true;
      }
      if (mutation.type === "attributes") {
        if (isStatusPlaceholderText(placeholderTextOf(mutation.target))) return true;
      }
      for (const node of mutation.addedNodes || []) {
        const text = String(node?.textContent || node?.nodeValue || "");
        if (text.includes(SAFETY_CHECK_TEXT) || text.includes(CONNECTION_INTERRUPTED_TEXT) || text.includes(CONNECTION_INTERRUPTED_TEXT_2026_10)) return true;
        if (node?.nodeType === Node.ELEMENT_NODE) {
          if (isStatusPlaceholderText(placeholderTextOf(node))) return true;
          for (const el of node.querySelectorAll?.(STATUS_PLACEHOLDER_SELECTOR) || []) {
            if (isStatusPlaceholderText(placeholderTextOf(el))) return true;
          }
        }
      }
    }
    return false;
  }
 
 
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "INSERT_HANDOFF_PROMPT") return;
    // chrome.runtime listeners survive our local retire() cleanup. When an
    // extension reload/reinjection leaves multiple instances alive, only the
    // instance currently stamped on this page is allowed to insert a prompt.
    // Check the stamp synchronously (the retirement timer runs every second).
    if (osfhRetired || document.documentElement.getAttribute(OSFH_INSTANCE_ATTR) !== OSFH_INSTANCE_ID) return;
    try {
      const ok = insertHandoffPrompt(message.promptBase);
      sendResponse({ ok, error: ok ? null : "ChatGPT入力欄を取得できません。" });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return false;
  });
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  document.addEventListener("keydown", reportGuardHotkey, true);
  document.addEventListener("keydown", stopResumeHotkey, true);
  osfhKeyHandlers.push(reportGuardHotkey, stopResumeHotkey);
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function scheduleTurn(turn, delay = STABLE_MS) {
    if (!turn) return;
    const previous = timers.get(turn);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      timers.delete(turn);
      captureTurn(turn).catch(() => {});
    }, delay);
    timers.set(turn, timer);
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function initialScan() {
    for (const turn of turnElements()) scheduleTurn(turn, 350);
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function findScrollRoot() {
    const explicit = document.querySelector(SCROLL_SELECTOR);
    if (explicit) return explicit;
    const candidates = Array.from(document.querySelectorAll("main, [class*='overflow-y-auto'], [class*='overflow-auto']"));
    return candidates
      .filter(el => el.scrollHeight > el.clientHeight + 100)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function waitForRoleNode(shell) {
    const started = Date.now();
    while (Date.now() - started < FALLBACK_WAIT_MS) {
      if (roleOf(shell) !== "unknown") return true;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    return false;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function hydrateDomFallback(conversationId, metadataError) {
    const shells = Array.from(document.querySelectorAll(SHELL_SELECTOR));
    const targets = shells.length ? shells : turnElements();
    if (!targets.length) {
      await sendCaptureStatus({
        conversationId,
        source: "dom-fallback",
        complete: false,
        messageCount: 0,
        missing: 0,
        error: metadataError?.message || "No conversation turns found."
      });
      return;
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const scrollRoot = findScrollRoot();
    const originalTop = scrollRoot ? scrollRoot.scrollTop : window.scrollY;
    let captured = 0;
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const shell = targets[i];
        shell.scrollIntoView?.({ block: "center", behavior: "instant" });
        await waitForRoleNode(shell);
        const turn = closestTurn(shell) || shell;
        if (await captureTurn(turn, i)) captured += 1;
      }
    } finally {
      if (scrollRoot) scrollRoot.scrollTo({ top: originalTop, behavior: "instant" });
      else window.scrollTo({ top: originalTop, behavior: "instant" });
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    const missing = Math.max(0, targets.length - captured);
    await sendCaptureStatus({
      conversationId,
      source: "dom-fallback",
      complete: missing === 0,
      messageCount: captured,
      missing,
      error: metadataError?.message || null
    });
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function runBackfill() {
    const conversationId = conversationIdFromUrl();
    if (!conversationId) return;
    if (backfillInFlight) {
      if (backfillConversationId === conversationId) return backfillInFlight;
      await backfillInFlight.catch(() => {});
      if (conversationIdFromUrl() !== conversationId) return false;
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    backfillConversationId = conversationId;
    backfillInFlight = (async () => {
      try {
        const payload = await fetchConversationMetadata(conversationId);
        const records = await metadataRecords(payload, conversationId);
        if (!records.length) throw new Error("Conversation metadata contained no visible user/assistant messages.");
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
        await sendSnapshot(records);
        for (const record of records) lastFingerprintByRecordKey.set(record.recordKey, record.fingerprint);
        await sendCaptureStatus({
          conversationId,
          source: "metadata",
          complete: true,
          messageCount: records.length,
          missing: 0,
          error: null
        });
        return true;
      } catch (error) {
        console.debug("ChatGPT Drive Logger: metadata backfill unavailable", error);
        await hydrateDomFallback(conversationId, error);
        return false;
      }
    })().finally(() => {
      backfillInFlight = null;
      backfillConversationId = null;
    });
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    return backfillInFlight;
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function scheduleBackfill(delay = 500) {
    if (backfillTimer) clearTimeout(backfillTimer);
    backfillTimer = setTimeout(() => {
      backfillTimer = null;
      runBackfill().catch(() => {});
    }, delay);
  }
  // v14（2026-10-29）：画面の会話が変わって答えを書き終わったら、記録を読み直す（画面から新しい発言を拾えない今のChatGPT向け）
  const OSFH_LOG_REFRESH_MIN_MS = 60000;
  let osfhLogDomSeen = "", osfhLogLastRefresh = Date.now();
  function osfhLogRefreshTick(now = Date.now()) {
    if (osfhRetired) return false;
    const cid = conversationIdFromUrl();
    if (!cid || cid.startsWith("share-")) return false;
    if (findStopButton()) return false;                 // 答えを書いている途中は待つ
    if (articleGuardBackingOff()) return false;          // 会話の記録の読みすぎで休み中
    const dom = articleGuardDomLastAssistant();
    if (!dom || dom === osfhLogDomSeen) return false;     // 画面が変わっていない
    if (now - osfhLogLastRefresh < OSFH_LOG_REFRESH_MIN_MS) return false;
    osfhLogDomSeen = dom; osfhLogLastRefresh = now;
    scheduleBackfill(0);
    return true;
  }
  setInterval(() => { try { osfhLogRefreshTick(); } catch (_) {} }, 10000);
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  function autoRetryButtonLabel(node) {
    return String(
      node?.getAttribute?.("aria-label") ||
      node?.innerText ||
      node?.textContent ||
      ""
    ).trim();
  }
 
 
  function isAutoRetryButton(node) {
    const labels = [
      node?.getAttribute?.("aria-label"),
      node?.innerText,
      node?.textContent,
    ];
    return labels.some(label => String(label || "").trim() === AUTO_RETRY_BUTTON_TEXT);
  }
 
 
  function findRetryButtonForPageText(requiredText) {
    const pageText = String(document.body?.innerText || document.body?.textContent || "");
    if (!pageText.includes(requiredText)) return null;
 
 
    for (const node of document.querySelectorAll("button, [role='button']")) {
      if (node?.disabled) continue;
      if (String(node?.getAttribute?.("aria-disabled") || "").toLowerCase() === "true") continue;
      if (isAutoRetryButton(node)) return node;
    }
    return null;
  }
 
 
  function findTimeoutRetryButton() {
    return findRetryButtonForPageText(AUTO_RETRY_TIMEOUT_TEXT);
  }
 
 
  function maybeAutoRetryTimeout() {
    const pageText = String(document.body?.innerText || document.body?.textContent || "");
    if (!pageText.includes(AUTO_RETRY_TIMEOUT_TEXT)) {
      autoRetryLastButton = null;
      autoRetryLastClickAt = 0;
      return false;
    }
 
 
    const button = findTimeoutRetryButton();
    if (!button) return false;
 
 
    const now = Date.now();
    if (autoRetryLastClickAt && (now - autoRetryLastClickAt) < AUTO_RETRY_REPEAT_MS) {
      return false;
    }
 
 
    autoRetryLastButton = button;
    autoRetryLastClickAt = now;
    try {
      button.click();
      osfhEvent("retry_clicked", "timeout");
      return true;
    } catch (error) {
      console.debug("ChatGPT Drive Logger: timeout retry click failed", error);
      return false;
    }
  }
 
 
  function maybeAutoRetryStreamError() {
    const pageText = String(document.body?.innerText || document.body?.textContent || "");
    const errorText = AUTO_RETRY_STREAM_ERROR_TEXTS.find(text => pageText.includes(text));
    if (!errorText) {
      autoRetryStreamErrorLatched = false;
      autoRetryStreamErrorClicks = 0;
      autoRetryStreamErrorLastClickAt = 0;
      return false;
    }
 
 
    if (autoRetryStreamErrorLatched) return false;
 
 
    const button = findRetryButtonForPageText(errorText);
    if (!button) return false;
 
 
    // Up to AUTO_RETRY_STREAM_ERROR_MAX_CLICKS attempts per visible error
    // episode, spaced by AUTO_RETRY_STREAM_ERROR_GAP_MS (the first click alone
    // often leaves the error in place). The counter resets only after the error
    // text disappears, so a persistent error never becomes an endless loop.
    const now = Date.now();
    if (autoRetryStreamErrorLastClickAt && (now - autoRetryStreamErrorLastClickAt) < AUTO_RETRY_STREAM_ERROR_GAP_MS) {
      scheduleAutoRetryTimeout(AUTO_RETRY_STREAM_ERROR_GAP_MS - (now - autoRetryStreamErrorLastClickAt) + 50);
      return false;
    }
    autoRetryStreamErrorClicks += 1;
    autoRetryStreamErrorLastClickAt = now;
    if (autoRetryStreamErrorClicks >= AUTO_RETRY_STREAM_ERROR_MAX_CLICKS) autoRetryStreamErrorLatched = true;
    else scheduleAutoRetryTimeout(AUTO_RETRY_STREAM_ERROR_GAP_MS + 50);
    try {
      button.click();
      osfhEvent("retry_clicked", errorText);
      return true;
    } catch (error) {
      console.debug("ChatGPT Drive Logger: stream error retry click failed", error);
      return false;
    }
  }
 
 
  function scheduleAutoRetryTimeout(delay = 80) {
    if (osfhRetired || autoRetryScanTimer) return;
    autoRetryScanTimer = setTimeout(() => {
      autoRetryScanTimer = null;
      maybeAutoRetryTimeout();
      maybeAutoRetryStreamError();
    }, delay);
  }
 
 
  function mutationMayContainAutoRetryUi(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const text = String(mutation.target?.nodeValue || "");
        if (
          text.includes(AUTO_RETRY_TIMEOUT_TEXT) ||
          AUTO_RETRY_STREAM_ERROR_TEXTS.some(errorText => text.includes(errorText)) ||
          text.trim() === AUTO_RETRY_BUTTON_TEXT
        ) return true;
      }
      for (const node of mutation.addedNodes || []) {
        const text = String(node?.textContent || "");
        if (
          text.includes(AUTO_RETRY_TIMEOUT_TEXT) ||
          AUTO_RETRY_STREAM_ERROR_TEXTS.some(errorText => text.includes(errorText)) ||
          text.includes(AUTO_RETRY_BUTTON_TEXT)
        ) return true;
      }
    }
    return false;
  }
 
 
  function startObserver() {
    if (osfhRetired || observerStarted) return;
    observerStarted = true;
    observer = new MutationObserver((mutations) => {
      const touched = new Set();
      for (const mutation of mutations) {
        const targetTurn = closestTurn(mutation.target);
        if (targetTurn) touched.add(targetTurn);
        for (const node of mutation.addedNodes || []) {
          const addedTurn = closestTurn(node);
          if (addedTurn) touched.add(addedTurn);
          if (node.nodeType === Node.ELEMENT_NODE) {
            for (const shell of node.querySelectorAll?.(SHELL_SELECTOR) || []) {
              if (roleOf(shell) !== "unknown") touched.add(shell);
            }
            for (const roleNode of node.querySelectorAll?.(ROLE_SELECTOR) || []) {
              const nestedTurn = canonicalTurnFromRoleNode(roleNode);
              if (nestedTurn) touched.add(nestedTurn);
            }
          }
        }
      }
      for (const turn of touched) {
        scheduleTurn(turn);
        noteReportGuardTurn(turn);
      }
      // Run synchronously: observer callbacks are not throttled in hidden tabs,
      // while setTimeout can be delayed up to a minute there.
      if (mutationMayContainAutoRetryUi(mutations)) {
        maybeAutoRetryTimeout();
        maybeAutoRetryStreamError();
      }
      if (mutationMayContainSafetyCheckUi(mutations)) scheduleSafetyCheckStopResume();
    });
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    primeReportGuardBaseline();
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-placeholder", "placeholder", "aria-placeholder"]
    });
    initialScan();
    scheduleAutoRetryTimeout();
    scheduleSafetyCheckStopResume();
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  async function bootstrap() {
    // Metadata first: this recovers virtualized history without polluting today's log
    // with only the currently mounted DOM subset.
    await runBackfill().catch(() => {});
    startObserver();
  }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  bootstrap();
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    autoRetryLastButton = null;
    autoRetryLastClickAt = 0;
    autoRetryStreamErrorLatched = false;
    autoRetryStreamErrorClicks = 0;
    autoRetryStreamErrorLastClickAt = 0;
    if (autoRetryScanTimer) {
      clearTimeout(autoRetryScanTimer);
      autoRetryScanTimer = null;
    }
    lastFingerprintByRecordKey.clear();
    reportGuardKnownTurnKeys.clear();
    reportGuardBaselineReady = false;
    reportGuardArmed = false;
    reportGuardAssistantTurnCount = 0;
    reportGuardAuditDue = false;
    reportGuardIgnoreNextAssistant = false;
    reportGuardVisualSuppressed = false;
    renderReportWarning(null);
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    // On SPA navigation, pause DOM capture until the new conversation's metadata
    // snapshot has been attempted. This avoids assigning old/virtualized turns
    // to the new conversation ID before the full backfill finishes.
    observer?.disconnect();
    observer = null;
    observerStarted = false;
    if (backfillTimer) {
      clearTimeout(backfillTimer);
      backfillTimer = null;
    }
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
    setTimeout(async () => {
      await runBackfill().catch(() => {});
      startObserver();
    }, 300);
  }, 1000);
 
 
 
 
  setInterval(() => {
    scheduleAutoRetryTimeout(0);
  }, AUTO_RETRY_FALLBACK_SCAN_MS);
 
 
  setInterval(() => {
    scheduleSafetyCheckStopResume(0);
  }, SAFETY_CHECK_FALLBACK_SCAN_MS);
  // === OSFH_SAFETY_RELAY_BEGIN ===
  // 2026-10-26 (Dan「通る道ある、方法はこれ、ってPGが吐くように」→「拡張が新しい会話を開いて CtrlM＋止まった書き込みの中身を送る形で」).
  // A spreadsheet write that ChatGPT's safety check stopped never reaches Google: the tool call has no tool reply.
  // The way through that worked (10/20): the same write in a new conversation. After each answer this page reads the
  // conversation once; a stopped write from the last 20 minutes goes to the background, which opens a new conversation.
  // That page sends Ctrl+M + the stopped write. Only Google Drive spreadsheet writes are relayed. The same write is
  // never relayed twice (stopped again = reported, not retried), and at most 4 relays in 2 hours.
  const SAFETY_RELAY_MARK = "【PGから：前の会話で安全性チェックに止められた表への書き込み】";
  const SAFETY_RELAY_WINDOW_SEC = 20 * 60;
  const SAFETY_RELAY_SCAN_MS = 3000;
  const SAFETY_RELAY_SETTLE_MS = 5000;
  const SAFETY_RELAY_CLAIM_FOR_MS = 30000;
  // Test switches (localStorage of chatgpt.com): a wider look-back window, a one-shot check without waiting for an
  // answer to end, and a dry run that puts the text in the new conversation's input box without pressing send.
  const SAFETY_RELAY_TEST_WINDOW_KEY = "osfhSafetyRelayTestWindowSec";
  const SAFETY_RELAY_TEST_NOW_KEY = "osfhSafetyRelayTestCheckNow";
  const SAFETY_RELAY_DRY_RUN_KEY = "osfhSafetyRelayDryRun";
  const safetyRelayLoadedAt = Date.now();
  let safetyRelaySawBusy = false;
  let safetyRelayInFlight = false;
  let safetyRelayClaimDone = false;
  let safetyRelayClaimBusy = false;

  function osfhFindBlockedSheetWrites(conv, sinceEpochSeconds) {
    const out = [];
    const mapping = conv && conv.mapping;
    if (!mapping || !conv.current_node) return out;
    const path = [];
    for (let id = conv.current_node, guard = 0; id && mapping[id] && guard < 100000; id = mapping[id].parent, guard++) path.push(mapping[id]);
    path.reverse();
    for (const node of path) {
      const m = node.message;
      if (!m || m.author?.role !== "assistant") continue;
      if (!String(m.recipient || "").startsWith("api_tool")) continue;
      const c = m.content || {};
      if (c.content_type !== "code") continue;
      let call;
      try { call = JSON.parse(c.text || ""); } catch (_) { continue; }
      const toolPath = String(call?.path || "");
      if (!/^\/Google Drive\/[^/]+\/(batch_update_spreadsheet|update_spreadsheet[a-z_]*|append_[a-z_]*|write_[a-z_]*spreadsheet[a-z_]*)$/.test(toolPath)) continue;
      const t = Number(m.create_time || 0);
      if (sinceEpochSeconds && t < sinceEpochSeconds) continue;
      const children = (node.children || []).map((id) => mapping[id]?.message).filter(Boolean);
      if (!children.length) continue;                                   // still running, or the reply is not in yet
      if (children.some((x) => x.author?.role === "tool")) continue;    // it reached Google
      out.push({ messageId: m.id, createTime: t, toolPath, args: call.args || {} });
    }
    return out;
  }

  function safetyRelayNewChatPath(pathname) {
    const m = String(pathname || "").match(/^\/g\/([A-Za-z0-9_-]+)\/c\//);
    if (!m) return "/";
    return m[1].startsWith("g-p-") ? `/g/${m[1]}/project` : `/g/${m[1]}`;
  }

  function safetyRelayText(fromUrl, write, blockedCount, writes) {
    const list = Array.isArray(writes) && writes.length ? writes : [write];
    const at = (w) => new Date(w.createTime * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const tool = (w) => String(w.toolPath || "").split("/").pop();
    const many = list.length > 1;
    const lines = [
      SAFETY_RELAY_MARK,
      `前の会話（${fromUrl}）で、下の表への書き込み${many ? ` ${list.length}件` : ""}が ChatGPT の安全性チェックで止められ、表に届いていない。`
        + "会話が長くなると止まりやすく、新しい会話では同じ中身が通った実績がある。",
      many ? `1. 下の書き込み${list.length}件を、上から順に、中身を変えずに同じ道具で1件ずつ1回だけ実行する。` : "1. 下の書き込みを、中身を変えずに同じ道具で1回だけ実行する。",
      many ? "2. 1件ごとに書いた範囲を読み戻し、書いた中身と一致するか確かめる。" : "2. 書いた範囲を読み戻し、書いた中身と一致するか確かめる。",
      "3. その後、上の作業引継ぎに従って作業を続ける。",
      "この会話でも止まったら、言い換えて出し直さず、止まったことをそのまま報告する（どの件が通り、どの件が止まったか）。"
    ];
    list.forEach((w, i) => {
      lines.push("", many ? `【${i + 1}件目】${at(w)} に止まった書き込み` : `${at(w)} に止まった書き込み`, `道具: ${tool(w)}`, "中身:", JSON.stringify(w.args));
    });
    return lines.join("\n");
  }
  // 同じ中身の書き込みは1つにまとめる（古い順のまま、最後に出た物を残す）
  function safetyRelayDistinct(blocked) {
    const seen = new Map();
    for (const b of blocked) seen.set(String(b.toolPath) + "\n" + JSON.stringify(b.args), b);
    return Array.from(seen.values()).sort((a, b) => a.createTime - b.createTime);
  }

  function safetyRelayTestWindowSec() {
    try {
      const v = Number(localStorage.getItem(SAFETY_RELAY_TEST_WINDOW_KEY) || 0);
      return v > 0 ? Math.min(v, 7 * 86400) : 0;
    } catch (_) { return 0; }
  }

  function safetyRelayTakeTestNow() {
    try {   // the value is the conversation id to check (localStorage is shared by every ChatGPT tab)
      const id = conversationIdFromUrl();
      if (!id || localStorage.getItem(SAFETY_RELAY_TEST_NOW_KEY) !== id) return false;
      localStorage.removeItem(SAFETY_RELAY_TEST_NOW_KEY);
      return true;
    } catch (_) { return false; }
  }

  async function maybeSafetyRelay() {
    if (osfhRetired || safetyRelayInFlight) return;
    const testNow = safetyRelayTakeTestNow();
    if (!testNow) {
      if (findStopButton()) { safetyRelaySawBusy = true; return; }
      if (!safetyRelaySawBusy) return;                 // only right after an answer ends
    }
    safetyRelaySawBusy = false;
    const conversationId = conversationIdFromUrl();
    if (!conversationId || conversationId.startsWith("share-")) return;
    safetyRelayInFlight = true;
    try {
      if (!testNow) {
        await new Promise((resolve) => setTimeout(resolve, SAFETY_RELAY_SETTLE_MS));
        if (findStopButton()) { safetyRelaySawBusy = true; return; }
      }
      const conv = await fetchConversationMetadata(conversationId);
      const windowSec = safetyRelayTestWindowSec() || SAFETY_RELAY_WINDOW_SEC;
      const blocked = osfhFindBlockedSheetWrites(conv, Date.now() / 1000 - windowSec);
      if (!blocked.length) {
        if (testNow) osfhEvent("safety_relay_none", `window ${windowSec}s`);
        return;
      }
      const writes = safetyRelayDistinct(blocked);
      const write = writes[writes.length - 1];
      const fromUrl = location.origin + location.pathname;
      const response = await chrome.runtime.sendMessage({
        type: "OSFH_SAFETY_RELAY_OPEN",
        keys: blocked.map((b) => b.messageId),
        argsHash: await sha256(JSON.stringify(writes.map((w) => w.args))),
        newChatPath: safetyRelayNewChatPath(location.pathname),
        relayText: safetyRelayText(fromUrl, write, blocked.length, writes)
      });
      osfhEvent(`safety_relay_${String(response?.status || "no_answer")}`,
        `${blocked.length} blocked (${writes.length} relayed), last ${new Date(write.createTime * 1000).toISOString()} ${response?.error || ""}`);
    } catch (error) {
      osfhEvent("safety_relay_error", error?.message || String(error));
    } finally {
      safetyRelayInFlight = false;
    }
  }

  // The new conversation opened by the background: put Ctrl+M + the stopped write in and send it.
  async function maybeClaimSafetyRelay() {
    if (osfhRetired || safetyRelayClaimDone || safetyRelayClaimBusy) return;
    // 新しい会話、または背景が書き戻しのために開いた既存の会話（会話の番号を背景の返事と照らす）
    if (Date.now() - safetyRelayLoadedAt > SAFETY_RELAY_CLAIM_FOR_MS) { safetyRelayClaimDone = true; return; }
    safetyRelayClaimBusy = true;
    try {
      let res;
      try { res = await chrome.runtime.sendMessage({ type: "OSFH_SAFETY_RELAY_CLAIM" }); } catch (_) { return; }
      if (!res?.ok) return;
      safetyRelayClaimDone = true;
      const here = conversationIdFromUrl() || "";
      if ((res.conv || "") !== here) { osfhEvent("safety_relay_send_fail", `conversation mismatch: expected ${res.conv || "new"} got ${here || "new"}`); return; }
      const composer = await waitForCondition(() => (findStopButton() ? null : composerElement()), 20000, 200);
      if (!composer) { osfhEvent("safety_relay_send_fail", "composer_not_ready"); return; }
      if (composerTextOf(composer)) { osfhEvent("safety_relay_send_fail", "composer_not_empty"); return; }
      composer.focus();
      if (!insertIntoComposer(composer, res.plain ? String(res.relayText) : `${buildHandoffPrompt(res.promptBase)}\n\n${res.relayText}`)) {
        osfhEvent("safety_relay_send_fail", "insert_failed");
        return;
      }
      let dryRun = false;
      try { dryRun = localStorage.getItem(SAFETY_RELAY_DRY_RUN_KEY) === "1"; } catch (_) {}
      if (dryRun) { osfhEvent("safety_relay_dry_run", "text put in the input box; send not pressed"); return; }
      const sendButton = await waitForCondition(() => findSendButton(), 15000, 150);
      if (!sendButton) { osfhEvent("safety_relay_send_fail", `send_not_ready buttons=${composerButtonLabels().join("/")}`); return; }
      sendButton.click();
      const sent = await waitForCondition(() => (findStopButton() ? true : (composerTextOf(composerElement()) ? null : true)), 8000, 150);
      osfhEvent(sent ? "safety_relay_sent" : "safety_relay_send_fail", sent ? "" : "send_not_confirmed");
    } catch (error) {
      osfhEvent("safety_relay_send_fail", error?.message || String(error));
    } finally {
      safetyRelayClaimBusy = false;
    }
  }

  setInterval(() => {
    maybeClaimSafetyRelay().catch(() => {});
    maybeSafetyRelay().catch(() => {});
  }, SAFETY_RELAY_SCAN_MS);
  setInterval(() => {
    if (osfhRetired) return;
    try { chrome.runtime.sendMessage({ type: "OSFH_GPT_HEARTBEAT" }).catch(() => {}); } catch (_) {}
  }, 60000);
  // === OSFH_SAFETY_RELAY_END ===
  // === OSFH_REPORT_GUARD_BEGIN ===
  // 2026-10-26 Dan「directが動き出してから報告するようにPG書き換えてくれ、ジョブID未発行での報告を禁止させろ」→ 16:52「あかんけど」.
  // GPT wrote a request row (【Direct専用】ローカル実行ジョブ発行, row 234) and told Dan "依頼は登録済み" before the 係 had even read
  // it; the row was sent back at 16:46 and nothing ran. The rule in the sheet did not stop it: GPT reports in the same answer.
  // After each answer this page reads the conversation once. When this turn wrote into the request sheet and the answer has no
  // job id (CODEX_JOB_…), a PG message goes into the same conversation: read J/K again; started -> report with the job id;
  // sent back -> fix and send again; not yet -> do not report, wait. While no job id has been reported, the check comes back
  // every 3 minutes (at most 6 times), then GPT is told to tell Dan plainly that Direct is not running and why.
  const REPORT_GUARD_LEDGER = "1F7P9xyVtJ6CR2bVezmvcExVzzwJdgEGOas1Fy62vbDY";
  const REPORT_GUARD_SHEET_ID = 639407012;
  const REPORT_GUARD_SHEET_NAMES = ["【Direct専用】ローカル実行ジョブ発行", "工程の依頼"];
  const REPORT_GUARD_JOB_RE = /CODEX_JOB_\d{8}_\d{6}_[A-Za-z0-9_]+/;
  const REPORT_GUARD_AGAIN_MS = 3 * 60 * 1000;
  const REPORT_GUARD_MAX_ROUNDS = 6;
  const REPORT_GUARD_SCAN_MS = 3000;
  const REPORT_GUARD_SETTLE_MS = 5000;
  const REPORT_GUARD_KEY = "osfhReportGuard:";
  const REPORT_GUARD_MARK = "【PGから：Directの報告の見張り】";
  // Test switches (localStorage of chatgpt.com, shared by every ChatGPT tab, so the conversation id is in the value):
  // osfhReportGuardTestCheckNow = "<conversation id>" or "<conversation id>|<message node id>" -> one check now, as if that answer
  // had just ended (no state kept); osfhReportGuardDryRun = "1" -> the text is put in the input box, send is not pressed.
  const REPORT_GUARD_TEST_NOW_KEY = "osfhReportGuardTestCheckNow";
  const REPORT_GUARD_DRY_RUN_KEY = "osfhReportGuardDryRun";
  let reportGuardSawBusy = false;
  let reportGuardBusy = false;

  function reportGuardTakeTestNow(conversationId) {
    try {
      const v = String(localStorage.getItem(REPORT_GUARD_TEST_NOW_KEY) || "");
      if (!v || v.split("|")[0] !== conversationId) return null;
      localStorage.removeItem(REPORT_GUARD_TEST_NOW_KEY);
      return { node: v.split("|")[1] || "" };
    } catch (_) { return null; }
  }
  function reportGuardDryRun() {
    try { return localStorage.getItem(REPORT_GUARD_DRY_RUN_KEY) === "1"; } catch (_) { return false; }
  }

  function reportGuardIsRequestWrite(call) {
    const toolPath = String(call?.path || "");
    if (!/^\/Google Drive\/[^/]+\/(batch_update_spreadsheet|update_spreadsheet[a-z_]*|append_[a-z_]*|write_[a-z_]*spreadsheet[a-z_]*)$/.test(toolPath)) return false;
    const args = call?.args || {};
    const text = JSON.stringify(args);
    if (text.indexOf(REPORT_GUARD_LEDGER) < 0) return false;
    // A status correction to J/K must NOT restart the follow-up loop.
    if (toolPath.endsWith("/batch_update_spreadsheet")) {
      return Array.isArray(args.requests) && args.requests.some((request) => {
        const update = request?.updateCells;
        const range = update?.range || {};
        if (Number(range.sheetId) !== REPORT_GUARD_SHEET_ID) return false;
        if (Number(range.startColumnIndex) !== 0 || Number(range.endColumnIndex) < 2) return false;
        return (update.rows || []).some((row) => {
          const cells = row?.values || [];
          const work = String(cells[0]?.userEnteredValue?.stringValue || "");
          const brief = String(cells[1]?.userEnteredValue?.stringValue || "");
          return /^WORK_[A-Za-z0-9_]+$/.test(work) && brief.trim().length > 0;
        });
      });
    }
    return REPORT_GUARD_SHEET_NAMES.some((n) => text.indexOf(n) >= 0);

  }

  function reportGuardJobIds(text) {
    return String(text || "").match(new RegExp(REPORT_GUARD_JOB_RE.source, "g")) || [];
  }

  // Remember the last REAL user request, not PG messages masquerading as user messages.
  // An older Direct job must never keep posting into a later, unrelated task in this thread.
  function reportGuardHumanAnchor(conv) {
    const mapping = conv && conv.mapping;
    if (!mapping || !conv.current_node) return "";
    for (let id = conv.current_node, guard = 0; id && mapping[id] && guard < 100000; id = mapping[id].parent, guard++) {
      const m = mapping[id].message;
      if (m?.author?.role !== "user") continue;
      const c = m.content || {};
      const parts = [c.text || "", ...(c.parts || []).map((x) => typeof x === "string" ? x : "")].join("\n").trim();
      if (parts.startsWith(REPORT_GUARD_MARK) || parts.startsWith("【PGから：記事報告の見張り】")) continue; // never treat either PG as a human request
      return id;
    }
    return "";
  }

  // The last turn of the conversation: {wrote: a request-sheet write that reached Google, answer: the text GPT showed,
  // known: job ids that were in the conversation before this answer (an old job named again is not the new one)}.
  function reportGuardReadTurn(conv) {
    const mapping = conv && conv.mapping;
    const out = { wrote: false, answer: "", turnStart: 0, known: [], anchorId: reportGuardHumanAnchor(conv) };
    if (!mapping || !conv.current_node) return out;
    const path = [];
    for (let id = conv.current_node, guard = 0; id && mapping[id] && guard < 100000; id = mapping[id].parent, guard++) path.push(mapping[id]);
    path.reverse();
    let start = 0;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].message?.author?.role === "user") { start = i + 1; out.turnStart = Number(path[i].message.create_time || 0); break; }
    }
    const known = new Set();
    const textOf = (m) => { const c = m?.content || {}; return [c.text || "", ...(c.parts || []).map((x) => (typeof x === "string" ? x : JSON.stringify(x)))].join("\n"); };
    for (const node of path.slice(0, start)) reportGuardJobIds(textOf(node.message)).forEach((x) => known.add(x));
    // 2026-10-26 21:3x fix: only job ids seen BEFORE the request write are old. Before, ids GPT read after its write (the new
    // job id in K) were counted as old too, so a correct report never ended the checks (6adf3f60, job …212230 reported 3 times).
    let afterWrite = false;
    for (const node of path.slice(start)) {
      const m = node.message;
      if (!m) continue;
      if (m.author?.role !== "assistant") { if (!afterWrite) reportGuardJobIds(textOf(m)).forEach((x) => known.add(x)); continue; }   // what GPT read before writing
      const c = m.content || {};
      if (String(m.recipient || "").startsWith("api_tool") && c.content_type === "code") {
        let call;
        try { call = JSON.parse(c.text || ""); } catch (_) { continue; }
        if (!reportGuardIsRequestWrite(call)) { if (!afterWrite) reportGuardJobIds(c.text).forEach((x) => known.add(x)); continue; }
        reportGuardJobIds(c.text).forEach((x) => known.add(x));   // a job named in GPT's own request text is an old one
        const kids = (node.children || []).map((id) => mapping[id]?.message).filter(Boolean);
        if (kids.some((x) => x.author?.role === "tool")) { out.wrote = true; afterWrite = true; }   // it reached Google
      } else if ((m.recipient || "all") === "all" && c.content_type === "text") {
        out.answer += (c.parts || []).join("\n") + "\n";
      }
    }
    out.known = Array.from(known);
    return out;
  }

  // What to do after an answer. state = the kept state of this conversation or null. Returns {state, send} (send = "first" | "again" | "last" | "").
  // The rounds count over re-sent requests too, so a request sent again and again still ends after 6 checks.
  function reportGuardDecide(state, turn, nowMs) {
    // Discard old-format states (no anchor) and any task abandoned by a new user request.
    // This also clears the incorrectly persistent reminders already sitting in localStorage.
    if (state && (!state.anchorId || !turn.anchorId || state.anchorId !== turn.anchorId)) state = null;
    if (!turn.anchorId || (!state && !turn.wrote)) return { state: null, send: "" };
    const s = state ? Object.assign({}, state) : { armedAt: nowMs, rounds: 0, nextAt: 0, known: [], anchorId: turn.anchorId };
    if (turn.wrote) s.known = Array.from(new Set([...(s.known || []), ...(turn.known || [])])).slice(-300);
    const old = new Set(s.known || []);
    if (reportGuardJobIds(turn.answer).some((x) => !old.has(x))) return { state: null, send: "" };   // a new job id was reported: done
    if (s.rounds >= REPORT_GUARD_MAX_ROUNDS) return { state: null, send: "last" };
    if (turn.wrote) { s.rounds += 1; s.nextAt = 0; return { state: s, send: "first" }; }
    if (!s.nextAt) s.nextAt = nowMs + REPORT_GUARD_AGAIN_MS;
    return { state: s, send: "" };
  }

  function reportGuardText(kind, round) {
    const how = [
      "書いた行のJ列・K列だけを読み直し、次のどれか1つだけをやる（他の文書・ログは読まない）。",
      "・J列が「Direct起動済」→ K列のジョブ番号（CODEX_JOB_…）を書いて、Danに報告する。",
      "・J列が「差し戻し」「Direct未起動・止められた」→ Danに聞かず、K列の理由どおりに直して出し直す（差し戻しはその行を直してJ列を空にする）。",
      "・J列が空か「Direct未起動」→ まだ何も動いていない。Danへの報告はせず、「ジョブ番号待ち（J列：…）」の1行だけ返す。"
    ];
    if (kind === "first") return [
      REPORT_GUARD_MARK + "報告の差し戻し",
      "これはDanの発言ではなく、拡張のPGが送った自動の確認。作業の続きとして実行する。",
      "この回で依頼表（【Direct専用】ローカル実行ジョブ発行）に書いたが、回答にジョブ番号（CODEX_JOB_…）が無い。ジョブ番号が出るまで、Danに「登録した」「依頼した」「受付済み」「進んでいる」と言わない。係が受け付けるまで1〜2分、Directに出るまでさらに数分かかる。",
      ...how,
      "ジョブ番号が出るまで、PGが3分おきにこの確認を送る。"
    ].join("\n");
    if (kind === "again") return [
      REPORT_GUARD_MARK + `3分後の確認（${round}回目）`,
      "これはDanの発言ではなく、拡張のPGが送った自動の確認。",
      "まだジョブ番号の入った報告が無い。",
      ...how
    ].join("\n");
    return [
      REPORT_GUARD_MARK + "ジョブ番号が出ないまま約20分",
      "これはDanの発言ではなく、拡張のPGが送った自動の確認。この後PGからの確認は送らない。",
      "依頼表に書いてから約20分たっても、ジョブ番号の入った報告が無い。Directは動いていない。",
      "書いた行のJ列・K列を読み直し、Danに「Directはまだ動いていない」と、J列の状態とK列の理由をそのまま、平易な言葉で伝える。「登録した」「進んでいる」とは書かない。差し戻しなら直して出し直してから伝える。"
    ].join("\n");
  }

  function reportGuardLoad(conversationId) {
    try { const v = localStorage.getItem(REPORT_GUARD_KEY + conversationId); return v ? JSON.parse(v) : null; } catch (_) { return null; }
  }
  function reportGuardSave(conversationId, state) {
    try {
      if (state) localStorage.setItem(REPORT_GUARD_KEY + conversationId, JSON.stringify(state));
      else localStorage.removeItem(REPORT_GUARD_KEY + conversationId);
    } catch (_) {}
  }

  // Puts the text into this conversation's input box and sends it. false when Dan is typing or the box is not ready.
  async function reportGuardSend(text, expectedConversationId = "", expectedAnchorId = "") {
    if (expectedConversationId && conversationIdFromUrl() !== expectedConversationId) return false;
    if (expectedAnchorId && reportGuardHumanAnchor(await fetchConversationMetadata(expectedConversationId)) !== expectedAnchorId) return false;
    if (findStopButton()) return false;
    const composer = composerElement();
    if (!composer || composerTextOf(composer)) return false;     // never over what Dan is typing
    composer.focus();
    if (!insertIntoComposer(composer, text)) { osfhEvent("report_guard_send_fail", "insert_failed"); return false; }
    if (reportGuardDryRun()) { osfhEvent("report_guard_dry_run", "text put in the input box; send not pressed"); return false; }
    const sendButton = await waitForCondition(() => findSendButton(), 15000, 150);
    if (!sendButton) { osfhEvent("report_guard_send_fail", `send_not_ready buttons=${composerButtonLabels().join("/")}`); return false; }
    if (expectedConversationId && conversationIdFromUrl() !== expectedConversationId) return false;
    if (findStopButton()) return false;
    sendButton.click();
    const sent = await waitForCondition(() => (findStopButton() ? true : (composerTextOf(composerElement()) ? null : true)), 8000, 150);
    return !!sent;
  }

  async function maybeReportGuard() {
    if (osfhRetired || reportGuardBusy) return;
    const conversationId = conversationIdFromUrl();
    if (!conversationId || conversationId.startsWith("share-")) return;
    if (findStopButton()) { reportGuardSawBusy = true; return; }
    reportGuardBusy = true;
    try {
      const test = reportGuardTakeTestNow(conversationId);
      if (test) {                                                // test: one check now, nothing kept
        const conv = await fetchConversationMetadata(conversationId);
        if (test.node && conv?.mapping?.[test.node]) conv.current_node = test.node;
        const turn = reportGuardReadTurn(conv);
        const d = reportGuardDecide(null, turn, Date.now());
        osfhEvent("report_guard_test", `wrote=${turn.wrote} send=${d.send || "-"} known=${turn.known.length}`);
        if (d.send) await reportGuardSend(reportGuardText(d.send, 1), conversationId, d.state?.anchorId);
        return;
      }
      if (reportGuardSawBusy) {                                  // an answer just ended: read it once
        reportGuardSawBusy = false;
        await new Promise((resolve) => setTimeout(resolve, REPORT_GUARD_SETTLE_MS));
        if (findStopButton()) { reportGuardSawBusy = true; return; }
        const turn = reportGuardReadTurn(await fetchConversationMetadata(conversationId));
        const before = reportGuardLoad(conversationId);
        const d = reportGuardDecide(before, turn, Date.now());
        if (before && !d.state && !d.send) osfhEvent("report_guard_done", "job id reported");
        if (d.send) {
          const text = reportGuardText(d.send, d.state ? d.state.rounds : REPORT_GUARD_MAX_ROUNDS);
          if (await reportGuardSend(text, conversationId, d.state?.anchorId)) osfhEvent(`report_guard_sent_${d.send}`, `round ${d.state ? d.state.rounds : "-"}`);
          else if (d.state) { d.state.nextAt = Date.now() + 15000; d.state.rounds = Math.max(0, d.state.rounds - 1); }   // not sent: try again soon
          else if (d.send === "last") { reportGuardSave(conversationId, { armedAt: Date.now(), rounds: REPORT_GUARD_MAX_ROUNDS, nextAt: Date.now() + 15000 }); return; }
        }
        reportGuardSave(conversationId, d.state);
        return;
      }
      const state = reportGuardLoad(conversationId);             // waiting for the next 3-minute check
      if (!state || !state.nextAt || Date.now() < state.nextAt) return;
      const currentAnchor = reportGuardHumanAnchor(await fetchConversationMetadata(conversationId));
      if (!state.anchorId || !currentAnchor || currentAnchor !== state.anchorId) {
        reportGuardSave(conversationId, null);                     // user changed tasks; cancel without sending
        osfhEvent("report_guard_canceled", "different user request / legacy state");
        return;
      }
      if (state.rounds >= REPORT_GUARD_MAX_ROUNDS) {
        if (await reportGuardSend(reportGuardText("last", state.rounds), conversationId, state.anchorId)) { osfhEvent("report_guard_sent_last", ""); reportGuardSave(conversationId, null); }
        else { state.nextAt = Date.now() + 15000; reportGuardSave(conversationId, state); }
        return;
      }
      const round = state.rounds + 1;
      if (await reportGuardSend(reportGuardText("again", round), conversationId, state.anchorId)) {
        reportGuardSave(conversationId, Object.assign({}, state, { rounds: round, nextAt: 0 }));
        osfhEvent("report_guard_sent_again", `round ${round}`);
      } else {
        reportGuardSave(conversationId, Object.assign({}, state, { nextAt: Date.now() + 15000 }));
      }
    } catch (error) {
      osfhEvent("report_guard_error", error?.message || String(error));
    } finally {
      reportGuardBusy = false;
    }
  }

  // For the offline test (node): the pure parts.
  try { if (typeof window !== "undefined") window.__osfhReportGuard = { reportGuardIsRequestWrite, reportGuardReadTurn, reportGuardDecide, reportGuardText, reportGuardJobIds, reportGuardHumanAnchor }; } catch (_) {}

  setInterval(() => { maybeReportGuard().catch(() => {}); }, REPORT_GUARD_SCAN_MS);
  // === OSFH_REPORT_GUARD_END ===
  // === OSFH_ARTICLE_CHECKLIST_GUARD_BEGIN ===
  // Article audit, 2026-10-27: four rules per cycle, bounded prompts, fail-closed.
  // 2026-10-27 20:50 Claude Code: all-○ gate (Dan). See 4-item-gate below.
  // IMPORTANT: The browser checks STRUCTURE / quotes, not Japanese semantics.
  // Even 21 provisional positives are NOT an independent audit or permission to publish.
  const ARTICLE_GUARD_ITEMS = 21;
  const ARTICLE_GUARD_MIN_CHARS = 600;
  const ARTICLE_GUARD_MAX_SENDS = 2; // per group
  const ARTICLE_GUARD_SCAN_MS = 3000;
  const ARTICLE_GUARD_SETTLE_MS = 6000;
  const ARTICLE_GUARD_RETRY_MS = 15000;
  const ARTICLE_GUARD_KEY = "osfhArticleGuard:";
  const ARTICLE_GUARD_MARK = "【PGから：記事報告の見張り】";
  const ARTICLE_GUARD_TEST_NOW_KEY = "osfhArticleGuardTestCheckNow";
  let articleGuardSawBusy = false;
  let articleGuardBusy = false;

  function articleGuardSplit(answer) {
    const text = String(answer || "");
    const articles = [];
    let rest = "";
    const re = /<WritingBlock\b([^>]*)>([\s\S]*?)(?:<\/WritingBlock>|$)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      rest += text.slice(last, m.index);
      last = re.lastIndex;
      if (/variant\s*=\s*["']?document/.test(m[1])) articles.push(m[2]); else rest += m[2];
      if (m[0].length === 0) re.lastIndex++;
    }
    rest += text.slice(last);
    return { articles, rest };
  }
  function articleGuardHasArticle(answer) {
    return articleGuardSplit(answer).articles.some((b) => {
      const body = b.trim();
      return /^#\s+\S/.test(body) && body.replace(/\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS;
    });
  }
  const ARTICLE_GUARD_LABELS = [
    "筆者の根本姿勢", "本人とAIの作業主体", "読者の困りごと・冒頭", "タイトル・見出し",
    "調査・情報源", "記事の分量・テーマ", "不要な断り書き", "自然な日本語",
    "不自然な定型対比文", "段落・改行", "段落・改行の実表示", "太字・強調",
    "引用・発言", "表の使い方", "装飾の用途", "装飾の数量", "公開表示・スマホ対応",
    "改行と装飾の横断確認", "記事品質全般の総合確認", "最終推敲", "別担当による独立監査"
  ];
  if (ARTICLE_GUARD_LABELS.length !== ARTICLE_GUARD_ITEMS) throw new Error("article checklist item count mismatch");
  // === OSFH_AUDIT_RULES_FROM_SHEET（content側）===
  // 2026-10-28 Dan「監査項目をSSに追加→自動で拡張も追加されるようにしたい」。
  // 背景（options.js）がルール正本を10分おきに読んで chrome.storage.local の osfhAuditRuleSet に置く。
  // 新しく見張りを始める時にその一覧を状態へ写し、その会話は最後まで同じ一覧で進める（途中で項目が変わっても混ざらない）。
  // 読めない・変な中身の時は上の固定の21項目（10/27〜の動き）で動く。
  const ARTICLE_GUARD_RULES_KEY = "osfhAuditRuleSet";
  const ARTICLE_GUARD_BUILTIN_IDS = ["STYLE-STANCE-01", "WRITE-05", "STYLE-LEAD-01", "STYLE-HEADING-01", "RESEARCH-01", "WRITE-03",
    "STYLE-CAVEAT-01", "STYLE-PROSE-01", "STYLE-CONTRAST-01", "STYLE-PARAGRAPH-01", "STYLE-PARAGRAPH-AUDIT-01", "STYLE-EMPHASIS-01",
    "STYLE-QUOTE-01", "STYLE-TABLE-01", "STYLE-DECORATION-01", "STYLE-DECORATION-COUNT-01", "STYLE-CSS-01", "WRITE-02", "WRITE-01",
    "STYLE-EDIT-01", "WRITE-04"];
  // ルール正本に「外の確認」の列が無い間は、この4つ（10/27〜のNo.5・11・17・21）を外の確認待ちとして飛ばす。
  const ARTICLE_GUARD_BUILTIN_WAIT_IDS = ["RESEARCH-01", "STYLE-PARAGRAPH-AUDIT-01", "STYLE-CSS-01", "WRITE-04"];
  const ARTICLE_GUARD_TABLE_ID = "STYLE-TABLE-01";                    // 左右対応の検査（旧No.14）
  const ARTICLE_GUARD_BREAK_IDS = ["STYLE-PARAGRAPH-01", "WRITE-02"];  // 改行の検査（旧No.10・18）
  const ARTICLE_GUARD_BREAK_NOTE = "改行は記号の数ではなく、採用見本どおりに読めるかで判定する。一文だけの段落が並ぶ・同じ話題が別の段落に分かれる・句点ごとの改行は×。";
  const ARTICLE_GUARD_BUILTIN_NOTES = {
    "STYLE-TABLE-01": "の判定根拠は「左右対応：使う」か「左右対応：使わない（理由）」で始める。事故・改善記事は、本人の実際の要求・指摘（左）とAIの実作業・結果（右）を並べると読者に伝わるかを先に判断する。「表が無いから違反なし」だけで○にしない。",
    "STYLE-PARAGRAPH-01": ARTICLE_GUARD_BREAK_NOTE,
    "WRITE-02": ARTICLE_GUARD_BREAK_NOTE
  };
  // 1回に出す大項目の数（SSの「拡張の設定」タブに無い時）。今の21項目は小項目が無いので4＝10/27〜の4項目ずつと同じ組になる。
  const ARTICLE_GUARD_DEFAULT_BIG_PER_SEND = 4;
  // v16：拡張に直書きだった判定の数字（SSの「拡張の設定」タブで変えられる。無い時はこの値）
  const ARTICLE_GUARD_PG_DEFAULT = { tableIds: ["STYLE-TABLE-01"], quoteMin: 8, reasonMin: 20,
    boldPerLines: 6, boldMaxChars: 18, quoteBlocksMax: 10, boldCountNo: "12-1", boldLenNo: "12-3", quoteCountNo: "13-5" };
  function articleGuardPgOf(state) {
    const p = Object.assign({}, ARTICLE_GUARD_PG_DEFAULT);
    const src = articleGuardRulesOf(state).pg;
    if (src && typeof src === "object") {
      for (const k of Object.keys(ARTICLE_GUARD_PG_DEFAULT)) {
        const v = src[k], d = ARTICLE_GUARD_PG_DEFAULT[k];
        if (Array.isArray(d) ? Array.isArray(v) && v.every(x => typeof x === "string") : typeof v === typeof d) p[k] = v;
      }
    }
    return p;
  }
  // v16：仕組みの話かどうか（Danの発言の後に監査を続けるか止めるかの目安）
  const ARTICLE_GUARD_SYSTEM_TALK = /(拡張|ＰＧ|PG|プログラム|コード|content\.js|options\.js|スプレッドシート|ルール正本|拡張の設定|SS|誤作動|誤起動|不具合|バグ|修理|Direct|台帳|見張り)/;
  const ARTICLE_GUARD_NO_RE = "\\d{1,3}(?:[-－‐]\\d{1,3}){0,2}";
  function articleGuardNo(v) { return String(v ?? "").trim().replace(/^No\.?\s*/i, "").replace(/[－‐―]/g, "-"); }
  function articleGuardBuiltinRules() {
    return { source: "builtin", sig: "builtin-21", fetchedAt: "", bigPerSend: ARTICLE_GUARD_DEFAULT_BIG_PER_SEND,
      items: ARTICLE_GUARD_LABELS.map((label, i) => ({ no: String(i + 1), label, id: ARTICLE_GUARD_BUILTIN_IDS[i], parent: "",
        wait: ARTICLE_GUARD_BUILTIN_WAIT_IDS.includes(ARTICLE_GUARD_BUILTIN_IDS[i]), note: "" })) };
  }
  // 背景が置いた一覧を確かめて使える形にする。おかしければ null（＝固定の21項目）。
  function articleGuardNormalizeRules(set) {
    try {
      if (!set || !Array.isArray(set.items) || !set.items.length || set.items.length > 300) return null;
      const seen = new Set(), items = [];
      const noRe = new RegExp("^" + ARTICLE_GUARD_NO_RE + "$");
      for (const x of set.items) {
        const no = articleGuardNo(x && x.no), label = String((x && x.label) || "").trim();
        if (!noRe.test(no) || !label || seen.has(no)) return null;
        seen.add(no);
        const id = String((x && x.id) || "").trim(), parent = String((x && x.parent) || "").trim();
        const wait = typeof (x && x.wait) === "boolean" ? x.wait
          : (ARTICLE_GUARD_BUILTIN_WAIT_IDS.includes(id) || ARTICLE_GUARD_BUILTIN_WAIT_IDS.includes(parent));
        items.push({ no, label: label.replace(/\|/g, "／"), id, parent, wait, note: String((x && x.note) || "").slice(0, 600) });
      }
      if (!items.some(x => !x.wait)) return null;
      const per = Number(set.bigPerSend);
      return { source: "sheet", sig: String(set.sig || "").slice(0, 64) || ("n" + items.length), fetchedAt: String(set.fetchedAt || ""), items,
        bigPerSend: Number.isInteger(per) && per >= 1 && per <= 50 ? per : ARTICLE_GUARD_DEFAULT_BIG_PER_SEND,
        pg: set.pg && typeof set.pg === "object" ? set.pg : null };
    } catch (_) { return null; }
  }
  let articleGuardSheetRules = null;
  try {
    chrome.storage.local.get(ARTICLE_GUARD_RULES_KEY, (r) => { articleGuardSheetRules = articleGuardNormalizeRules(r && r[ARTICLE_GUARD_RULES_KEY]); });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch[ARTICLE_GUARD_RULES_KEY]) articleGuardSheetRules = articleGuardNormalizeRules(ch[ARTICLE_GUARD_RULES_KEY].newValue);
    });
  } catch (_) {}
  function articleGuardCurrentRules() { return articleGuardSheetRules || articleGuardBuiltinRules(); }
  // 状態に写した一覧（無い＝10/28より前に始めた会話は固定の21項目）。
  function articleGuardRulesOf(state) {
    const r = state && state.rules;
    return (r && Array.isArray(r.items) && r.items.length) ? r : articleGuardBuiltinRules();
  }
  function articleGuardRefreshRuleSnapshot(state) {
    if (!state || !state.rules || !articleGuardSheetRules || state.rules.sig === articleGuardSheetRules.sig) return state;
    const old = state.rules, newer = articleGuardSheetRules;
    const shape = rs => (rs.items || []).map(x => x.no + (x.wait ? "!" : "")).join("|");
    if (shape(old) === shape(newer)) {
      // Update labels/conditions used by the next request while retaining the
      // batch position; discard failure text from the old rule version.
      return Object.assign({}, state, { rules:newer, lastFails:[], lastReason:"", tries:0,
        kind:state.kind === "fix" || state.kind === "format" ? "next" : state.kind,
        sent:0, retryAt:0 });
    }
    // If membership/order changed, restart the audit instead of mixing results.
    return Object.assign({}, state, { rules:newer, batch:0, tries:0, total:0, kind:"start",
      records:{}, lastFails:[], lastReason:"", sent:0, retryAt:0 });
  }
  function articleGuardRule(state, no) { return articleGuardRulesOf(state).items.find(x => x.no === String(no)) || null; }
  function articleGuardLabel(state, no) { return (articleGuardRule(state, no) || {}).label || ""; }
  function articleGuardRuleIs(rule, ids) { const list = [].concat(ids); return !!rule && (list.includes(rule.id) || list.includes(rule.parent)); }
  function articleGuardWaitList(state) { return articleGuardRulesOf(state).items.filter(x => x.wait).map(x => x.no); }
  function articleGuardCheckCount(state) { return articleGuardRulesOf(state).items.filter(x => !x.wait).length; }
  // 大項目＝No.の「-」より前（3-1・3-2 は大項目3）。1回に出すのは大項目 bigPerSend 個分で、その下の小項目は全部一緒に出す（項目数では切らない）。
  function articleGuardBig(no) { return String(no).split("-")[0]; }
  function articleGuardBigPerSend(state) {
    const n = Number(articleGuardRulesOf(state).bigPerSend);
    return Number.isInteger(n) && n >= 1 && n <= 50 ? n : ARTICLE_GUARD_DEFAULT_BIG_PER_SEND;
  }
  // 10/28 v1 の名前（項目数の組）。今は1回に出す大項目の数を返す（差し替え係の「関数が消えていない」検査のため残す）。
  function articleGuardBatchSize(state) { return articleGuardBigPerSend(state); }
  const articleGuardBatchCache = new Map();
  function articleGuardBatchesOf(state) {
    const rules = articleGuardRulesOf(state);
    const key = rules.sig + "|" + articleGuardBigPerSend(state) + "|" + rules.items.map(x => x.no + (x.wait ? "w" : "")).join(",");
    if (articleGuardBatchCache.has(key)) return articleGuardBatchCache.get(key);
    const per = articleGuardBigPerSend(state), list = [];
    let cur = [], bigs = [];
    for (const x of rules.items) {
      if (x.wait) continue;
      const big = articleGuardBig(x.no);
      if (!bigs.includes(big) && bigs.length === per) { list.push(cur); cur = []; bigs = []; }
      if (!bigs.includes(big)) bigs.push(big);
      cur.push(x.no);
    }
    if (cur.length) list.push(cur);
    articleGuardBatchCache.set(key, list);
    return list;
  }
  // 1つの依頼で送れる上限：組の数×6（今の5組なら30＝10/27〜と同じ）。
  function articleGuardMaxTotal(state) { return Math.max(30, articleGuardBatchesOf(state).length * 6); }
  // 今回の項目に付ける追加の注意：ルール正本の「追加の注意」列 → 無ければ固定の注意（ルールIDか親ルールIDで当てる）。
  function articleGuardNotes(state, items) {
    const out = [];
    for (const no of items) {
      const r = articleGuardRule(state, no);
      if (!r) continue;
      let t = r.note;
      if (!t) {
        const k = Object.keys(ARTICLE_GUARD_BUILTIN_NOTES).find(id => articleGuardRuleIs(r, id));
        t = k ? (k === ARTICLE_GUARD_TABLE_ID ? `No.${no}` : "") + ARTICLE_GUARD_BUILTIN_NOTES[k] : "";
      }
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  // Existing 21-line checklist parser: exposed for historical integration and diagnostics,
  // but a syntactically correct checklist never signifies a quality pass.
  function articleGuardParseChecklist(answer) {
    const rest = articleGuardSplit(answer).rest;
    const anchor = "【監査チェックリスト】";
    const pos = rest.indexOf(anchor);
    if (pos < 0) return { found: new Set(), valid: false };
    const lines = rest.slice(pos + anchor.length).split(/\r?\n/);
    const header = /^\s*\|\s*No\.\s*\|\s*監査項目\s*\|\s*結果\s*\|\s*理由\s*\|\s*$/;
    const separator = /^\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*$/;
    const result = { found: new Set(), valid: false };
    const headerIndex = lines.findIndex((line) => header.test(line));
    if (headerIndex < 0 || !separator.test(lines[headerIndex + 1] || "")) return result;
    for (let i = 0; i < ARTICLE_GUARD_ITEMS; i++) {
      const line = lines[headerIndex + 2 + i] || "";
      const m = line.match(/^\s*\|\s*(\d{1,2})\s*\|\s*([^|]+?)\s*\|\s*([○×])\s*\|\s*([^|]+?)\s*\|\s*$/);
      if (!m || Number(m[1]) !== i + 1 || m[2].trim() !== ARTICLE_GUARD_LABELS[i] || !m[4].trim()) return result;
      if (m[3] === "○" && /^未確認[：:]/.test(m[4].trim())) return result;
      result.found.add(i + 1);
    }
    if (/^\s*\|\s*\d{1,2}\s*\|/.test(lines[headerIndex + 2 + ARTICLE_GUARD_ITEMS] || "")) return result;
    result.valid = result.found.size === ARTICLE_GUARD_ITEMS;
    return result;
  }
  function articleGuardChecklistItems(answer) { return articleGuardParseChecklist(answer).found; }
  function articleGuardHasChecklist(answer) { return articleGuardParseChecklist(answer).valid; }

  // 2026-10-29: ChatGPT can render a six-column answer table in the DOM
  // without preserving the original Markdown pipe characters in metadata.
  // Extract ONLY the newest assistant message's six-column audit table.
  // v18（2026-10-29）：画面の最後の答えの文字だけを比べる形にする
  function articleGuardLetters(text) { return String(text || "").replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}]+/gu, ""); }
  function articleGuardDomAuditTable(expectTail = "") {
    try {
      if (typeof document === "undefined") return "";
      if (findStopButton()) return "";   // v18：GPTが書いている途中の表（書きかけの行）は読まない
      const turns = Array.from(document.querySelectorAll('main [data-message-author-role="assistant"]'));
      const last = turns[turns.length - 1];
      if (!last) return "";
      // v18：画面の最後の答えが、記録で読んだ答えと同じ時だけ使う（前の回の表を今回の表として読まない）
      if (expectTail && !articleGuardLetters(last.innerText || last.textContent || "").includes(expectTail)) return "";
      const tables = last.querySelectorAll('table, [role="table"]');
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tr, [role="row"]')).map(r =>
          Array.from(r.querySelectorAll('th, td, [role="columnheader"], [role="cell"]'))
            .map(c => String(c.innerText || c.textContent || "").replace(/\s+/g, " ").trim().replace(/\|/g, "／")));
        const head = rows.findIndex(r => r.length === 6 && /^No\.?$/i.test(r[0]) && r[1] === '監査項目' && r[2] === '結果' && r[3] === '位置' && r[4] === '原文引用' && r[5] === '判定根拠');
        if (head < 0 || !rows.slice(head + 1).some(r => /^\d{1,3}[-－]\d{1,3}$/.test(r[0] || ""))) continue;
        return ['【監査バッチ結果】', '| No. | 監査項目 | 結果 | 位置 | 原文引用 | 判定根拠 |', '|---|---|---|---|---|---|',
          ...rows.slice(head + 1).filter(r => r.length === 6).map(r => '| ' + r.join(' | ') + ' |')].join('\n');
      }
      // Raw code blocks can also hold the requested Markdown table.
      const pres = Array.from(last.querySelectorAll('pre, code'));
      for (const pre of pres) {
        const val = String(pre.innerText || pre.textContent || '');
        if (/^\s*\|\s*No\.?\s*\|\s*監査項目\s*\|\s*結果\s*\|/m.test(val)) return '【監査バッチ結果】\n' + val;
      }
    } catch (_) {}
    return "";
  }
  function articleGuardReadAnswer(conv) {
    const mapping = conv && conv.mapping;
    if (!mapping || !conv.current_node) return "";
    const path = [];
    for (let id = conv.current_node, guard = 0; id && mapping[id] && guard < 100000; id = mapping[id].parent, guard++) path.push(mapping[id]);
    path.reverse();
    let start = 0;
    for (let i = path.length - 1; i >= 0; i--) if (path[i].message?.author?.role === "user") { start = i + 1; break; }
    let answer = "", drive = "", lastText = "";
    const hidden = [];
    for (const node of path.slice(start)) {
      const m = node.message, c = m?.content || {};
      if (m?.author?.role === "assistant" && (m.recipient || "all") === "all" && c.content_type === "text") { lastText = (c.parts || []).join("\n"); answer += lastText + "\n"; }
      else if (m?.author?.role === "assistant" && (m.recipient || "all") !== "all") {
        drive += articleGuardDriveWriteText(c, m.recipient);
        const h = articleGuardHiddenWrite(c);
        if (h && !hidden.includes(h)) hidden.push(h);
      }
      else if (m?.author?.role === "tool" && /^(python|container\.exec)/.test(String(m.author?.name || ""))) {
        // 2026-10-27 22:40: GPTが作業場で記事ファイルを表示した出力（cat 等）。記事らしい物だけ（会話 6ae0964b）。
        const out = (c.parts || []).filter(x => typeof x === "string").join("") || c.text || "";
        if (articleGuardLooksLikeArticle(out)) drive += out + "\n";
      }
    }
    // 2026-10-27 21:10: 記事を会話に出さずドライブの文書・ファイルに書いた回も、書いた中身を記事として見る（会話 6ae08f31）。
    if (articleGuardLooksLikeArticle(drive)) answer += `\n<WritingBlock id="drive" variant="document"># ドライブに書いた記事\n\n${drive.trim()}\n</WritingBlock>\n`;
    // 2026-10-28 v6：答えに作業場の記事ファイル（sandbox:/mnt/data/○○.html・.md）へのリンクだけがある時も、本文の見えない記事とみる
    for (const name of articleGuardSandboxLinks(answer)) if (!hidden.includes(name)) hidden.push(name);
    // 2026-10-28 v3：本文が見えない記事ファイルの書き込みがあった印（記事が答えに無い時だけ使う）
    if (articleGuardLooksLikeArticle(drive)) {}
    else if (hidden.length) answer += `\n${ARTICLE_GUARD_HIDDEN_MARK}${hidden.slice(0, 5).join("、")}\n`;
    // If the assistant's structured table is absent from metadata, use the
    // current visible DOM table instead of retrying a correctly formed answer.
    if (!/^\s*\|\s*No\.?\s*\|\s*監査項目\s*\|\s*結果\s*\|/m.test(answer)) {
      const tail = articleGuardLetters(lastText).slice(-12);
      const domTable = tail ? articleGuardDomAuditTable(tail) : "";
      if (domTable) answer += "\n" + domTable + "\n";
    }
    return answer;
  }
  // GPTのドライブへの書き込み（文書への差し込み・ファイルの作成・上書き）から本文の文字だけを集める。読むだけ。
  function articleGuardDriveWriteText(c, recipient = "") {
    const raw = (c?.parts || []).filter(x => typeof x === "string").join("") || c?.text || "";
    // 会話の中の作業場（python・container.exec）で .html/.md の記事ファイルを書いた時は、書いた中身を見る。
    if (/^(python|container\.exec)/.test(String(recipient))) {
      let code = raw;
      try { const p = JSON.parse(raw); code = Array.isArray(p?.cmd) ? p.cmd.join(" ") : String(p?.code || p?.cmd || raw); } catch (_) {}
      // 2026-10-27 22:40: プログラムの文字を記事と取り違えた（会話 6ae0964b）。cat > ○○.html／.md <<EOF の中身だけを記事とみる。
      const body = code.match(/cat\s*>\s*\S+\.(?:html?|md)['"]?\s*<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\b/i);
      return body ? body[2] + "\n" : "";
    }
    let j = null;
    try { j = JSON.parse(raw); } catch (_) { return ""; }
    const path = String(j?.path || "");
    if (!/^\/Google Drive\/[^/]+\/(create_file|update_file|batch_update_document|update_document|upload_file|replace_file[a-z_]*|write_file|append_document[a-z_]*)$/.test(path)) return "";
    const out = [];
    const walk = (v, key, depth) => {
      if (depth > 8 || v == null) return;
      if (typeof v === "string") { if (/^(text|content|body|html|file_content|data|markdown)$/i.test(key || "") && v.length >= 20) out.push(v); return; }
      if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
      if (typeof v === "object") for (const k of Object.keys(v)) walk(v[k], k, depth + 1);
    };
    walk(j.args, "", 0);
    return out.length ? out.join("\n") + "\n" : "";
  }
  // 2026-10-28 v3：Driveへの書き込みで、本文が引数に無い（作業場のファイルや file_uri を渡した）記事ファイル（.html/.md）なら、その名前を返す。
  const ARTICLE_GUARD_HIDDEN_MARK = "〔OSFH_HIDDEN_ARTICLE_WRITE〕";
  function articleGuardHiddenWrite(c) {
    const raw = (c?.parts || []).filter(x => typeof x === "string").join("") || c?.text || "";
    let j = null;
    try { j = JSON.parse(raw); } catch (_) { return ""; }
    const path = String(j?.path || "");
    if (!/^\/Google Drive\/[^/]+\/(create_file|update_file|import_document|upload_file|replace_file[a-z_]*|write_file)$/.test(path)) return "";
    const a = j?.args || {};
    if (!a.file_uri && !a.source_file) return "";
    const fu = a.file_uri && typeof a.file_uri === "object" ? a.file_uri : {};
    const names = [a.source_file, a.title, a.name, a.file_name, fu.name, fu.file_name].filter(x => typeof x === "string" && x);
    const isArticle = names.some(n => /\.(html?|md|markdown)$/i.test(n)) || /^text\/(html|markdown)$/i.test(String(a.mime_type || a.mimeType || ""));
    if (!isArticle) return "";
    const name = (names.find(n => /\.(html?|md|markdown)$/i.test(n)) || a.fileId || "記事ファイル").split("/").pop();
    return String(name).replace(/[\r\n、]/g, " ").slice(0, 80);
  }
  // v4：答えが「# 題名」で始まり、本文がコードの枠（<CodeBlock …>…</CodeBlock> や ``` ）に入っている時、その全文を記事として返す。
  function articleGuardCodeBlockArticle(answer) {
    const t = String(answer || "").trim();
    const m = t.match(/^#\s+([^\n]+)\n([\s\S]*)$/);
    if (!m) return "";
    const body = m[2].replace(/<CodeBlock\b[^>]*>/gi, "").replace(/<\/CodeBlock>/gi, "").replace(/^```[a-z]*\s*$/gim, "").trim();
    const doc = `# ${m[1].trim()}\n\n${body}`;
    return articleGuardLooksLikeArticle(doc) && doc.replace(/\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS ? doc : "";
  }
  // v6：答えの文の中の作業場の記事ファイルへのリンク（sandbox:/mnt/data/…/○○.html など）の名前
  function articleGuardSandboxLinks(text) {
    const out = [];
    const re = /sandbox:\/mnt\/data\/([^\s)\]"'<>]+?\.(?:html?|md|markdown))(?=[\s)\]"'<>]|$)/gi;
    let m;
    while ((m = re.exec(String(text || "")))) {
      const name = m[1].split("/").pop().replace(/[、\r\n]/g, " ").slice(0, 80);
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  }
  function articleGuardHiddenNames(answer) {
    const t = String(answer || ""), i = t.indexOf(ARTICLE_GUARD_HIDDEN_MARK);
    if (i < 0) return null;
    return t.slice(i + ARTICLE_GUARD_HIDDEN_MARK.length).split("\n")[0].split("、").map(x => x.trim()).filter(Boolean);
  }
  function articleGuardLooksLikeArticle(text) {
    const s = String(text || "");
    const plain = s.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
    return plain.length >= ARTICLE_GUARD_MIN_CHARS && /[ぁ-んァ-ン一-龥]/.test(plain) && (/<(p|h[1-6])\b/i.test(s) || /^#{1,3}\s+\S/m.test(s));
  }

  // 2026-10-27 Dan: 4項目すべて○で次へ。×は直して同じ4項目をやり直し。5・11・17・21は外の確認待ちで飛ばす。
  // 同じ4項目で3回やっても全部○にならなければ止め、止めた印の文を会話に残す（PC側の係がそれを拾ってLINE）。
  const ARTICLE_GUARD_MODE = "4-item-gate";
  // 外の確認待ち・組は、ルール正本の一覧から作る（articleGuardWaitList／articleGuardBatchesOf）。下は固定の21項目の時の組（試験・診断用）。
  const ARTICLE_GUARD_BATCHES = articleGuardBatchesOf(null);
  const ARTICLE_GUARD_MAX_TRIES = 3;      // 同じ4項目への依頼は3回まで
  // 1つの依頼の中での送信の上限は articleGuardMaxTotal（組の数×6・最低30）。
  const ARTICLE_GUARD_STOP_LINE = "【PGから：記事報告の見張り】止めた";
  const ARTICLE_GUARD_AUDIT_MARK = "【PGから：独立監査の依頼】";
  const ARTICLE_GUARD_AUDIT_DONE = "【PGから：記事報告の見張り】独立監査の終わり";
  const ARTICLE_GUARD_FIRSTREAD_MARK = "【PGから：初見読者監査の依頼】";            // v12
  const ARTICLE_GUARD_FIRSTREAD_BACK = "【PGから：記事報告の見張り】初見読者監査で差戻";  // v12
  function articleGuardAnchorIsForwarded(conv, anchorId) {
    const m = anchorId && conv?.mapping?.[anchorId]?.message;
    const c = m?.content || {};
    const text = [c.text || "", ...(c.parts || []).map(x => typeof x === "string" ? x : "")].join("\n");
    return text.includes("【PGから：GPTへ回す仕事】");
  }
  function articleGuardAnchorIsAudit(conv, anchorId) {
    const m = anchorId && conv?.mapping?.[anchorId]?.message;
    const c = m?.content || {};
    const text = [c.text || "", ...(c.parts || []).map(x => typeof x === "string" ? x : "")].join("\n");
    return text.includes(ARTICLE_GUARD_AUDIT_MARK);
  }

  // v9：起点（Danの発言）の文
  function articleGuardHumanTextOf(conv, id) {
    const m = id && conv?.mapping?.[id]?.message;
    if (!m) return undefined;
    const c = m.content || {};
    return [c.text || "", ...(c.parts || []).map(x => typeof x === "string" ? x : "")].join("\n").trim();
  }
  // v5：最後の人側の発言の文
  function articleGuardLastUserText(conv) {
    const mapping = conv && conv.mapping;
    if (!mapping || !conv.current_node) return null;
    for (let id = conv.current_node, g = 0; id && mapping[id] && g < 100000; id = mapping[id].parent, g++) {
      const m = mapping[id].message;
      if (m?.author?.role !== "user") continue;
      const c = m.content || {};
      return [c.text || "", ...(c.parts || []).map(x => typeof x === "string" ? x : "")].join("\n").trim();
    }
    return "";
  }
  // v5：再開の時、最後の依頼が見張りの監査の依頼（止めた・終わり・独立監査の結果の知らせは除く）で、見張りがその答えを待っているなら true。
  // その時は見張りの状態を「同じ依頼をすぐ送り直す」にする（送り直しは回数に数えない・止まった途中の答えは読まない）。
  async function articleGuardResumeInstead(conversationId) {
    try {
      if (!conversationId) return false;
      const st = articleGuardLoad(conversationId);
      if (!st || st.mode !== ARTICLE_GUARD_MODE || st.blocked || st.complete) return false;
      let conv = null;
      try { conv = await fetchConversationMetadata(conversationId); } catch (_) { conv = null; }
      if (conv) {
        const last = articleGuardLastUserText(conv);
        if (last === null || !last.startsWith(ARTICLE_GUARD_MARK)) return false;
        if (last.startsWith(ARTICLE_GUARD_STOP_LINE) || last.startsWith(ARTICLE_GUARD_AUDIT_DONE) || last.startsWith(ARTICLE_GUARD_MARK + "独立監査の結果")) return false;
        if (st.anchorId && reportGuardHumanAnchor(conv) !== st.anchorId) return false;
      } else if (st.sent !== 1) return false;   // 会話の記録が読めない時は、見張りが答えを待っている時だけ監査の続きとみる
      articleGuardSave(conversationId, Object.assign({}, st, {
        sent: 0, retryAt: Date.now(),
        tries: Math.max(0, (st.tries || 0) - 1), total: Math.max(0, (st.total || 0) - 1),
        readNode: conv?.current_node || st.readNode || "", resumedAt: Date.now()
      }));
      return true;
    } catch (_) { return false; }
  }
  function articleGuardBatchItems(batch, state = null) { return articleGuardBatchesOf(state)[batch] || []; }
  function articleGuardBatchEnd(batch, state = null) { const items = articleGuardBatchItems(batch, state); return items.length ? items[items.length - 1] : ""; }
  // v7：項目名は空白・記号・太字の違いを無視して比べる。「：」の前（短い名前）が同じなら同じ項目とみる（番号は別に必ず一致を見ている）。
  function articleGuardLabelKey(v) { return String(v || "").replace(/[\s　*_`]/g, "").replace(/[:：]/g, "：").replace(/[。．.]+$/, ""); }
  function articleGuardLabelSame(given, want) {
    const a = articleGuardLabelKey(given), b = articleGuardLabelKey(want);
    if (!a || !b) return false;
    if (a === b) return true;
    const ha = a.split("：")[0], hb = b.split("：")[0];
    return ha.length >= 2 && ha === hb;
  }
  function articleGuardItemsLabel(items, state = null) { return items.map(no => `No.${no} ${articleGuardLabel(state, no)}`).join(" / "); }
  function articleGuardNormalize(s) { return String(s || "").replace(/<br\s*\/?\s*>/gi, "").replace(/\s+/g, "").replace(/[`*_]/g, "").trim(); }
  // v13：引用の照合用。タグ・記号の書き方・かぎ括弧・全角半角の違いを無視する（文字そのものは変えない）
  function articleGuardQuoteKey(s) {
    let t = String(s || "").replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'");
    try { t = t.normalize("NFKC"); } catch (_) {}
    return t.replace(/[\s`*_「」『』"“”'‘’]/g, "").trim();
  }
  function articleGuardEvidenceInSource(quote, source, minLen = 8) {
    const MIN = Number.isInteger(minLen) && minLen >= 1 ? minLen : 8;
    const q = String(quote || "");
    const hay = articleGuardNormalize(source);
    const hay2 = articleGuardQuoteKey(source);
    const one = (s) => {
      const raw = String(s).replace(/^[「『"“]+|[」』"”]+$/g, "");
      const n = articleGuardNormalize(raw);
      if (n.length >= MIN && hay.includes(n)) return true;
      const k = articleGuardQuoteKey(raw);
      if (k.length >= MIN && hay2.includes(k)) return true;
      // 「A…B」：…で分けたそれぞれが6文字以上・合わせて8文字以上で、原稿に順番どおりある
      const segs = articleGuardQuoteKey(raw.replace(/(\.{3,}|…+|‥+)/g, "\u0000")).split("\u0000").filter(x => x);
      if (segs.length >= 2 && segs.every(x => x.length >= 6) && segs.join("").length >= MIN) {
        let at = 0;
        for (const x of segs) { const i = hay2.indexOf(x, at); if (i < 0) return false; at = i + x.length; }
        return true;
      }
      return false;
    };
    if (one(q)) return true;
    // 2026-10-28: 「A」／「B」／「C」と並べた引用（会話 6ae18427 No.20）
    const parts = q.split(/」\s*[／/、,，]\s*「/).map(s => s.replace(/^\s*「|」\s*$/g, "")).filter(s => s.trim());
    return parts.length >= 2 && parts.every(one);
  }
  function articleGuardHasBreakProblem(source) { return !!articleGuardBreakDetail(source); }
  // 2026-10-29: the program checks syntax/structure, not Japanese prose quality.
  // Long lines (including image URLs, files listings and Markdown syntax) are not
  // a reason to fail No.10-1...10-8. Those eight cases are read in their own
  // respective audit rows against the live master rules.
  // Retain the old function names for the extension's compatibility contract.
  function articleGuardMarkdownAsHtml(source) {
    const text = String(source || "").replace(/\r\n/g, "\n");
    if (/<p\b/i.test(text)) return text; // already rendered HTML
    const blocks = text.split(/\n[ \t]*\n/);
    const out = [];
    const nonProse = (l) => /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||`{3,}|~~~|!\[[^\]]*\]\([^)]*\)|<\/?(?:h\d|ul|ol|li|table|figure|blockquote|div|pre|code|img)\b|(?:total\s+\d+|[-dlcbps][-rwxstST-]{9}\s+\d+\s+))/i.test(l);
    for (const block of blocks) {
      const lines = block.split("\n").filter(l => l.trim());
      if (!lines.length || lines.some(l => /^\s*(?:`{3,}|~~~)/.test(l))) continue;
      const prose = lines.filter(l => !nonProse(l));
      if (!prose.length) continue;
      let html = "";
      prose.forEach((l, i) => {
        const hard = / {2,}$/.test(l) || /\\$/.test(l) || /<br\s*\/?\s*>\s*$/i.test(l);
        html += l.replace(/ {2,}$/, "").replace(/\\$/, "").replace(/<br\s*\/?\s*>\s*$/i, "");
        if (i < prose.length - 1) html += hard ? "<br>" : " ";
      });
      out.push("<p>" + html + "</p>");
    }
    return out.join("\n");
  }
  function articleGuardBreakDetail(source) {
    // Do not conflate a structural measurement with subjective prose quality.
    // Absence of <br>, >=88 visible chars, and single-sentence paragraphs are
    // not universal failures under the 2026-10-29 canonical rule revision.
    // Empty here means "no programmatic veto"; it is NOT a PASS for the AI audit.
    void articleGuardMarkdownAsHtml(source);
    return "";
  }
  function articleGuardHasBreakProblemOld(source) {
    // Retain the exported compatibility symbol, but retire the old 88-char rule.
    return !!articleGuardBreakDetail(source);
  }
  // Machine-verifiable evidence for the master rule 12-1, 12-3, 13-5.
  // Never count Markdown headings/images/tables/code as prose lines.
  function articleGuardStructuralMeasure(source, pg) {
    const P = Object.assign({}, ARTICLE_GUARD_PG_DEFAULT, pg || {});   // v16
    const t = String(source || "").replace(/\r\n/g, "\n");
    const lines = t.split("\n");
    let inFence = false, quoteOn = false, quoteBlocks = 0, nonempty = 0;
    const bold = [];
    for (let i=0; i<lines.length; i++) {
      const line = lines[i], v=line.trim();
      if (/^(```|~~~)/.test(v)) { inFence=!inFence; quoteOn=false; continue; }
      if (inFence || !v) {quoteOn=false;continue;}
      const quote = /^>\s?/.test(v);
      if (quote && !quoteOn) quoteBlocks++;
      quoteOn=quote;
      if (/^(#{1,6}\s|\||!\[|<\/?(?:table|tr|td|th|figure|img|pre|code|blockquote)\b)/i.test(v) || /^[-:| ]{3,}$/.test(v)) continue;
      nonempty++;
      // Markdown strong spans and HTML <strong> in ordinary text only.
      const re=/\*\*([^\n*]+)\*\*|<strong\b[^>]*>([\s\S]*?)<\/strong>/gi;
      let m; while ((m=re.exec(line))) {
        const visible=String(m[1]||m[2]||'').replace(/<[^>]*>/g,'');
        bold.push({line:i+1,column:m.index+1,length:[...visible].length,text:visible.slice(0,32)});
      }
    }
    // Count HTML blockquotes as distinct HTML blocks only when present.
    const htmlBlocks=(t.match(/<blockquote\b/gi)||[]).length;
    // Markdown and HTML are alternative representations in this system.
    if (htmlBlocks && !quoteBlocks) quoteBlocks=htmlBlocks;
    return { nonempty, boldCount:bold.length, bold, quoteBlocks,
      boldRatioOK:bold.length * P.boldPerLines <= nonempty, boldLengthOK:bold.every(x=>x.length<=P.boldMaxChars), quoteCountOK:quoteBlocks<=P.quoteBlocksMax,
      sourceChars:[...t].length };
  }
  // 見出しは「【監査バッチ結果】」でも「【監査バッチ結果：No.1〜4】」でも読む。最後に出た表を見る。
  function articleGuardBatchParse(answer, state) {
    const text = String(answer || "");
    const heads = Array.from(text.matchAll(/【監査バッチ結果[^】\n]{0,40}】/g));
    if (!heads.length) return { valid: false, reason: "【監査バッチ結果】の見出しがない" };
    const lines = text.slice(heads[heads.length - 1].index).split(/\r?\n/)
      .map(x => x.replace(/^\s*\\(?=\|)/, "").replace(/\\\|/g, "／"));
    const header = /^\s*\|\s*No\.?\s*\|\s*監査項目\s*\|\s*結果\s*\|\s*位置\s*\|\s*原文引用\s*\|\s*判定根拠\s*\|\s*$/;
    const sep = /^\s*\|(?:\s*:?-{3,}:?\s*\|){6}\s*$/;
    const idx = lines.findIndex(x => header.test(x));
    if (idx < 0 || !sep.test(lines[idx + 1] || "")) return { valid: false, reason: "6列の表（No.｜監査項目｜結果｜位置｜原文引用｜判定根拠）がない" };
    const items = articleGuardBatchItems(state.batch || 0, state);
    const rows = [];
    for (let i = idx + 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);
    const entries = [];
    const PG = articleGuardPgOf(state);   // v16
    // v13：表の使い方の小項目では、左右対応の申告は同じ答えの中で1回あればよい
    let tableDecl = "";
    for (const line of rows) {
      const mm = line.match(new RegExp("^\\s*\\|\\s*(?:No\\.?\\s*)?(" + ARTICLE_GUARD_NO_RE + ")\\s*\\|"));
      const dm = line.match(/左右対応[：:]\s*(使う|使わない)/);
      if (mm && dm && PG.tableIds.length && articleGuardRuleIs(articleGuardRule(state, articleGuardNo(mm[1])), PG.tableIds)) { tableDecl = dm[1]; break; }
    }
    for (const line of rows) {
      const m = line.match(new RegExp("^\\s*\\|\\s*(?:No\\.?\\s*)?(" + ARTICLE_GUARD_NO_RE + ")\\s*\\|\\s*([^|]+)\\|\\s*([○×])\\s*\\|\\s*([^|]+)\\|\\s*([^|]+)\\|\\s*([^|]+)\\|\\s*$"));
      if (!m) return { valid: false, reason: "表の行の形が違う（○か×が無い・列が足りない）" };
      const no = articleGuardNo(m[1]);
      if (!items.includes(no)) return { valid: false, reason: `今回の項目ではないNo.${no}が入っている（今回は${items.join("・")}だけ）` };
      if (!articleGuardLabelSame(m[2], articleGuardLabel(state, no))) return { valid: false, reason: `No.${no}の項目名が違う（正しくは「${articleGuardLabel(state, no)}」）` };
      if (entries.some(e => e.no === no)) return { valid: false, reason: `No.${no}が2回ある` };
      const row = { no, item:m[2].trim(), verdict:m[3], anchor:m[4].trim(), quote:m[5].trim(), reason:m[6].trim() };
      if (!row.anchor || row.reason.length < PG.reasonMin || /^(問題なし|監査した|確認した|適切|合格|OK)[。！ ]*$/.test(row.reason)) return { valid: false, reason: `No.${no}の位置・根拠が足りない（根拠は${PG.reasonMin}文字以上）` };
      if (row.verdict === "○") {
        if (/^\**未確認[：:]/.test(row.reason)) return { valid: false, reason: `No.${no}が○なのに根拠が「未確認」` };
        if (![state.source, ...(state.sources || [])].some(src => articleGuardEvidenceInSource(row.quote, src, PG.quoteMin))) return { valid: false, reason: `No.${no}の○の原文引用が原稿に見つからない（${PG.quoteMin}文字以上をそのまま写す）` };
        if (PG.tableIds.length && articleGuardRuleIs(articleGuardRule(state, row.no), PG.tableIds)) {
          const own = row.reason.match(/左右対応[：:]\s*(使う|使わない)/);
          const m = own || (tableDecl ? [null, tableDecl] : null);
          if (!m) return { valid: false, reason: `No.${row.no}の判定根拠に「左右対応：使う」または「左右対応：使わない（理由）」が無い。事故・改善記事なら、本人の実際の要求・指摘とAIの実作業・結果を左右に並べるかを先に決める` };
          const hasTable = /<table\b/i.test(state.source) || /^\s*\|.*\|.*\|\s*$/m.test(state.source);
          if (own && m[1] === "使う" && !hasTable) {
            row.verdict = "×";
            row.reason = "PGの検査：左右対応を「使う」としたのに、原稿に左右の表が無い。本人の実際の要求・指摘（左）とAIの実作業・結果（右）の表を入れて直す。";
          }
        }
        // 2026-10-29: Do not inject a single global <br>/88-char failure into
        // every No.10 row. The source-extract, quote and table checks above
        // remain mechanical; each paragraph-style row is judged individually.
      }
      entries.push(row);
    }
    const missing = items.filter(no => !entries.some(e => e.no === no));
    if (missing.length) return { valid: false, reason: `No.${missing.join("・")}の行がない` };
    return { valid:true, entries };
  }

  function articleGuardOutsideOnly(reason) {
    return /(別担当|独立監査|原記録|一次記録|元の事故記録|原事故|実表示|公開画面)/.test(String(reason || ""));
  }
  function articleGuardNewest(answer) {
    return articleGuardSplit(answer).articles.find(b => /^#\s+\S/.test(b.trim()) && b.replace(/\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS) || "";
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
    const line = String(text || "").trim().split("\n").find(x => /^#\s+\S/.test(x.trim())) || "";
    return line.replace(/^#\s+/, "").replace(/<[^>]+>/g, "").trim().slice(0, 120);
  }
  function articleGuardGrams(text) {
    const p = articleGuardPlainText(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
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
    const url = (String(humanText || "").match(/https?:\/\/[^\s)\]>」]+/) || [""])[0];
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
    const list = articleGuardSplit(answer).articles.filter(b => /^#\s+\S/.test(b.trim()) && b.replace(/\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS);
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
  function articleGuardStop(state, why) {
    const n = Object.assign({}, state, { blocked:true, kind:"stop", stopWhy:why, sent:0, retryAt:0 });
    return { state:n, send:true, gaveUp:true, blockReason:why };
  }
  // 返り値 send:true の時は state.kind（start/next/fix/format/done/stop）の文を送る。
  function articleGuardDecide(state, answer, nowMs, anchorId = "", audit = false, humanText) {
    // v9：見張りの途中（止めた・終わった以外）でDanが発言した時は、URLが無ければ同じ記事の監査を続ける
    let danCont = false;
    if (state && state.mode === ARTICLE_GUARD_MODE && state.anchorId && anchorId && state.anchorId !== anchorId
        && !state.blocked && !state.complete && !state.audit && typeof humanText === "string" && !/https?:\/\//i.test(humanText)) {
      state = Object.assign({}, state, { anchorId, danSaid: humanText.replace(/\s+/g, " ").trim().slice(0, 300), tries: 0 });
      danCont = true;
    }
    // v17：止めた・終わった後にDanが（URLなしで）発言して見張りを始め直す時も、前の監査対象の記事を引き継ぐ
    let carryTarget = null;
    if (state && state.mode === ARTICLE_GUARD_MODE && state.target && state.anchorId && anchorId && state.anchorId !== anchorId
        && typeof humanText === "string" && !/https?:\/\//i.test(humanText)) carryTarget = state.target;
    if (state && (state.mode !== ARTICLE_GUARD_MODE || (state.anchorId && state.anchorId !== anchorId))) state = null;
    state = articleGuardRefreshRuleSnapshot(state);
    if (state && !state.target && state.source) state = Object.assign({}, state, { target: articleGuardMakeTarget(state.source, "") });   // v17：v16以前に始めた見張りは今の原稿で固定
    const lockTarget = (state && state.target) || carryTarget;
    const picked = articleGuardPickArticle(answer, lockTarget, (state && state.source) || "");
    let newestArticle = picked.article, otherArticle = picked.other, otherWhy = picked.why, switchTarget = false;
    if (!newestArticle && otherArticle && typeof humanText === "string" && (danCont || carryTarget) && articleGuardWantsSwitch(humanText, otherArticle)) {
      newestArticle = otherArticle; otherArticle = ""; switchTarget = true;   // Danが別の記事へ移すと言った
    }
    // v16：一時停止中は、GPTが記事を出すまで何もしない（記事が出たら監査を続ける）
    if (state && state.paused && !state.blocked && !state.complete) {
      if (!newestArticle && !articleGuardCodeBlockArticle(answer)) return {state, send:false, gaveUp:false};
      state = Object.assign({}, state, { paused:false, pausedWhy:"" });
      danCont = true;
    }
    // v16：Danの発言の後の答えに記事も表も無く、仕組みの話（拡張・PG・SSなど）なら、監査の依頼は送らず一時停止
    const answerPlain = String(answer || "").replace(/<WritingBlock[\s\S]*?<\/WritingBlock>/g, "");
    const systemTalk = danCont && !newestArticle && !/【監査バッチ結果/.test(answer)
      && (ARTICLE_GUARD_SYSTEM_TALK.test(String(humanText || "")) || ARTICLE_GUARD_SYSTEM_TALK.test(answerPlain));
    if (!newestArticle && (audit || state?.audit)) {
      const plain = String(answer || "").replace(/---原稿ここ(から|まで)---/g, "").trim();
      if (/^#\s+\S/.test(plain) && plain.replace(/\s+/g, "").length >= ARTICLE_GUARD_MIN_CHARS && !/【監査バッチ結果/.test(plain)) {
        const t = articleGuardIsTarget(lockTarget, plain, (state && state.source) || "");
        if (t.ok) newestArticle = plain; else if (!otherArticle) { otherArticle = plain; otherWhy = t.why; }
      }
    }
    const hiddenNames = articleGuardHiddenNames(answer);
    if (!state && !newestArticle && hiddenNames && !audit) {
      const n = { mode:ARTICLE_GUARD_MODE, anchorId, source:"", batch:0, tries:0, total:0, kind:"needtext", needText:true, hiddenNames, records:{}, lastFails:[], lastReason:"", sent:0, retryAt:0, blocked:false, complete:false, audit:false, auditFails:[], rules:articleGuardCurrentRules() };
      return {state:n, send:true, gaveUp:false, blockReason:`記事のファイル（${hiddenNames.join("、")}）をDriveに書いたが本文が会話に無い→全文を出す依頼`};
    }
    if (!state) {
      if (!newestArticle) return {state:null, send:false, gaveUp:false};
      const target = (carryTarget && !switchTarget) ? carryTarget : articleGuardMakeTarget(newestArticle, humanText);
      const n = { mode:ARTICLE_GUARD_MODE, anchorId, source:newestArticle, target, batch:0, tries:0, total:0, kind:"start", records:{}, lastFails:[], lastReason:"", sent:0, retryAt:0, blocked:false, complete:false, audit:!!audit, auditFails:[], rules:articleGuardCurrentRules() };
      return {state:n, send:true, gaveUp:false, blockReason: switchTarget ? `Danの指示で監査対象を「${target.title}」（${articleGuardLangName(target.lang)}）に変えて最初から` : ""};
    }
    // 止めた／終わった後は、止めた・終わったの文を送り終えるまでは送るだけ、その後は何もしない。
    if (state.blocked || state.complete) return {state, send:false, gaveUp:false};
    if (state.needText) {   // 2026-10-28 v3：全文を待っている
      if (!newestArticle) {   // v4：「# 題名」＋コードの枠で出した全文も読む（v17：監査対象の記事の時だけ）
        const cb = articleGuardCodeBlockArticle(answer);
        if (cb && articleGuardIsTarget(lockTarget, cb, state.source || "").ok) newestArticle = cb;
      }
      if (newestArticle) {
        const n = { mode:ARTICLE_GUARD_MODE, anchorId, source:newestArticle, target: state.target || articleGuardMakeTarget(newestArticle, humanText), batch:0, tries:0, total:state.total || 0, kind:"start", records:{}, lastFails:[], lastReason:"", sent:0, retryAt:0, blocked:false, complete:false, audit:false, auditFails:[], rules:state.rules || articleGuardCurrentRules() };
        return {state:n, send:true, gaveUp:false};
      }
      if (danCont && systemTalk) return {state:Object.assign({}, state, { paused:true, pausedWhy:"Danの発言の後は仕組みの話（記事なし）", sent:0, retryAt:0 }), send:false, gaveUp:false, blockReason:"Danの発言の後は仕組みの話：監査を一時停止（記事が出たら続ける）"};
      if (danCont) return {state:Object.assign({}, state, { kind:"needtext", sent:0, retryAt:0 }), send:true, gaveUp:false, blockReason:"Danの発言の後：記事の全文をもう一度頼む"};
      if ((state.tries || 0) >= 2) return articleGuardStop(Object.assign({}, state, { needText:false }), `記事のファイル（${(state.hiddenNames || []).join("、")}）を書いたが、2回頼んでも記事の全文が会話に出ない`);
      return {state:Object.assign({}, state, { kind:"needtext", hiddenNames: hiddenNames || state.hiddenNames, sent:0, retryAt:0 }), send:true, gaveUp:false, blockReason:"記事の全文がまだ出ていない→もう一度依頼"};
    }
    let s = Object.assign({}, state);
    if (switchTarget && newestArticle) {   // v17：Danの指示で別の記事へ。前の記事の結果は混ぜずに最初から
      const target = articleGuardMakeTarget(newestArticle, humanText);
      const n = Object.assign({}, s, { source:newestArticle, sources:[], target, batch:0, tries:0, total:0, kind:"start", records:{}, lastFails:[], lastReason:"", sent:0, retryAt:0, wrongTitle:"", wrongWhy:"" });
      return {state:n, send:true, gaveUp:false, blockReason:`Danの指示で監査対象を「${target.title}」（${articleGuardLangName(target.lang)}）に変えて最初から`};
    }
    if (newestArticle && newestArticle !== s.source) { // 直した原稿で同じ4項目を見る。前の版も引用の照合用に残す
      s.sources = [s.source, ...(s.sources || [])].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 6).map(x => x.slice(0, 40000));
      s.source = newestArticle;
    }
    if ((s.total || 0) >= articleGuardMaxTotal(s)) return articleGuardStop(s, `送った回数が${articleGuardMaxTotal(s)}回を超えた`);
    const items = articleGuardBatchItems(s.batch, s);
    const parsed = articleGuardBatchParse(answer, s);
    // v17：監査対象と違う記事の原稿だけが出た → 差し替えず、その答えの表も使わない。対象の記事で同じ項目をやり直させる
    if (otherArticle && !newestArticle) {
      if (s.kind === "wrongtarget" && (s.tries || 0) >= ARTICLE_GUARD_MAX_TRIES) {
        return articleGuardStop(s, `監査対象（「${(s.target || {}).title || ""}」${articleGuardLangName((s.target || {}).lang)}）と違う記事の原稿が${ARTICLE_GUARD_MAX_TRIES}回続いた（${otherWhy}）`);
      }
      const n = Object.assign({}, s, { kind:"wrongtarget", tries: s.kind === "wrongtarget" ? s.tries : 0, wrongTitle: articleGuardTitleOf(otherArticle), wrongWhy: otherWhy, lastReason:"", sent:0, retryAt:0 });
      return {state:n, send:true, gaveUp:false, blockReason:`監査対象と違う記事の原稿（「${n.wrongTitle}」：${otherWhy}）→ 監査対象にしない`};
    }
    if (danCont && !parsed.valid && systemTalk) {
      return {state:Object.assign({}, s, { paused:true, pausedWhy:"Danの発言の後は仕組みの話（記事なし）", sent:0, retryAt:0, lastReason:"" }), send:false, gaveUp:false, blockReason:"Danの発言の後は仕組みの話：監査を一時停止（記事が出たら続ける）"};
    }
    if (danCont && !parsed.valid) {
      return {state:Object.assign({}, s, { kind: s.kind === "fix" ? "fix" : "next", sent:0, retryAt:0, lastReason:"" }), send:true, gaveUp:false, blockReason:"Danの発言の後：今の組の監査を続ける"};
    }
    if (parsed.valid) {
      if (s.kind === "format") s.tries = 1;   // v8：読める表が出たら、表の形のやり直しで使った回数は数えない（この答えを1回目とする）
      const fails = parsed.entries.filter(e => e.verdict !== "○");
      const records = Object.assign({}, s.records || {});
      for (const e of parsed.entries) records[e.no] = { verdict:e.verdict, reason:e.reason.slice(0, 120) };
      s.records = records;
      if (s.audit && fails.length) {
        s.auditFails = [...(s.auditFails || []), ...fails.map(e => ({ no:e.no, reason:e.reason.slice(0, 160) }))];
      }
      if (!fails.length || s.audit) {
        const next = s.batch + 1;
        if (next >= articleGuardBatchesOf(s).length) {
          const n = Object.assign({}, s, { batch:next, tries:0, kind:"done", complete:true, lastFails:[], lastReason:"", sent:0, retryAt:0 });
          return {state:n, send:true, gaveUp:false, blockReason: s.audit ? `独立監査の終わり：×${(s.auditFails || []).length}件` : `${articleGuardCheckCount(s)}項目すべて○` + (articleGuardWaitList(s).length ? `。No.${articleGuardWaitList(s).join("・")}は外の確認待ち` : "")};
        }
        return {state:Object.assign({}, s, { batch:next, tries:0, kind:"next", lastFails:[], lastReason:"", sent:0, retryAt:0 }), send:true, gaveUp:false};
      }
      if ((s.tries || 0) >= ARTICLE_GUARD_MAX_TRIES) {
        const pgWhy = fails.filter(e => /^PGの検査：/.test(e.reason)).map(e => `No.${e.no}は${e.reason.replace(/（GPTの判定は○[\s\S]*$/, "")}`).join("／");
        return articleGuardStop(s, `No.${items.join("・")}が${ARTICLE_GUARD_MAX_TRIES}回やっても全部○にならない（×：No.${fails.map(e => e.no).join("・")}）${pgWhy ? "。" + pgWhy : ""}`);
      }
      return {state:Object.assign({}, s, { kind:"fix", lastFails:fails.map(e => ({ no:e.no, reason:e.reason.slice(0, 120) })), lastReason:"", sent:0, retryAt:0 }), send:true, gaveUp:false, blockReason:`×あり：No.${fails.map(e => e.no).join("・")}`};
    }
    if ((s.tries || 0) >= ARTICLE_GUARD_MAX_TRIES && s.audit) {
      // 2026-10-28: 監査役は止めずに最後まで。読める表が出なかった項目は×として書く側へ伝える。
      s.auditFails = [...(s.auditFails || []), ...items.map(no => ({ no, reason: `監査役が${ARTICLE_GUARD_MAX_TRIES}回やっても読める表を出せなかった（${parsed.reason}）。未確認のため×` }))];
      const next = s.batch + 1;
      if (next >= articleGuardBatchesOf(s).length) {
        return {state:Object.assign({}, s, { batch:next, tries:0, kind:"done", complete:true, lastFails:[], lastReason:"", sent:0, retryAt:0 }), send:true, gaveUp:false, blockReason:`独立監査の終わり：×${s.auditFails.length}件`};
      }
      return {state:Object.assign({}, s, { batch:next, tries:0, kind:"next", lastFails:[], lastReason:"", sent:0, retryAt:0 }), send:true, gaveUp:false, blockReason:`監査役：No.${items.join("・")}は読める表が出ず×として次へ`};
    }
    if ((s.tries || 0) >= ARTICLE_GUARD_MAX_TRIES) return articleGuardStop(s, `No.${items.join("・")}が${ARTICLE_GUARD_MAX_TRIES}回やっても読める表にならない（${parsed.reason}）`);
    return {state:Object.assign({}, s, { kind:"format", lastReason:parsed.reason, sent:0, retryAt:0 }), send:true, gaveUp:false, blockReason:parsed.reason};
  }
  function articleGuardTableLines(items, state = null) {
    return [
      "【監査バッチ結果】",
      "| No. | 監査項目 | 結果 | 位置 | 原文引用 | 判定根拠 |",
      "|---|---|---|---|---|---|",
      ...items.map(no => `| ${no} | ${articleGuardLabel(state, no)} | × | 該当箇所・未確認 | 未確認 | 未確認：本文・根拠の照合が完了していないため合格と判断しない |`),
      "上は行形式の例。必ず実際に調べた結果で置き換える。見出しは【監査バッチ結果】のまま、表は今回の項目の行だけ。"
    ];
  }
  function articleGuardText(round, state) {
    const kind = state?.kind || "start";
    const batch = state?.batch || 0;
    const items = articleGuardBatchItems(batch, state);
    const tryNo = (state?.tries || 0) + 1;
    const waitList = articleGuardWaitList(state);
    const waitNo = waitList.length ? `No.${waitList.join("・")}` : "外の確認の項目";
    const waitNote = waitList.length ? `${waitNo}は外の確認（公開画面・別担当）が要るので、この見張りでは調べない。○にもしない。` : "";
    // 2026-10-27 21:55 Dan「GPTの中で一旦完結させたい」：正本のNo.1・4のPASS条件に「別担当で監査PASS」「原記録と一致」があり、
    // GPTの自己監査では永遠に○にならなかった（会話 6ae0964b）。外の確認はNo.5・11・17・21でまとめて扱う。
    const outsideNote = `正本のPASS条件のうち『別担当の独立監査PASS』『原記録・一次記録・元の事故記録との照合』『公開画面・実表示の確認』は、この見張りの判定に入れない（${waitNo}でまとめて扱う外の確認待ち）。それ以外の条件を原稿が満たしていれば○にする。この3つだけを理由に×にしない。`;
    if (kind === "needtext") {
      return [
        ...(articleGuardTargetLine(state) ? [articleGuardTargetLine(state)] : []),
        ...(state?.danSaid ? [ARTICLE_GUARD_MARK + `Danの発言の後も監査を続ける（直前のDanの発言：「${state.danSaid}」）`] : []),
        ARTICLE_GUARD_MARK + `記事の全文を出す（監査の前・${tryNo}回目／2回まで）`,
        "これは拡張PGが自動で送った依頼で、本人の発言ではない。",
        `前の答えで記事のファイル（${(state?.hiddenNames || []).join("、") || "記事ファイル"}）をDriveに書いたが、会話に記事の本文が出ていないので、PGは監査できない。`,
        "直した記事の全文を、「# 」で始まるドキュメント（文章の枠）でこの会話に1つだけ出す。コードの枠には入れない。ファイル・リンク・要約だけで渡さない。HTMLの記事でも本文はそのまま全文を出す。",
        "全文が出たら、PGがルール正本の項目で監査を始める。それまでは『監査済み』『公開合格』とは言わない。",
        "この依頼への返事では、記事の全文だけを出す。"
      ].join("\n");
    }
    if (kind === "stop") {
      return [
        ARTICLE_GUARD_STOP_LINE + `（No.${items.join("・")}）`,
        "これは拡張PGが自動で送った文で、本人の発言ではない。",
        `理由：${state?.stopWhy || ""}`,
        "記事の見張りはここで終わり。PC側の係がDanにLINEで知らせる。",
        "この記事の監査と修正の続きは、Danの返事を待ってから行う。この文への返事は、今の状況を3行以内でまとめるだけでよい。"
      ].join("\n");
    }
    if (kind === "done" && state?.audit) {
      const af = state.auditFails || [];
      return [
        ARTICLE_GUARD_AUDIT_DONE + `：×${af.length}件` + (af.length ? `（No.${af.map(f => f.no).join("・")}）` : "（全部○）"),
        "これは拡張PGが自動で送った文で、本人の発言ではない。",
        ...af.map(f => `・No.${f.no} ${articleGuardLabel(state, f.no)}：${f.reason}`),
        af.length ? "原稿は直さない。この結果はPGが原稿を書いた側へ回す。" : "×は無かった。この結果はPGが原稿を書いた側とDanのボードへ伝える。",
        waitNote,
        "この文への返事は、×の項目ごとに直し方を1行ずつ書くだけでよい（×が無ければ「×なし」の1行）。原稿は出さない。"
      ].join("\n");
    }
    if (kind === "done") {
      return [
        ARTICLE_GUARD_MARK + `${articleGuardCheckCount(state)}項目すべて○`,
        "これは拡張PGが自動で送った文で、本人の発言ではない。",
        ...(state?.target?.title ? [`○になったのは監査対象の記事「${state.target.title}」（${articleGuardLangName(state.target.lang)}）だけ。ほかの記事・英語版は監査していない。`] : []),
        waitNote,
        `${waitNo}が終わるまでは『公開合格』とは言わない。この拡張PGは意味の真偽と独立監査の実体を確かめられない。`,
        "この文への返事では、まず監査を通った最終の原稿の全文を「# 」で始まるドキュメント（文章の枠）で1つだけ出す。Danが読む用なので、HTMLのタグやコードの枠を使わず、見出し・段落・表・引用をそのまま読める文章で書く。段落の中の改行（<br>の所）は改行のまま残す。ファイルやリンクだけで渡さない・要約しない・監査の後に中身を変えない。",
        `そのあとに、残りの確認待ち${waitList.length}項目を誰が何で確かめるかを3行以内で書く。`
      ].join("\n");
    }
    const head = kind === "fix"
      ? ARTICLE_GUARD_MARK + `×あり・直して同じ${items.length}項目をやり直し（No.${items.join("・")}、${tryNo}回目／${ARTICLE_GUARD_MAX_TRIES}回まで）`
      : kind === "format"
        ? ARTICLE_GUARD_MARK + `表が読めなかったので同じ項目をもう一度（No.${items.join("・")}、${tryNo}回目／${ARTICLE_GUARD_MAX_TRIES}回まで）`
      : kind === "wrongtarget"
        ? ARTICLE_GUARD_MARK + `監査対象と違う記事の原稿が出たので使わない。同じ項目を監査対象の記事でもう一度（No.${items.join("・")}、${tryNo}回目／${ARTICLE_GUARD_MAX_TRIES}回まで）`
        : ARTICLE_GUARD_MARK + `大項目${articleGuardBigPerSend(state)}つずつ検査（今回${items.length}項目：No.${items.join("・")}、${tryNo}回目／${ARTICLE_GUARD_MAX_TRIES}回まで）`;
    const lines = [head, "これは拡張PGが自動で送った検査依頼で、本人の発言ではない。"];
    if (articleGuardTargetLine(state)) lines.push(articleGuardTargetLine(state));   // v17：最初の依頼から毎回、固定した記事を示す
    if (state?.audit) lines.push("あなたはこの原稿を書いていない監査担当（独立監査）。×があっても原稿は直さず、×と理由をそのまま書く。書いた側に遠慮して○にしない。");
    if (kind === "fix") {
      lines.push("前の答えで×だった項目：");
      for (const f of (state?.lastFails || [])) {
        lines.push(`・No.${f.no} ${articleGuardLabel(state, f.no)}：${f.reason}`);
        if (articleGuardOutsideOnly(f.reason)) lines.push(`　→ No.${f.no}の×の理由は外の確認待ち（別担当の監査・元の記録・公開画面）の話に見える。原稿の中に直す所が無ければ、原稿はそのままで○にする。`);
      }
      lines.push(state?.audit ? "原稿は直さない。同じ項目を下の表で調べ直す。" : "×の箇所を原稿で直し、直した原稿の全文を「# 」で始まるドキュメントで出す。そのあと同じ項目を下の表で調べ直す。");
    } else if (kind === "format") {
      lines.push(`前の答えはPGが読めなかった：${state?.lastReason || ""}`);
      lines.push("原稿はそのままでよい。同じ項目を下の表の形で書き直す。");
    } else if (kind === "wrongtarget") {
      lines.push(`前の答えの原稿「${state?.wrongTitle || ""}」は監査対象の記事ではない（${state?.wrongWhy || ""}）。PGはこの原稿を監査対象にせず、その答えの表も使わない。`);
      lines.push("監査対象の記事の原稿（直していなければ前の原稿のまま）で、同じ項目を下の表で調べ直す。監査対象の記事を直した時は、その全文を「# 」で始まるドキュメントで出す。別の記事の修正は、この監査が終わってから、Danの指示で別に行う。");
    }
    if (state?.danSaid) lines.push(`直前のDanの発言：「${state.danSaid}」。指摘があれば原稿を直し、直した原稿の全文を「# 」で始まるドキュメントで出してから、下の表で同じ項目を調べ直す。×があれば止まらずに直す。`);
    {
      const PGm = articleGuardPgOf(state);   // v16：項目No.としきい値は「拡張の設定」から
      const nos = [PGm.boldCountNo, PGm.boldLenNo, PGm.quoteCountNo].filter(Boolean);
      if (items.some(no => nos.includes(no))) {
        const m = articleGuardStructuralMeasure(state.source, PGm);
        const parts = [];
        if (PGm.boldCountNo) parts.push(`No.${PGm.boldCountNo}=${m.boldRatioOK ? "数量基準内" : "数量基準外"}（太字は本文${PGm.boldPerLines}行に1つまで）`);
        if (PGm.boldLenNo) parts.push(`No.${PGm.boldLenNo}=${m.boldLengthOK ? "長さ基準内" : "長さ基準外"}（太字1つ${PGm.boldMaxChars}字まで）`);
        if (PGm.quoteCountNo) parts.push(`No.${PGm.quoteCountNo}=${m.quoteCountOK ? "数量基準内" : "数量基準外"}（引用ブロック${PGm.quoteBlocksMax}個まで）`);
        lines.push(`【PG構造実測】同じ原稿：本文非空行${m.nonempty}、太字${m.boldCount}箇所、太字座標と文字数${JSON.stringify(m.bold)}、引用ブロック${m.quoteBlocks}箇所。${parts.join("、")}。数値はPGが原稿から計測したもので、AIの自己申告ではない。`);
      }
    }
    lines.push(
      "記事生成AIによる自己申告は独立監査の合格ではない。毎回ルール正本を直接読み、原稿の該当箇所を確認する。",
      `ルール正本: https://docs.google.com/spreadsheets/d/1ebOMWJYtMN57F4qzCJ9qjb5iwqNaVHURbQzHM9uqnA4/edit （ルール正本タブのNo.が入った行・今回の一覧は${articleGuardRulesOf(state).items.length}項目）`,
      `今回は${articleGuardItemsLabel(items, state)}の${items.length}項目だけを調べる。`,
      ...articleGuardNotes(state, items),
      "判定は○または×。実際の検査証拠が足りなければ×とし、根拠欄に『未確認：...』と書く。",
      "○は原文から実際に8文字以上を逐語引用し、位置（見出し／段落）と、正本の各判定条件に対する具体的な理由を20文字以上記す。文章の自然さ・改行は全文・全段落を採用見本と照合し、推測で○を付けない。",
      waitNote,
      outsideNote,
      "原稿を変えた時は、その回の答えに直した原稿の全文を「# 」で始まるドキュメントで出す。ファイルやプログラムで直しただけでは、PGは新しい原稿を読めず、その引用は原稿に無い扱いになる。",
      `今回の項目がすべて○になるまで次の項目へは進まない。×があれば直して同じ項目をやり直す。${ARTICLE_GUARD_MAX_TRIES}回やってもすべて○にならなければ見張りは止まり、Danに知らせる。`,
      ...articleGuardTableLines(items, state)
    );
    return lines.join("\n");
  }
  function articleGuardLoad(conversationId) {
    try { const v=localStorage.getItem(ARTICLE_GUARD_KEY+conversationId); return v ? JSON.parse(v):null; } catch(_) {return null;}
  }
  function articleGuardSave(conversationId,state) {
    try { if(state) localStorage.setItem(ARTICLE_GUARD_KEY+conversationId,JSON.stringify(state)); else localStorage.removeItem(ARTICLE_GUARD_KEY+conversationId); } catch(_) {}
  }
  function articleGuardTakeTestNow(conversationId) {
    try {
      const v=String(localStorage.getItem(ARTICLE_GUARD_TEST_NOW_KEY)||"");
      if(!v || v.split("|")[0]!==conversationId) return null;
      localStorage.removeItem(ARTICLE_GUARD_TEST_NOW_KEY);
      return { node:v.split("|")[1]||"" };
    } catch(_) {return null;}
  }
  let articleGuardLastWhy = "", articleGuardLastWhyAt = 0;
  async function articleGuardSendWhyNot(conversationId, anchorId) {
    try {
      if (conversationIdFromUrl() !== conversationId) return "別の会話を表示中";
      if (findStopButton()) return "GPTが答えている途中";
      const c = composerElement();
      if (!c) return "入力欄が見つからない" + (document.hidden ? "（裏のタブ）" : "");
      const typed = composerTextOf(c);
      if (typed) return "入力欄に文字がある：" + String(typed).slice(0, 20) + (document.hidden ? "（裏のタブ）" : "");
      if (anchorId) {
        const a = reportGuardHumanAnchor(await fetchConversationMetadata(conversationId));
        if (a !== anchorId) return "会話の起点が違う（" + String(a).slice(0, 8) + "）";
      }
      return document.hidden ? "送信ボタン待ちで時間切れ（裏のタブ）" : "送信ボタン待ちで時間切れ";
    } catch (e) { return "調べられない：" + (e?.message || e); }
  }
  async function articleGuardTrySend(conversationId,state) {
    if (await reportGuardSend(articleGuardText(1,state),conversationId,state.anchorId||"")) {
      const counted = state.kind !== "stop" && state.kind !== "done";
      const n = Object.assign({},state,{sent:1,retryAt:0,tries:(state.tries||0)+(counted?1:0),total:(state.total||0)+1,danSaid:""});
      articleGuardSave(conversationId,n);
      osfhEvent(state.kind==="stop"?"article_guard_stopped":"article_guard_sent",`${state.kind} No.${articleGuardBatchItems(state.batch, state).join(",")} try ${n.tries}${state.kind==="stop"?" "+(state.stopWhy||""):""}`);
    } else {
      articleGuardSave(conversationId,Object.assign({},state,{retryAt:Date.now()+ARTICLE_GUARD_RETRY_MS}));
      const why = await articleGuardSendWhyNot(conversationId, state.anchorId||"");
      if (why !== articleGuardLastWhy || Date.now() - articleGuardLastWhyAt > 60000) {
        articleGuardLastWhy = why; articleGuardLastWhyAt = Date.now();
        osfhEvent("article_guard_send_not_yet", `${state.kind}: ${why}`);
      }
    }
  }
  // 2026-10-28: 見張りの依頼の後にGPTの答えが出ているのに、まだ読んでいない時に true。
  function articleGuardUnreadAnswer(conv, state) {
    if (!state || state.blocked || state.complete || state.retryAt || state.sent !== 1) return false;
    const mapping = conv && conv.mapping;
    const last = mapping && conv.current_node && mapping[conv.current_node]?.message;
    if (!last || last.author?.role !== "assistant" || (last.recipient || "all") !== "all" || last.content?.content_type !== "text") return false;
    if (last.end_turn === false) return false;
    if (state.readNode && state.readNode === conv.current_node) return false;
    for (let id = conv.current_node, g = 0; id && mapping[id] && g < 100000; id = mapping[id].parent, g++) {
      const m = mapping[id].message;
      if (m?.author?.role !== "user") continue;
      const c = m.content || {};
      const text = [c.text || "", ...(c.parts || []).map(x => typeof x === "string" ? x : "")].join("\n").trim();
      if (text.startsWith(ARTICLE_GUARD_MARK)) return true;   // 直前の人側の発言が見張りの依頼
      // v10：見張りの途中でDanが発言し（起点と違う人の発言・URLなし）、その答えが出た時も読む（v9で監査を続ける）
      return !!state.anchorId && id !== state.anchorId && !/https?:\/\//i.test(text) && !text.startsWith("【PGから");
    }
    return false;
  }
  const ARTICLE_GUARD_CATCHUP_MS = 30000;
  const ARTICLE_GUARD_BACKOFF_KEY = "osfhArticleGuardBackoffUntil";
  function articleGuardBackingOff() {
    try { return Date.now() < Math.max(Number(localStorage.getItem(ARTICLE_GUARD_BACKOFF_KEY) || 0), Number(localStorage.getItem("osfhConvFetchBackoffUntil") || 0)); } catch (_) { return false; }
  }
  function articleGuardNoteError(error) {
    const msg = String(error?.message || error || "");
    if (/\b429\b/.test(msg)) { try { localStorage.setItem(ARTICLE_GUARD_BACKOFF_KEY, String(Date.now() + 5 * 60 * 1000)); } catch (_) {} }
  }
  // 画面の会話の文字数（記録を読まずに、新しい返事が出たかを知る。2026-10 のChatGPTの画面には返事ごとの印が無い）
  function articleGuardDomLastAssistant() {
    const m = document.querySelector("main");
    return m ? "len:" + String((m.textContent || "").length) : "";
  }
  let articleGuardLastDomSeen = "", articleGuardLastProbeSeen = "";
  let articleGuardLastCatchup = 0;
  let articleGuardLastAuditProbe = 0;
  function articleGuardLock(conversationId) {
    try {
      const key = "osfhArticleGuardLock:" + conversationId, now = Date.now();
      const me = typeof OSFH_INSTANCE_ID !== "undefined" ? OSFH_INSTANCE_ID : "x";
      const cur = JSON.parse(localStorage.getItem(key) || "null");
      if (cur && cur.inst !== me && cur.until > now) return false;
      localStorage.setItem(key, JSON.stringify({ inst: me, until: now + 30000 }));
      return JSON.parse(localStorage.getItem(key) || "null")?.inst === me;
    } catch (_) { return true; }
  }
  function articleGuardAnswerFinished(conv) {
    const last = conv && conv.mapping && conv.current_node && conv.mapping[conv.current_node]?.message;
    return !!last && last.author?.role === "assistant" && (last.recipient || "all") === "all"
      && last.content?.content_type === "text" && last.end_turn !== false;
  }
  // v18（2026-10-29）Dan「表が読めなかったので同じ項目をもう一度、って毎回出る」
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
  async function articleGuardEvaluate(conversationId, conv) {
    if (!articleGuardAnswerFinished(conv)) {
      const last = conv?.mapping?.[conv?.current_node]?.message;
      if (last?.author?.role !== "user") { articleGuardSawBusy = true; osfhEvent("article_guard_wait", "answer not finished yet"); }
      return;
    }
    if (!articleGuardLock(conversationId)) { osfhEvent("article_guard_other_tab", "another tab is handling this conversation"); return; }
    const anchorId=reportGuardHumanAnchor(conv);
    const answer=articleGuardReadAnswer(conv);
    let before=articleGuardLoad(conversationId);
    // v12：初見読者監査の会話では見張りを動かさない（答えは回し係が読む）
    if(String(articleGuardHumanTextOf(conv,anchorId)||"").includes(ARTICLE_GUARD_FIRSTREAD_MARK)) return;
    // v12：初見読者監査で差し戻された後の答え → 終わっていた見張りを捨て、直した全文で最初から
    if(before&&(before.complete||before.blocked)&&String(articleGuardLastUserText(conv)||"").startsWith(ARTICLE_GUARD_FIRSTREAD_BACK)){
      osfhEvent("article_guard_firstread_restart","初見読者監査の差し戻し：直した全文で項目の監査を最初から");
      before=null;
    }
    if(before&&before.readNode&&before.readNode===conv?.current_node) return;   // もう読んだ答え（別のタブが先に読んだ）
    const d=anchorId?articleGuardDecide(before,answer,Date.now(),anchorId,articleGuardAnchorIsAudit(conv,anchorId),articleGuardHumanTextOf(conv,anchorId)):{state:null,send:false,gaveUp:false};
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
    if(d.state) d.state=Object.assign({},d.state,{readNode:conv?.current_node||"",formatWait:null});
    if(d.blockReason) osfhEvent("article_guard_blocked_or_review",d.blockReason);
    if(d.gaveUp) osfhEvent("article_guard_gave_up",`batch ${before?.batch||0}: ${d.blockReason||""}`);
    if(d.send) await articleGuardTrySend(conversationId,d.state);
    else articleGuardSave(conversationId,d.state);
  }
  async function maybeArticleGuard() {
    if (osfhRetired||articleGuardBusy) return;
    const conversationId=conversationIdFromUrl();
    if (!conversationId||conversationId.startsWith("share-")) return;
    if(findStopButton()){articleGuardSawBusy=true;return;}
    if(articleGuardBackingOff()) return;   // 2026-10-28: 会話の記録の読みすぎで休み中は、見張り全体を待たせる（失敗の記録を3秒ごとに出さない）
    articleGuardBusy=true;
    try {
      const test=articleGuardTakeTestNow(conversationId);
      if(test) {
        const conv=await fetchConversationMetadata(conversationId);
        if(test.node&&conv?.mapping?.[test.node]) conv.current_node=test.node;
        const answer=articleGuardReadAnswer(conv);
        const anchorId=reportGuardHumanAnchor(conv);
        const d=anchorId?articleGuardDecide(null,answer,Date.now(),anchorId):{send:false};
        osfhEvent("article_guard_test",`article=${articleGuardHasArticle(answer)} items=${articleGuardChecklistItems(answer).size} send=${d.send}`);
        if(d.send) await reportGuardSend(articleGuardText(1,d.state),conversationId,anchorId);
        return;
      }
      if(articleGuardSawBusy){
        articleGuardSawBusy=false;
        await new Promise(resolve=>setTimeout(resolve,ARTICLE_GUARD_SETTLE_MS));
        if(findStopButton()){articleGuardSawBusy=true;return;}
        const conv=await fetchConversationMetadata(conversationId);
        await articleGuardEvaluate(conversationId,conv);
        return;
      }
      const state=articleGuardLoad(conversationId);
      if(!state&&!articleGuardBackingOff()&&Date.now()-articleGuardLastAuditProbe>=120000&&articleGuardDomLastAssistant()&&articleGuardDomLastAssistant()!==articleGuardLastProbeSeen){
        articleGuardLastAuditProbe=Date.now();
        articleGuardLastProbeSeen=articleGuardDomLastAssistant();
        const conv=await fetchConversationMetadata(conversationId);
        const anchorId=reportGuardHumanAnchor(conv);
        if(anchorId&&(articleGuardAnchorIsAudit(conv,anchorId)||articleGuardAnchorIsForwarded(conv,anchorId))&&articleGuardAnswerFinished(conv)&&!findStopButton()){
          osfhEvent("article_guard_audit_probe","forwarded/audit conversation without state: reading the answer");
          await articleGuardEvaluate(conversationId,conv);
          return;
        }
      }
      // 見逃した答えの後読み（20秒おき・依頼を送って答えを待っている時だけ）
      const domLast=articleGuardDomLastAssistant();
      if(state&&!state.blocked&&!state.complete&&!state.retryAt&&state.sent===1&&!articleGuardBackingOff()&&Date.now()-articleGuardLastCatchup>=ARTICLE_GUARD_CATCHUP_MS
         &&domLast&&domLast!==articleGuardLastDomSeen){
        articleGuardLastCatchup=Date.now();
        articleGuardLastDomSeen=domLast;
        let conv=null;
        try { conv=await fetchConversationMetadata(conversationId); }
        catch(err) { articleGuardLastDomSeen=""; throw err; }   // v11：読めなかった時は次の見回りでもう一度読む
        const lastMsg=conv?.mapping?.[conv?.current_node]?.message;
        if(lastMsg&&lastMsg.end_turn===false) articleGuardLastDomSeen="";   // v11：答えが書きかけの時も、書き終わった後にもう一度読む
        if(!findStopButton()&&articleGuardUnreadAnswer(conv,state)){
          osfhEvent("article_guard_catchup",`unread answer ${conv.current_node}`);
          await articleGuardEvaluate(conversationId,conv);
          return;
        }
      }
      if(state&&state.retryAt&&Date.now()>=state.retryAt){
        if(!articleGuardLock(conversationId)) return;   // v7：2タブで同じ依頼が2通出ないように
        const fresh=articleGuardLoad(conversationId);
        if(!fresh||!fresh.retryAt||Date.now()<fresh.retryAt) return;   // 別のタブが先に送った
        const anchorId=reportGuardHumanAnchor(await fetchConversationMetadata(conversationId));
        if(!state.anchorId||!anchorId||state.anchorId!==anchorId){
          articleGuardSave(conversationId,null);
          osfhEvent("article_guard_canceled","different user request / legacy state");
        } else await articleGuardTrySend(conversationId,state);
      }
    } catch(error) {articleGuardNoteError(error);osfhEvent("article_guard_error",error?.message||String(error));}
    finally {articleGuardBusy=false;}
  }
  try {if(typeof window!=="undefined") window.__osfhArticleGuard={articleGuardSplit,articleGuardHasArticle,articleGuardChecklistItems,articleGuardHasChecklist,articleGuardReadAnswer,articleGuardDecide,articleGuardText,articleGuardBatchParse,articleGuardHasBreakProblem,articleGuardBatchItems,articleGuardNewest,ARTICLE_GUARD_BATCHES,articleGuardDriveWriteText,articleGuardLooksLikeArticle,articleGuardReadAnswer,articleGuardOutsideOnly,articleGuardUnreadAnswer,articleGuardBreakDetail,articleGuardMarkdownAsHtml,articleGuardAnswerFinished,articleGuardEvidenceInSource,articleGuardAnchorIsAudit,articleGuardAnchorIsForwarded,articleGuardNormalizeRules,articleGuardBuiltinRules,articleGuardBatchesOf,articleGuardMaxTotal,articleGuardWaitList,articleGuardNotes,articleGuardBigPerSend,articleGuardHiddenWrite,articleGuardHiddenNames,articleGuardCodeBlockArticle,articleGuardResumeInstead,articleGuardLastUserText,articleGuardSandboxLinks,articleGuardLabelSame,articleGuardQuoteKey,articleGuardStructuralMeasure,articleGuardDomAuditTable,articleGuardPgOf,articleGuardLang,articleGuardTitleOf,articleGuardSimilarity,articleGuardMakeTarget,articleGuardIsTarget,articleGuardPickArticle,articleGuardWantsSwitch,articleGuardTargetLine,articleGuardUnsureRead,articleGuardLetters,articleGuardEvaluate,setRulesForTest:(set)=>{articleGuardSheetRules=articleGuardNormalizeRules(set);}};}catch(_){}
  setInterval(()=>{maybeArticleGuard().catch(()=>{});},ARTICLE_GUARD_SCAN_MS);
  // === OSFH_ARTICLE_CHECKLIST_GUARD_END ===
})();