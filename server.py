"""
OS_FOR_HUMAN API Proxy Server
port 5000 — Flask + CORS全許可 + AutoReload
"""

import os
import re
import json
import sys
import glob as glob_module
import time
import datetime
import base64
import sqlite3
import threading
from pathlib import Path

from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

# ─── パス設定 ───
BRIDGE_DIR   = Path(__file__).parent
ENV_FILE     = BRIDGE_DIR / ".env"
LOGS_DIR     = BRIDGE_DIR / "logs"
CODE_REQ_DIR    = BRIDGE_DIR / "code_requests"
CODE_RESULT_DIR = BRIDGE_DIR / "code_results"

# ─── CMD常駐デーモン生存管理 ───
daemon_last_seen = 0.0

# 起動時にディレクトリを作成
LOGS_DIR.mkdir(exist_ok=True)
CODE_REQ_DIR.mkdir(exist_ok=True)
CODE_RESULT_DIR.mkdir(exist_ok=True)

# .env のキー名マッピング（内部キー → .env変数名）
_ENV_MAP = {
    "anthropic":     "ANTHROPIC_API_KEY",
    "openai":        "OPENAI_API_KEY",
    "xai":           "XAI_API_KEY",
    "gemini":        "GEMINI_API_KEY",
    "google_search": "GOOGLE_SEARCH_API_KEY",
    "google_cx":     "GOOGLE_CX",
    "antigravity":   "ANTIGRAVITY_KEY",
}
_ENV_MAP_REV = {v: k for k, v in _ENV_MAP.items()}

def load_keys() -> dict:
    """bridge/.env を読んで内部キー辞書を返す。api_keys.json があれば自動移行。"""
    result = {k: "" for k in _ENV_MAP}
    # --- api_keys.json が残っていれば .env へ移行 ---
    old_json = BRIDGE_DIR / "api_keys.json"
    if old_json.exists() and not ENV_FILE.exists():
        try:
            old = json.loads(old_json.read_text(encoding="utf-8"))
            result.update({k: v for k, v in old.items() if k in result})
            _write_env(result)
        except Exception:
            pass
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            env_k, _, val = line.partition("=")
            val = val.strip().strip('"').strip("'")
            internal = _ENV_MAP_REV.get(env_k.strip())
            if internal:
                result[internal] = val
    return result

def _write_env(keys: dict):
    """内部キー辞書を bridge/.env に書き出す。"""
    lines = [f"{_ENV_MAP[k]}={keys.get(k, '')}" for k in _ENV_MAP]
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")

# ─── 143万行ログ検索 (SQLite FTS5) ───

_LOG_DIR = Path(r"C:\Users\user\.antigravity\00_Gravity\AI会議室実装プラン\Dan用ログフォルダ")
_GPT_LOG = _LOG_DIR / "20260322_GPT全会話ログ統合.md"
_CLAUDE_LOG = _LOG_DIR / "data-2026-03-20-13-24-51-batch-0000" / "conversations.json"
_FTS_DB = BRIDGE_DIR / "log_search.db"
_fts_ready = threading.Event()


def _build_fts_index():
    """起動時にSQLite FTS5インデックスを構築する（既存テーブルがあればスキップ）。"""
    conn = sqlite3.connect(str(_FTS_DB))
    c = conn.cursor()
    # テーブルが既に存在するか確認
    c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'")
    if c.fetchone():
        # 既存テーブルあり → レコード数確認して、あればインデックス構築スキップ
        c.execute("SELECT COUNT(*) FROM logs")
        existing = c.fetchone()[0]
        if existing > 0:
            conn.close()
            _fts_ready.set()
            print(f"  [FTS] 既存インデックス使用: {existing} レコード")
            return
    # 新規構築
    c.execute("DROP TABLE IF EXISTS logs")
    c.execute("""
        CREATE VIRTUAL TABLE logs USING fts5(
            source, topic, role, content, created_at,
            tokenize='unicode61'
        )
    """)

    count = 0

    # --- GPTログ（MDパース）---
    if _GPT_LOG.exists():
        print(f"  [FTS] GPTログ読み込み中: {_GPT_LOG.name}")
        topic = ""
        created_at = ""
        role = ""
        buf = []

        def flush():
            nonlocal count
            if role and buf:
                text = "\n".join(buf).strip()
                if text:
                    c.execute("INSERT INTO logs VALUES (?,?,?,?,?)",
                              ("gpt", topic, role, text, created_at))
                    count += 1

        for line in _GPT_LOG.open("r", encoding="utf-8", errors="replace"):
            line = line.rstrip("\n")
            if line.startswith("## ") and not line.startswith("### "):
                flush()
                topic = line[3:].strip()
                role = ""
                buf = []
            elif line.startswith("Created At:"):
                created_at = line.split(":", 1)[1].strip() if ":" in line else ""
            elif line.startswith("### [") and line.endswith("]"):
                flush()
                role = line[5:-1].strip().lower()  # USER, AI, SYSTEM
                buf = []
            elif line == "---":
                flush()
                role = ""
                buf = []
            else:
                buf.append(line)

        flush()
        print(f"  [FTS] GPTログ: {count}チャンク インデックス化完了")

    # --- Claudeログ（JSONパース）---
    claude_count = 0
    if _CLAUDE_LOG.exists():
        print(f"  [FTS] Claudeログ読み込み中: {_CLAUDE_LOG.name}")
        try:
            convos = json.loads(_CLAUDE_LOG.read_text(encoding="utf-8"))
            for convo in convos:
                topic = convo.get("name", "") or convo.get("summary", "")
                for msg in convo.get("chat_messages", []):
                    sender = msg.get("sender", "")
                    created = msg.get("created_at", "")
                    # contentの中のtextを結合
                    texts = []
                    for block in msg.get("content", []):
                        t = block.get("text", "")
                        if t:
                            texts.append(t)
                    if not texts:
                        t = msg.get("text", "")
                        if t:
                            texts.append(t)
                    if texts:
                        c.execute("INSERT INTO logs VALUES (?,?,?,?,?)",
                                  ("claude", topic, sender, "\n".join(texts), created))
                        claude_count += 1
        except Exception as e:
            print(f"  [FTS] Claudeログエラー: {e}")
        print(f"  [FTS] Claudeログ: {claude_count}メッセージ インデックス化完了")

    conn.commit()
    conn.close()
    _fts_ready.set()
    print(f"  [FTS] 全インデックス構築完了: 合計 {count + claude_count} レコード")


# バックグラウンドでインデックス構築
threading.Thread(target=_build_fts_index, daemon=True).start()


# ─── テキストサニタイズ ───
def sanitize(text):
    if not isinstance(text, str):
        return text
    text = re.sub(r'[\ud800-\udfff]', '', text)
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    return text

# ─── Flask 初期化 ───
app = Flask(__name__, static_folder=str(BRIDGE_DIR), static_url_path='/static')
CORS(app)  # file:// を含む全オリジンからのアクセスを許可


# ─── HTML配信（server.py経由でアクセス = server起動済み保証）───

@app.route("/")
def serve_index():
    """v3パイプラインHTMLを配信（localhost:5000 でアクセス）"""
    from flask import make_response
    resp = make_response(app.send_static_file("os_for_human_pipeline_v3.html"))
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp

@app.route("/v2")
def serve_v2():
    """v2パイプラインHTML"""
    return app.send_static_file("os_for_human_pipeline_v2.html")

@app.route("/v1")
def serve_v1():
    """v0.6パイプラインHTML（旧版）"""
    return app.send_static_file("os_for_human_pipeline.html")

@app.route("/api_vault.html")
def serve_vault():
    """API金庫（APIキー管理UI）"""
    return app.send_static_file("api_vault.html")

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "version": "v2", "pid": os.getpid()})

TIMEOUT    = 120
MAX_TOKENS = 8192

# ─── リトライ対象ステータスコード ───
_RETRYABLE_STATUS = {429, 529, 503}
_MAX_RETRY = 3

def _retry_post(url, *, headers=None, json=None, timeout=TIMEOUT):
    """429/529/503 をexponential backoffでリトライしてからレスポンスを返す"""
    import time as _time
    last_res = None
    for attempt in range(_MAX_RETRY):
        try:
            res = requests.post(url, headers=headers, json=json, timeout=timeout)
            if res.status_code not in _RETRYABLE_STATUS:
                return res
            last_res = res
            wait = (attempt + 1) * 15  # 15秒→30秒→45秒
            status = res.status_code
            print(f"[server] API {status} → {wait}秒待機して再試行 ({attempt+1}/{_MAX_RETRY})")
            _time.sleep(wait)
        except requests.exceptions.Timeout:
            print(f"[server] タイムアウト → 再試行 ({attempt+1}/{_MAX_RETRY})")
            _time.sleep(5)
        except Exception as e:
            print(f"[server] リクエスト例外: {e}")
            raise
    return last_res if last_res else requests.Response()


# ═══════════════════════════════════════
# ステータス
# ═══════════════════════════════════════

@app.route("/api/status", methods=["GET"])
def status():
    keys = load_keys()
    configured = [k for k, v in keys.items() if v and k not in ("google_cx", "antigravity")]
    return jsonify({
        "status": "online",
        "configured_providers": configured,
        "timestamp": datetime.datetime.now().isoformat()
    })


# ═══════════════════════════════════════
# AIプロキシ共通ヘルパー
# ═══════════════════════════════════════

def extract_prompt(data: dict):
    """system / user を data から取り出す"""
    system = sanitize(data.get("system", ""))
    user   = sanitize(data.get("user", ""))
    if not system and not user:
        for m in data.get("messages", []):
            if m.get("role") == "system": system = sanitize(m.get("content", ""))
            if m.get("role") == "user":   user   = sanitize(m.get("content", ""))
    return system, user


# ─── Claude ───

@app.route("/api/claude", methods=["POST"])
def proxy_claude():
    keys = load_keys()
    key  = keys.get("anthropic", "")
    if not key:
        return jsonify({"error": "anthropic key not configured"}), 500

    data = request.get_json(force=True, silent=True) or {}
    system, user = extract_prompt(data)
    images = data.get("images", [])
    model  = data.get("model", "claude-sonnet-4-20250514")

    if images:
        user_content = []
        for img in images:
            # data:image/png;base64,... 形式からbase64部分とmime_typeを抽出
            if img.startswith('data:'):
                parts = img.split(',', 1)
                mime_match = re.match(r'data:([^;]+);base64', parts[0])
                mime_type = mime_match.group(1) if mime_match else 'image/png'
                b64_data = parts[1] if len(parts) > 1 else img
            else:
                mime_type = 'image/png'
                b64_data = img
            user_content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": mime_type, "data": b64_data}
            })
        user_content.append({"type": "text", "text": user})
    else:
        user_content = user

    payload = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": [{"role": "user", "content": user_content}]
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
    }
    try:
        res = _retry_post(
            "https://api.anthropic.com/v1/messages",
            headers=headers, json=payload, timeout=TIMEOUT
        )
        return jsonify(res.json()), res.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 502


# ─── GPT ───

def _openai_compatible(url, model, system, user, key, images=None):
    if images:
        user_content = [{"type": "text", "text": user}]
        for img in images:
            user_content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img}"}})
    else:
        user_content = user

    payload = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user_content}
        ]
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}"
    }
    res = _retry_post(url, headers=headers, json=payload, timeout=TIMEOUT)
    return res.json(), res.status_code


@app.route("/api/gpt", methods=["POST"])
def proxy_gpt():
    keys = load_keys()
    key  = keys.get("openai", "")
    if not key:
        return jsonify({"error": "openai key not configured"}), 500
    data = request.get_json(force=True, silent=True) or {}
    system, user = extract_prompt(data)
    body, status = _openai_compatible(
        "https://api.openai.com/v1/chat/completions",
        data.get("model", "gpt-4o"),
        system, user, key,
        images=data.get("images", [])
    )
    return jsonify(body), status


# ─── Grok ───

@app.route("/api/grok", methods=["POST"])
def proxy_grok():
    keys = load_keys()
    key  = keys.get("xai", "")
    if not key:
        return jsonify({"error": "xai key not configured"}), 500
    data = request.get_json(force=True, silent=True) or {}
    system, user = extract_prompt(data)
    body, status = _openai_compatible(
        "https://api.x.ai/v1/chat/completions",
        data.get("model", "grok-3-latest"),
        system, user, key
    )
    return jsonify(body), status


# ─── Gemini ───

@app.route("/api/gemini", methods=["POST"])
def proxy_gemini():
    keys = load_keys()
    key  = keys.get("gemini", "")
    if not key:
        return jsonify({"error": "gemini key not configured"}), 500
    data = request.get_json(force=True, silent=True) or {}
    system, user = extract_prompt(data)
    images = data.get("images", [])
    model  = data.get("model", "gemini-2.5-flash")

    parts = [{"text": user}]
    for img in images:
        parts.append({"inline_data": {"mime_type": "image/png", "data": img}})

    payload = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"maxOutputTokens": MAX_TOKENS}
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    try:
        res = _retry_post(url, json=payload, timeout=TIMEOUT)
        return jsonify(res.json()), res.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 502


# ═══════════════════════════════════════
# 検索
# ═══════════════════════════════════════

@app.route("/api/search", methods=["POST"])
def proxy_search():
    keys  = load_keys()
    api_k = keys.get("google_search", "")
    cx    = keys.get("google_cx", "")
    data  = request.get_json(force=True, silent=True) or {}
    query = sanitize(data.get("query") or data.get("keyword") or data.get("q", ""))

    if not api_k or not cx:
        return jsonify({"results": [], "message": "Google Search API未設定"})

    try:
        url = (
            f"https://www.googleapis.com/customsearch/v1"
            f"?key={api_k}&cx={cx}&q={requests.utils.quote(query)}&num={data.get('num', 5)}"
        )
        res = requests.get(url, timeout=30)
        items = res.json().get("items", [])
        results = [{"title": i.get("title"), "link": i.get("link"), "snippet": i.get("snippet")} for i in items]
        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"error": str(e), "results": []}), 500


@app.route("/api/graviti/search", methods=["POST"])
def graviti_search():
    """Antigravity連携は未実装 — フォールバックを返す"""
    return jsonify({
        "status": "skip",
        "results": [],
        "message": "Antigravity未実装 — フォールバック検索をお使いください",
        "wait_time": 0
    })


# ═══════════════════════════════════════
# ログ保存 / 検索
# ═══════════════════════════════════════

@app.route("/api/logs/save", methods=["POST"])
def save_log():
    data    = request.get_json(force=True, silent=True) or {}
    case_id = data.get("caseId", f"CASE-{int(time.time())}")
    ts      = data.get("timestamp", datetime.datetime.now().isoformat())
    ts_safe = ts.replace(":", "-").replace("T", "_")[:19]
    filepath = LOGS_DIR / f"{case_id}_{ts_safe}.json"
    try:
        filepath.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return jsonify({"status": "saved", "file": filepath.name})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/logs/search", methods=["POST"])
def search_logs():
    data     = request.get_json(force=True, silent=True) or {}
    query    = data.get("query", "")
    limit    = int(data.get("limit", 10))
    keywords = [k.strip().lower() for k in query.split() if k.strip()]

    if not keywords:
        return jsonify({"results": []})

    results = []
    files   = sorted(LOGS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for filepath in files:
        try:
            log  = json.loads(filepath.read_text(encoding="utf-8"))
            text = (log.get("input", "") + " " + (log.get("draft", "") or "")).lower()
            if any(kw in text for kw in keywords):
                results.append({
                    "input":       log.get("input", ""),
                    "draft":       (log.get("draft", "") or "")[:500],
                    "facts":       log.get("facts", []),
                    "timestamp":   log.get("timestamp", ""),
                    "finalStatus": log.get("finalStatus", "")
                })
                if len(results) >= limit:
                    break
        except Exception:
            continue

    return jsonify({"results": results})


# ═══════════════════════════════════════
# 過去ログ全文検索 (143万行 GPT + Claude)
# ═══════════════════════════════════════

@app.route("/api/search/logs", methods=["GET", "POST"])
def search_past_logs():
    """FTS5で過去ログ（GPT全会話+Claudeエクスポート）をキーワード検索する。"""
    if not _fts_ready.is_set():
        return jsonify({"error": "インデックス構築中です。しばらくお待ちください。", "ready": False}), 503

    if request.method == "GET":
        q = request.args.get("q", "")
        limit = int(request.args.get("limit", 5))
        source_filter = request.args.get("source", "")
    else:
        data = request.get_json(force=True, silent=True) or {}
        q = data.get("q", "") or data.get("query", "")
        limit = int(data.get("limit", 5))
        source_filter = data.get("source", "")

    q = sanitize(q).strip()
    if not q:
        return jsonify({"results": [], "total": 0})

    # FTS5クエリ: クライアントがOR/ANDを含む場合はそのまま使う、そうでなければANDに変換
    if ' OR ' in q or ' AND ' in q or '*' in q:
        # クライアントが構築済みのFTS5クエリ（OR検索やワイルドカード含む）
        fts_query = q
    else:
        tokens = [t.strip() for t in q.split() if t.strip()]
        fts_query = " AND ".join(f'"{t}"' for t in tokens)

    try:
        conn = sqlite3.connect(str(_FTS_DB))
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        if source_filter:
            c.execute("""
                SELECT source, topic, role, snippet(logs, 3, '>>>','<<<', '...', 60) as snippet,
                       created_at, rank
                FROM logs
                WHERE logs MATCH ? AND source = ?
                ORDER BY rank
                LIMIT ?
            """, (fts_query, source_filter, limit))
        else:
            c.execute("""
                SELECT source, topic, role, snippet(logs, 3, '>>>','<<<', '...', 60) as snippet,
                       created_at, rank
                FROM logs
                WHERE logs MATCH ?
                ORDER BY rank
                LIMIT ?
            """, (fts_query, limit))

        rows = c.fetchall()
        results = []
        for r in rows:
            results.append({
                "source": r["source"],
                "topic": r["topic"],
                "role": r["role"],
                "snippet": r["snippet"],
                "created_at": r["created_at"],
            })

        # hq_logs（本部ログ）も検索して統合
        try:
            c.execute("""
                SELECT 'hq' as source, '' as topic, '' as role,
                       snippet(hq_logs, 2, '>>>','<<<', '...', 80) as snippet,
                       '' as created_at, rank
                FROM hq_logs
                WHERE hq_logs MATCH ?
                ORDER BY rank
                LIMIT ?
            """, (fts_query, limit))
            for r in c.fetchall():
                results.append({
                    "source": "hq", "topic": "", "role": "",
                    "snippet": r["snippet"], "created_at": "",
                })
        except Exception:
            pass  # hq_logsテーブルが無い場合はスキップ

        # 総ヒット数（両テーブル合計）
        total = 0
        try:
            if source_filter:
                c.execute("SELECT count(*) FROM logs WHERE logs MATCH ? AND source = ?",
                          (fts_query, source_filter))
            else:
                c.execute("SELECT count(*) FROM logs WHERE logs MATCH ?", (fts_query,))
            total += c.fetchone()[0]
        except Exception:
            pass
        try:
            c.execute("SELECT count(*) FROM hq_logs WHERE hq_logs MATCH ?", (fts_query,))
            total += c.fetchone()[0]
        except Exception:
            pass

        conn.close()
        return jsonify({"results": results, "total": total, "query": q})
    except Exception as e:
        return jsonify({"error": str(e), "results": [], "total": 0}), 500


# ─── 根拠付きログ検索API（検索→抽出→根拠付き要約）───

@app.route("/api/evidence/search", methods=["POST"])
def evidence_search():
    """案件に関連するログを検索し、根拠付きで返す。
    要約APIの前段として使う: まず候補ログを検索→関連度で抽出→根拠IDと共に返す。
    """
    if not _fts_ready.is_set():
        return jsonify({"evidence": [], "evidenceQuality": "unavailable", "message": "ログインデックス構築中"})

    data = request.get_json(force=True, silent=True) or {}
    user_input = sanitize(data.get("userInput", ""))
    context_type = data.get("contextType", "general")  # progress/failure/code_fix/general
    limit = min(int(data.get("limit", 8)), 20)

    if not user_input:
        return jsonify({"evidence": [], "evidenceQuality": "no_input"})

    import re as _re

    # STEP 1: キーワード抽出（日本語+英語）
    en_keywords = _re.findall(r'[a-zA-Z_][a-zA-Z0-9_]{2,}', user_input)
    jp_keywords = _re.findall(r'[\u3040-\u9fff]{2,}', user_input)
    all_keywords = list(dict.fromkeys(en_keywords + jp_keywords))[:10]

    # context_typeに応じた追加キーワード
    if context_type == "progress":
        all_keywords += ["成功", "失敗", "完了", "修正", "daemon"]
    elif context_type == "failure":
        all_keywords += ["エラー", "失敗", "原因", "429", "タイムアウト"]
    elif context_type == "code_fix":
        all_keywords += ["修正", "code_fix", "daemon", "old_string"]

    # STEP 2: FTS5検索（OR検索で広めに取る）
    evidence = []
    try:
        conn = sqlite3.connect(str(_FTS_DB))
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        # キーワードをOR結合でFTS5検索
        if all_keywords:
            fts_query = " OR ".join(f'"{k}"' for k in all_keywords[:8])
        else:
            fts_query = f'"{user_input[:50]}"'

        # logsテーブル検索（hq優先→v3_session→一般会話の順）
        source_priority = {"hq": 0, "v3_session": 1, "v2_diagnosis": 2}
        all_rows = []

        for table, source_col in [("logs", True), ("hq_logs", False)]:
            try:
                if source_col:
                    c.execute(f"""
                        SELECT source, topic, role,
                               snippet({table}, 3, '>>>','<<<', '...', 80) as snippet,
                               created_at, rank
                        FROM {table}
                        WHERE {table} MATCH ?
                        ORDER BY rank
                        LIMIT ?
                    """, (fts_query, limit * 3))
                else:
                    c.execute(f"""
                        SELECT 'hq' as source, '' as topic, '' as role,
                               snippet({table}, 2, '>>>','<<<', '...', 80) as snippet,
                               '' as created_at, rank
                        FROM {table}
                        WHERE {table} MATCH ?
                        ORDER BY rank
                        LIMIT ?
                    """, (fts_query, limit * 2))
                all_rows.extend(c.fetchall())
            except Exception:
                pass

        conn.close()

        # STEP 3: 関連度でソート（hq優先、キーワード一致数で重み付け）
        scored = []
        for r in all_rows:
            source = r["source"] if "source" in r.keys() else "unknown"
            snippet = r["snippet"] if "snippet" in r.keys() else ""
            # スコア計算: ソース優先度 + キーワード一致数
            priority = source_priority.get(source, 5)
            kw_hits = sum(1 for k in all_keywords if k.lower() in snippet.lower())
            score = kw_hits * 10 - priority
            scored.append((score, {
                "source": source,
                "topic": r["topic"] if "topic" in r.keys() else "",
                "snippet": snippet[:200],
                "created_at": r["created_at"] if "created_at" in r.keys() else "",
                "relevance": "high" if kw_hits >= 3 else "medium" if kw_hits >= 1 else "low",
            }))

        # 上位N件を抽出
        scored.sort(key=lambda x: -x[0])
        evidence = [s[1] for s in scored[:limit]]

        # ノイズ除去: 一般会話ログでキーワード一致が弱いものは除外
        evidence = [e for e in evidence if e["relevance"] != "low" or e["source"] == "hq"]

    except Exception as e:
        return jsonify({"evidence": [], "evidenceQuality": "error", "message": str(e)})

    # STEP 4: 根拠品質の判定
    high_count = sum(1 for e in evidence if e["relevance"] == "high")
    if high_count >= 3:
        quality = "strong"
        quality_msg = f"強い根拠あり（高関連{high_count}件）"
    elif high_count >= 1 or len(evidence) >= 3:
        quality = "moderate"
        quality_msg = f"中程度の根拠（高関連{high_count}件、全{len(evidence)}件）"
    elif len(evidence) > 0:
        quality = "weak"
        quality_msg = f"根拠が弱い（低関連のみ{len(evidence)}件）。推測回答になる可能性あり"
    else:
        quality = "none"
        quality_msg = "関連ログなし。根拠なしの回答になる"

    # code_results（daemon修正結果）も検索
    fix_evidence = []
    try:
        results_dir = BRIDGE_DIR / "code_results"
        result_files = sorted(results_dir.glob("*_result.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for rf in result_files[:10]:
            try:
                rd = json.loads(rf.read_text(encoding="utf-8"))
                target = rd.get("targetFile", "")
                audit_reason = rd.get("audit", {}).get("reason", "")
                summary_text = f"{target} {audit_reason}"
                if any(k.lower() in summary_text.lower() for k in all_keywords[:5]):
                    fix_evidence.append({
                        "requestId": rd.get("requestId", rf.stem),
                        "success": rd.get("success", False),
                        "target": target,
                        "reason": audit_reason[:100],
                        "completedAt": rd.get("completedAt", ""),
                    })
            except Exception:
                pass
    except Exception:
        pass

    return jsonify({
        "evidence": evidence[:limit],
        "fixEvidence": fix_evidence[:5],
        "evidenceQuality": quality,
        "evidenceMessage": quality_msg,
        "keywords": all_keywords[:8],
        "total": len(evidence),
    })


# ─── FTS5追記API（v2 HTML/daemon/セッションログから随時追記）───

@app.route("/api/logs/append", methods=["POST"])
def append_log_to_fts():
    """FTS5インデックスにログを追記する。v2 chatやdaemonから呼ばれる。"""
    if not _fts_ready.is_set():
        return jsonify({"error": "インデックス構築中"}), 503

    data = request.get_json(force=True, silent=True) or {}
    source = sanitize(data.get("source", "v2_chat"))
    topic = sanitize(data.get("topic", ""))
    role = sanitize(data.get("role", ""))
    content = sanitize(data.get("content", ""))
    created_at = sanitize(data.get("created_at", datetime.datetime.now().isoformat()))

    if not content:
        return jsonify({"error": "content required"}), 400

    try:
        conn = sqlite3.connect(str(_FTS_DB))
        c = conn.cursor()
        c.execute("INSERT INTO logs VALUES (?,?,?,?,?)",
                  (source, topic, role, content, created_at))
        conn.commit()
        conn.close()
        return jsonify({"status": "ok", "source": source})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/logs/append-batch", methods=["POST"])
def append_logs_batch():
    """複数ログを一括追記。"""
    if not _fts_ready.is_set():
        return jsonify({"error": "インデックス構築中"}), 503

    data = request.get_json(force=True, silent=True) or {}
    entries = data.get("entries", [])
    if not entries:
        return jsonify({"error": "entries required"}), 400

    try:
        conn = sqlite3.connect(str(_FTS_DB))
        c = conn.cursor()
        count = 0
        for e in entries:
            content = sanitize(e.get("content", ""))
            if not content:
                continue
            c.execute("INSERT INTO logs VALUES (?,?,?,?,?)", (
                sanitize(e.get("source", "v2_chat")),
                sanitize(e.get("topic", "")),
                sanitize(e.get("role", "")),
                content,
                sanitize(e.get("created_at", datetime.datetime.now().isoformat())),
            ))
            count += 1
        conn.commit()
        conn.close()
        return jsonify({"status": "ok", "inserted": count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════
# Claude Code 修正依頼
# ═══════════════════════════════════════

# ═══════════════════════════════════════
# 簡易コード実行エンジン（CLI不要で行削除・関数削除を直接実行）
# ═══════════════════════════════════════

def _simple_execute(instruction: str, target_file: str, dry_run: bool = False) -> dict:
    """指示書をパースして簡単な編集操作を直接実行する。
    対応: 行削除、関数削除、ブロック削除（コメント間）
    戻り値: {"status": "done"/"unsupported", "summary": str, "changes": list}
    """
    target = Path(target_file)
    if not target.exists():
        return {"status": "error", "summary": f"ファイルが見つかりません: {target_file}", "changes": []}

    content = target.read_text(encoding="utf-8")
    lines = content.split("\n")
    changes = []
    original_len = len(lines)

    # 指示書から操作を抽出
    ops = re.findall(r'\d+\.\s*(.+)', instruction)
    if not ops:
        return {"status": "unsupported", "summary": "操作を解析できませんでした", "changes": []}

    for op in ops:
        op = op.strip()

        # パターン2を先にチェック: 「function XXX() を探して関数全体を削除」
        # （パターン1が先だとfunction行だけ消えて中身が残るため）
        search_delete_func = re.search(r'[`「](function\s+(\w+)\s*\([^)]*\))[`」]?\s*.*(?:関数.*削除|全体.*削除|削除)', op)
        if search_delete_func:
            func_sig = search_delete_func.group(1).strip()
            func_name = search_delete_func.group(2)
            new_lines = []
            i = 0
            deleted = False
            while i < len(lines):
                if func_sig in lines[i] or (f"function {func_name}" in lines[i] and "{" in lines[i]):
                    # ブレース対応で関数末尾を探す
                    depth = 0
                    start_i = i
                    while i < len(lines):
                        depth += lines[i].count("{") - lines[i].count("}")
                        i += 1
                        if depth <= 0:
                            break
                    changes.append(f"関数削除: {func_name}() ({i - start_i}行)")
                    deleted = True
                else:
                    new_lines.append(lines[i])
                    i += 1
            if deleted:
                lines = new_lines
            continue

        # パターン1: 「〇〇を探してその行を削除」
        search_delete_line = re.search(r'[`「]([^`」]+)[`」]\s*を探して.*(行.*削除|削除.*行|該当行.*削除)', op)
        if search_delete_line:
            needle = search_delete_line.group(1).strip()
            new_lines = []
            deleted = 0
            for line in lines:
                if needle in line:
                    # function定義行は関数削除に任せる（中身が残らないように）
                    stripped = line.strip()
                    if re.match(r'(async\s+)?function\s+\w+\s*\(', stripped):
                        new_lines.append(line)  # 消さずに残す
                    else:
                        changes.append(f"行削除: {stripped[:80]}")
                        deleted += 1
                else:
                    new_lines.append(line)
            if deleted > 0:
                lines = new_lines
            continue

        # パターン3: 「<!-- コメント --> から <!-- /コメント --> まで削除」
        search_delete_block = re.search(r'[`「](<!--\s*(.+?)\s*-->)[`」]?\s*.*(?:から|を探して).*(?:まで.*削除|削除)', op)
        if search_delete_block:
            start_comment = search_delete_block.group(1).strip()
            block_name = search_delete_block.group(2).strip()
            end_pattern = f"<!-- /{block_name}" if not block_name.startswith("/") else f"<!-- {block_name}"
            new_lines = []
            i = 0
            deleted = False
            while i < len(lines):
                if start_comment in lines[i] or (f"<!-- {block_name}" in lines[i]):
                    start_i = i
                    while i < len(lines):
                        if end_pattern in lines[i] or (i > start_i and f"/{block_name}" in lines[i]):
                            i += 1
                            break
                        i += 1
                    changes.append(f"ブロック削除: {block_name} ({i - start_i}行)")
                    deleted = True
                else:
                    new_lines.append(lines[i])
                    i += 1
            if deleted:
                lines = new_lines
            continue

        # パターン4: 「<div id="xxx" を探してモーダル全体を削除」
        search_delete_element = re.search(r'[`「](<\w+[^`」]*(?:id|class)=["\']([^"\']+)["\'][^`」]*>)[`」]?\s*.*(?:モーダル|要素).*削除', op)
        if search_delete_element:
            tag_snippet = search_delete_element.group(1).strip()
            element_id = search_delete_element.group(2)
            new_lines = []
            i = 0
            deleted = False
            while i < len(lines):
                if tag_snippet in lines[i] or (element_id in lines[i] and "<" in lines[i]):
                    # 閉じタグまでスキップ（depth tracking）
                    tag_match = re.match(r'<(\w+)', tag_snippet)
                    tag_name = tag_match.group(1) if tag_match else "div"
                    depth = 0
                    start_i = i
                    while i < len(lines):
                        depth += len(re.findall(f'<{tag_name}[\\s>]', lines[i]))
                        depth -= len(re.findall(f'</{tag_name}>', lines[i]))
                        i += 1
                        if depth <= 0:
                            break
                    changes.append(f"要素削除: {element_id} ({i - start_i}行)")
                    deleted = True
                else:
                    new_lines.append(lines[i])
                    i += 1
            if deleted:
                lines = new_lines
            continue

    if not changes:
        return {"status": "unsupported", "summary": "対応可能な操作が見つかりませんでした", "changes": []}

    if dry_run:
        return {
            "status": "dry_run",
            "summary": f"簡易エンジン（dry_run）: {len(changes)}件の変更予定 ({original_len}行→{len(lines)}行)\n" + "\n".join(changes),
            "changes": changes,
        }

    # ファイルに書き戻し
    new_content = "\n".join(lines)
    target.write_text(new_content, encoding="utf-8")

    return {
        "status": "done",
        "summary": f"簡易エンジンで実行完了: {len(changes)}件の変更 ({original_len}行→{len(lines)}行)\n" + "\n".join(changes),
        "changes": changes,
        "engine": "simple",
    }


BACKUP_DIR = BRIDGE_DIR / "backups"
BACKUP_DIR.mkdir(exist_ok=True)


@app.route("/api/code/execute", methods=["POST"])
def simple_execute():
    """簡易実行エンジン: 指示書の内容を直接実行する（CLI不要）
    ※ dry_run=true で実行せずに変更内容だけ返す（デフォルト: false）
    ※ dry_run=false の場合、実行前にバックアップを自動取得
    """
    data = request.get_json(force=True, silent=True) or {}
    instruction = sanitize(data.get("instruction", ""))
    target_file = sanitize(data.get("targetFile", DEFAULT_TARGET_FILE))
    request_id = sanitize(data.get("requestId", ""))
    dry_run = data.get("dry_run", False)

    if not instruction:
        return jsonify({"error": "instruction is required"}), 400

    try:
        # dry_run=false の場合、実行前にバックアップ取得
        if not dry_run and request_id:
            target = Path(target_file)
            if target.exists():
                fname = target.name
                bak_path = BACKUP_DIR / f"{request_id}_{fname}.bak"
                bak_path.write_bytes(target.read_bytes())

        result = _simple_execute(instruction, target_file, dry_run=dry_run)

        # 結果をcode_resultsにも保存（D3ポーリング互換）
        if request_id and result["status"] == "done":
            result_path = CODE_RESULTS_DIR / f"{request_id}.json"
            result_path.write_text(json.dumps({
                "requestId": request_id,
                "status": result["status"],
                "summary": result["summary"],
                "completedAt": datetime.datetime.now().isoformat(),
                "engine": "simple",
                "targetFile": target_file,
            }, ensure_ascii=False, indent=2), encoding="utf-8")

        return jsonify(result)
    except Exception as e:
        return jsonify({"status": "error", "summary": str(e), "changes": []}), 500


@app.route("/api/code/rollback", methods=["POST"])
def rollback_execute():
    """簡易エンジンの実行結果をロールバック（バックアップから復元）"""
    data = request.get_json(force=True, silent=True) or {}
    request_id = sanitize(data.get("requestId", ""))

    if not request_id:
        return jsonify({"error": "requestId is required"}), 400

    # バックアップファイルを探す
    bak_files = sorted(BACKUP_DIR.glob(f"{request_id}_*"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not bak_files:
        return jsonify({"error": f"バックアップが見つかりません: {request_id}", "status": "not_found"}), 404

    try:
        bak_path = bak_files[0]
        # バックアップファイル名から元のファイル名を復元: {requestId}_{filename}.bak
        orig_name = bak_path.name.replace(f"{request_id}_", "", 1).replace(".bak", "")
        # 元のファイルパスを特定（code_resultsのJSONからtargetFileを取得）
        target_file = None
        result_files = sorted(CODE_RESULTS_DIR.glob(f"*{request_id}*"), key=lambda p: p.stat().st_mtime, reverse=True)
        for rf in result_files:
            try:
                rd = json.loads(rf.read_text(encoding="utf-8"))
                if "targetFile" in rd:
                    target_file = rd["targetFile"]
                    break
            except Exception:
                pass
        # フォールバック: bridge/内の同名ファイル
        if not target_file:
            target_file = str(BRIDGE_DIR / orig_name)

        target = Path(target_file)
        target.write_bytes(bak_path.read_bytes())

        return jsonify({
            "status": "rolled_back",
            "message": f"復元完了: {target_file}",
            "backup": bak_path.name,
        })
    except Exception as e:
        return jsonify({"error": str(e), "status": "error"}), 500


CODE_INPUT_PATH  = BRIDGE_DIR / "CODE_INPUT.txt"
CODE_OUTPUT_PATH = BRIDGE_DIR / "CODE_OUTPUT.txt"
CODE_RESULTS_DIR = BRIDGE_DIR / "code_results"
CODE_RESULTS_DIR.mkdir(exist_ok=True)

DEFAULT_TARGET_FILE = str(BRIDGE_DIR / "os_for_human_pipeline_v3.html")

# ─── 管理型実行API（リトライ・進捗をserver側で管理、HTML軽量化用）───
_managed_jobs = {}  # jobId -> {status, requestId, retries, maxRetries, progressMessage, ...}

@app.route("/api/code/managed-execute", methods=["POST"])
def managed_execute():
    """修正依頼を受け付け、リトライ含めてserver側で管理する"""
    data = request.get_json(force=True, silent=True) or {}
    instruction = sanitize(data.get("instruction", ""))
    target_file = sanitize(data.get("targetFile", DEFAULT_TARGET_FILE))
    model = sanitize(data.get("model", "sonnet"))
    max_retries = min(int(data.get("maxRetries", 2)), 3)

    if not instruction:
        return jsonify({"error": "instruction is required"}), 400

    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    job_id = f"JOB-{ts}"
    request_id = f"FIX-{ts}"

    try:
        # 対象ファイルのmtime記録
        target_mtime = 0.0
        try:
            if os.path.exists(target_file):
                target_mtime = os.path.getmtime(target_file)
        except Exception:
            pass

        # code_requests/にファイル生成（daemonがポーリング）
        dest = CODE_REQ_DIR / f"{ts}_{request_id}_request.md"
        dest.write_text(
            f"# Code Request {ts}\nrequestId: {request_id}\ntargetFile: {target_file}\nmtime: {target_mtime}\n\n{instruction}\n",
            encoding="utf-8"
        )
        meta_file = CODE_REQ_DIR / f"{request_id}_meta.json"
        meta_file.write_text(json.dumps({
            "requestId": request_id,
            "targetFile": target_file,
            "targetMtime": target_mtime,
            "hasImages": False,
            "model": model,
            "requestedAt": datetime.datetime.now().isoformat(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        # 管理テーブルに登録
        _managed_jobs[job_id] = {
            "status": "queued",
            "requestId": request_id,
            "targetFile": target_file,
            "instruction": instruction[:500],
            "model": model,
            "retries": 0,
            "maxRetries": max_retries,
            "progressMessage": "修正リクエスト送信済み。daemonが処理中...",
            "success": None,
            "failureSummary": None,
            "createdAt": datetime.datetime.now().isoformat(),
        }

        # バックグラウンドで結果監視スレッド起動
        def _monitor_job(jid, rid, tgt, inst, mdl, max_r):
            """ジョブ完了を監視し、失敗時はリトライする"""
            import time as _time
            for attempt in range(max_r + 1):
                _managed_jobs[jid]["status"] = "running"
                _managed_jobs[jid]["progressMessage"] = f"修正中...（{attempt+1}回目）" if attempt > 0 else "修正中..."

                # ポーリング（最大180秒）
                current_rid = _managed_jobs[jid]["requestId"]
                result = None
                for wait_s in range(0, 180, 5):
                    _time.sleep(5)
                    elapsed = wait_s + 5
                    _managed_jobs[jid]["progressMessage"] = f"修正中...（{elapsed}秒経過）"
                    # 結果ファイルチェック
                    for pattern in [f"{current_rid}_result.json", f"{current_rid}.json"]:
                        rpath = CODE_RESULTS_DIR / pattern
                        if rpath.exists():
                            try:
                                result = json.loads(rpath.read_text(encoding="utf-8"))
                                break
                            except Exception:
                                pass
                    if not result:
                        matches = sorted(CODE_RESULTS_DIR.glob(f"*{current_rid}*_result.json"),
                                         key=lambda p: p.stat().st_mtime, reverse=True)
                        if matches:
                            try:
                                result = json.loads(matches[0].read_text(encoding="utf-8"))
                            except Exception:
                                pass
                    if result:
                        break

                if result:
                    is_success = result.get("success", False)
                    audit = result.get("audit", {})
                    passed = audit.get("passed", False)
                    if is_success and passed:
                        _managed_jobs[jid]["status"] = "done"
                        _managed_jobs[jid]["success"] = True
                        _managed_jobs[jid]["progressMessage"] = "修正完了"
                        return
                    else:
                        # 失敗 → リトライ可能か判断
                        reason = audit.get("reason", result.get("error", "不明"))
                        _managed_jobs[jid]["retries"] = attempt + 1
                        if attempt < max_r:
                            # リトライ: 新しいrequestIdでリクエスト再送
                            _managed_jobs[jid]["progressMessage"] = f"失敗({reason[:40]})→ 戦略変更して再試行中..."
                            retry_ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                            retry_rid = f"FIX-{retry_ts}"
                            retry_model = "opus" if attempt == 0 else mdl
                            retry_inst = inst + f"\n\n【前回失敗: {reason[:200]}】\n前回と同じやり方は禁止。別の方法で修正しろ。"
                            retry_dest = CODE_REQ_DIR / f"{retry_ts}_{retry_rid}_request.md"
                            retry_dest.write_text(
                                f"# Code Request {retry_ts} (retry {attempt+1})\nrequestId: {retry_rid}\ntargetFile: {tgt}\n\n{retry_inst}\n",
                                encoding="utf-8"
                            )
                            retry_meta = CODE_REQ_DIR / f"{retry_rid}_meta.json"
                            retry_meta.write_text(json.dumps({
                                "requestId": retry_rid, "targetFile": tgt,
                                "targetMtime": 0.0, "hasImages": False,
                                "model": retry_model,
                                "requestedAt": datetime.datetime.now().isoformat(),
                            }, ensure_ascii=False, indent=2), encoding="utf-8")
                            _managed_jobs[jid]["requestId"] = retry_rid
                            continue
                        else:
                            _managed_jobs[jid]["status"] = "done"
                            _managed_jobs[jid]["success"] = False
                            _managed_jobs[jid]["failureSummary"] = reason[:200]
                            _managed_jobs[jid]["progressMessage"] = f"修正失敗: {reason[:60]}"
                            return
                else:
                    # タイムアウト
                    if attempt < max_r:
                        _managed_jobs[jid]["progressMessage"] = "タイムアウト → 再試行中..."
                        continue
                    else:
                        _managed_jobs[jid]["status"] = "done"
                        _managed_jobs[jid]["success"] = False
                        _managed_jobs[jid]["failureSummary"] = "タイムアウト（全リトライ失敗）"
                        _managed_jobs[jid]["progressMessage"] = "タイムアウトで失敗"
                        return

        t = threading.Thread(target=_monitor_job, args=(job_id, request_id, target_file, instruction, model, max_retries), daemon=True)
        t.start()

        return jsonify({"jobId": job_id, "requestId": request_id, "status": "queued"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/code/managed-status/<job_id>", methods=["GET"])
def managed_status(job_id):
    """管理型ジョブの進捗を返す（HTML向け軽量レスポンス）"""
    job_id = re.sub(r'[^A-Za-z0-9_\-]', '', job_id)
    job = _managed_jobs.get(job_id)
    if not job:
        return jsonify({"error": "job not found"}), 404
    return jsonify({
        "status": job["status"],
        "progressMessage": job["progressMessage"],
        "success": job["success"],
        "failureSummary": job["failureSummary"],
        "retries": job["retries"],
    })


@app.route("/api/code/request", methods=["POST"])
def code_request():
    data        = request.get_json(force=True, silent=True) or {}
    instruction = sanitize(data.get("instruction", ""))
    request_id  = sanitize(data.get("requestId", ""))
    target_file = sanitize(data.get("targetFile", DEFAULT_TARGET_FILE))
    model       = sanitize(data.get("model", "sonnet"))  # sonnet or opus

    if not instruction:
        return jsonify({"error": "instruction is required"}), 400
    try:
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        if not request_id:
            request_id = f"REQ-{ts}"

        # 対象ファイルのmtimeを記録（変更検知の基準）
        target_mtime = 0.0
        try:
            if os.path.exists(target_file):
                target_mtime = os.path.getmtime(target_file)
        except Exception:
            pass

        # 旧CLIフロー無効化（v2ではcmd_daemonがcode_requests/をポーリングする）
        # CODE_OUTPUT_PATH.write_text("", encoding="utf-8")
        # CODE_INPUT_PATH.write_text(f"[requestId:{request_id}]\n{instruction}", encoding="utf-8")

        # md として保存（人間可読）
        dest = CODE_REQ_DIR / f"{ts}_{request_id}_request.md"
        dest.write_text(
            f"# Code Request {ts}\nrequestId: {request_id}\ntargetFile: {target_file}\nmtime: {target_mtime}\n\n{instruction}\n",
            encoding="utf-8"
        )

        # 画像がある場合は別ファイルに保存
        images = data.get("images", [])
        if images:
            img_file = CODE_REQ_DIR / f"{request_id}_images.json"
            img_file.write_text(json.dumps(images, ensure_ascii=False), encoding="utf-8")

        # watch用メタJSONを上書き保存（リトライ時も同じrequestIdで上書き）
        meta_file = CODE_REQ_DIR / f"{request_id}_meta.json"
        meta_file.write_text(json.dumps({
            "requestId":   request_id,
            "targetFile":  target_file,
            "targetMtime": target_mtime,
            "hasImages":   len(images) > 0,
            "model":       model,
            "requestedAt": datetime.datetime.now().isoformat(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        return jsonify({"status": "ok", "requestId": request_id, "message": "指示を送信しました"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── ファイル編集API（v2 HTML自己修正用）───

@app.route("/api/file/read", methods=["POST"])
def file_read():
    """bridgeディレクトリ内のファイルを読む"""
    data = request.get_json(force=True, silent=True) or {}
    filename = sanitize(data.get("filename", ""))
    if not filename:
        return jsonify({"error": "filename required"}), 400
    # bridgeディレクトリ外へのアクセス禁止
    target = (BRIDGE_DIR / filename).resolve()
    if not str(target).startswith(str(BRIDGE_DIR.resolve())):
        return jsonify({"error": "access denied"}), 403
    if not target.exists():
        return jsonify({"error": "file not found"}), 404
    try:
        content = target.read_text(encoding="utf-8")
        return jsonify({"status": "ok", "filename": filename, "content": content, "lines": content.count('\n') + 1})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/file/edit", methods=["POST"])
def file_edit():
    """bridgeディレクトリ内のファイルを検索置換で編集（バックアップ付き）"""
    data = request.get_json(force=True, silent=True) or {}
    filename = data.get("filename", "")
    old_string = data.get("old_string", "")
    new_string = data.get("new_string", "")
    if not filename or not old_string:
        return jsonify({"error": "filename and old_string required"}), 400
    target = (BRIDGE_DIR / filename).resolve()
    if not str(target).startswith(str(BRIDGE_DIR.resolve())):
        return jsonify({"error": "access denied"}), 403
    if not target.exists():
        return jsonify({"error": "file not found"}), 404
    try:
        content = target.read_text(encoding="utf-8")
        if old_string not in content:
            return jsonify({"error": "old_string not found in file", "status": "no_match"}), 404
        # バックアップ
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        bak = BRIDGE_DIR / "backups"
        bak.mkdir(exist_ok=True)
        (bak / f"{target.name}.{ts}.bak").write_text(content, encoding="utf-8")
        # 置換
        new_content = content.replace(old_string, new_string, 1)
        target.write_text(new_content, encoding="utf-8")
        return jsonify({
            "status": "ok",
            "filename": filename,
            "backup": f"{target.name}.{ts}.bak",
            "lines_before": content.count('\n') + 1,
            "lines_after": new_content.count('\n') + 1
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/file/mtime", methods=["GET"])
def file_mtime():
    """v2 HTMLの最終更新時刻を返す（自動リロード検知用）"""
    target = BRIDGE_DIR / "os_for_human_pipeline_v2.html"
    if target.exists():
        return jsonify({"mtime": os.path.getmtime(target)})
    return jsonify({"mtime": 0})

@app.route("/api/code/queue/clean", methods=["POST"])
def clean_code_queue():
    """code_requests/の古いリクエストを全部done/に移す"""
    try:
        moved = 0
        done_dir = CODE_REQ_DIR / "done"
        done_dir.mkdir(exist_ok=True)
        for f in CODE_REQ_DIR.iterdir():
            if f.is_file() and (f.suffix in ('.json', '.md')):
                f.rename(done_dir / f.name)
                moved += 1
        return jsonify({"status": "ok", "moved": moved})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/code/queue/count", methods=["GET"])
def code_queue_count():
    """code_requests/の未処理件数"""
    try:
        count = len([f for f in CODE_REQ_DIR.glob("*_meta.json") if f.is_file()])
        return jsonify({"count": count})
    except Exception as e:
        return jsonify({"error": str(e), "count": 0})

@app.route("/api/diagnosis-log", methods=["POST"])
def diagnosis_log():
    """構造化診断ログをserver側に保存"""
    data = request.get_json(force=True, silent=True) or {}
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = LOGS_DIR / f"diagnosis_{ts}.json"
    try:
        log_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return jsonify({"status": "ok", "file": log_file.name})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pipeline/log", methods=["POST"])
def pipeline_log():
    """パイプライン実行ログをファイルに保存（Claude Codeから参照可能にする）"""
    data = request.get_json(force=True, silent=True) or {}
    try:
        log_dir = BRIDGE_DIR / "pipeline_logs"
        log_dir.mkdir(exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        case_id = data.get("caseId", f"UNKNOWN-{ts}")
        log_file = log_dir / f"{ts}_{case_id}.json"
        log_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return jsonify({"status": "ok", "file": str(log_file)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/pipeline/log", methods=["GET"])
def pipeline_log_list():
    """パイプラインログ一覧を取得"""
    log_dir = BRIDGE_DIR / "pipeline_logs"
    if not log_dir.exists():
        return jsonify({"logs": []})
    logs = []
    for f in sorted(log_dir.glob("*.json"), reverse=True)[:20]:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            logs.append({"file": f.name, "caseId": d.get("caseId",""), "input": (d.get("input",""))[:100], "finalStatus": d.get("finalStatus",""), "timestamp": d.get("timestamp","")})
        except: pass
    return jsonify({"logs": logs})


@app.route("/api/pipeline/log/<case_id>", methods=["GET"])
def pipeline_log_detail(case_id):
    """特定のパイプラインログ詳細を取得"""
    case_id = re.sub(r'[^A-Za-z0-9_\-]', '', case_id)
    log_dir = BRIDGE_DIR / "pipeline_logs"
    for f in sorted(log_dir.glob(f"*{case_id}*.json"), reverse=True):
        try:
            return jsonify(json.loads(f.read_text(encoding="utf-8")))
        except: continue
    return jsonify({"error": "not found"}), 404


@app.route("/api/code/inspect", methods=["POST"])
def code_inspect():
    """Claude Codeに対象ファイルの関連箇所を読ませて報告させる"""
    data = request.get_json(force=True, silent=True) or {}
    request_id = sanitize(data.get("requestId", f"inspect-{int(time.time())}"))
    user_input = data.get("userInput", "")
    target_file = sanitize(data.get("targetFile", DEFAULT_TARGET_FILE))
    keywords = data.get("keywords", [])

    try:
        req = {
            "type": "inspect",
            "requestId": request_id,
            "userInput": user_input,
            "targetFile": target_file,
            "keywords": keywords,
            "status": "pending",
            "timestamp": datetime.datetime.now().isoformat(),
        }
        req_path = CODE_REQ_DIR / f"{request_id}.json"
        req_path.write_text(json.dumps(req, ensure_ascii=False, indent=2), encoding="utf-8")
        return jsonify({"status": "ok", "requestId": request_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/code/inspect/<request_id>", methods=["GET"])
def get_inspect_result(request_id):
    """inspect結果をポーリングで取得"""
    request_id = re.sub(r'[^A-Za-z0-9_\-]', '', request_id)
    result_path = CODE_RESULT_DIR / f"{request_id}.json"
    if result_path.exists():
        try:
            return jsonify(json.loads(result_path.read_text(encoding="utf-8")))
        except:
            pass
    return jsonify({"status": "pending"}), 202


@app.route("/api/code/inspect/<request_id>", methods=["POST"])
def post_inspect_result(request_id):
    """Claude Codeがinspect結果を書き戻す"""
    request_id = re.sub(r'[^A-Za-z0-9_\-]', '', request_id)
    data = request.get_json(force=True, silent=True) or {}
    data["requestId"] = request_id
    data["completedAt"] = datetime.datetime.now().isoformat()
    result_path = CODE_RESULT_DIR / f"{request_id}.json"
    result_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify({"status": "ok"})


# ─── server.py自己再起動 ───

@app.route("/api/server/restart", methods=["POST"])
def server_restart():
    """server.pyを自己再起動する（コード変更反映用）"""
    import subprocess
    try:
        # 新しいserver.pyプロセスをバックグラウンドで起動
        subprocess.Popen(
            [sys.executable, str(BRIDGE_DIR / "server.py")],
            cwd=str(BRIDGE_DIR),
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS,
            close_fds=True
        )
        # 現プロセスを終了するスケジュール
        def _shutdown():
            import time
            time.sleep(1)
            os._exit(0)
        threading.Thread(target=_shutdown, daemon=True).start()
        return jsonify({"status": "restarting"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/server/ping", methods=["GET"])
def server_ping():
    """server.pyの生存確認（ヘルスチェック用）"""
    return jsonify({"status": "ok", "pid": os.getpid()})


# ─── NGパターン配信 ───

@app.route("/api/ng-patterns", methods=["GET"])
def get_ng_patterns():
    """ng_patterns.jsonを返す（パイプラインのnodeMが参照）"""
    ng_file = BRIDGE_DIR / "ng_patterns.json"
    if ng_file.exists():
        try:
            return jsonify(json.loads(ng_file.read_text(encoding="utf-8")))
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"patterns": []})


# ─── CMD常駐デーモン管理 ───

@app.route("/api/daemon/ping", methods=["POST"])
def daemon_ping():
    """CMD常駐デーモンの生存確認（デーモン側が5秒ごとに呼ぶ）"""
    global daemon_last_seen
    daemon_last_seen = time.time()
    return jsonify({"status": "ok"})


@app.route("/api/daemon/status", methods=["GET"])
def daemon_status():
    """CMD常駐デーモンが動いているかチェック"""
    global daemon_last_seen
    alive = daemon_last_seen > 0 and (time.time() - daemon_last_seen) < 10
    return jsonify({"alive": alive, "mode": "cmd_daemon" if alive else "api_fallback"})


# ─── API復旧通知 ───
_recovery_events = []

@app.route("/api/daemon/recovery-notify", methods=["POST"])
def recovery_notify():
    """daemon復旧スレッドからのAPI復旧通知を受け取る"""
    data = request.get_json(force=True, silent=True) or {}
    event = {
        "event": data.get("event", "unknown"),
        "queued_count": data.get("queued_count", 0),
        "timestamp": data.get("timestamp", datetime.datetime.now().isoformat()),
        "received_at": datetime.datetime.now().isoformat()
    }
    _recovery_events.append(event)
    # 最新10件だけ保持
    while len(_recovery_events) > 10:
        _recovery_events.pop(0)
    print(f"[server] API復旧通知受信: {event}")
    return jsonify({"status": "ok"})


@app.route("/api/recovery/status", methods=["GET"])
def recovery_status():
    """HTMLがポーリングで復旧状況を確認するエンドポイント"""
    # failed_queue内の未処理件数を返す
    failed_queue_dir = BRIDGE_DIR / "failed_queue"
    queued_count = 0
    if failed_queue_dir.exists():
        queued_count = len(list(failed_queue_dir.glob("failed_*.json")))
    return jsonify({
        "queued_count": queued_count,
        "recent_events": _recovery_events[-5:],
        "daemon_alive": daemon_last_seen > 0 and (time.time() - daemon_last_seen) < 10
    })


# ─── API直叩きフォールバック ───

@app.route("/api/code/identify-direct", methods=["POST"])
def code_identify_direct():
    """CMD常駐が不在時、Claude APIで直接画像判定する"""
    data = request.get_json(force=True, silent=True) or {}
    images = data.get("images", [])
    user_text = data.get("userText", "")
    candidates = data.get("uiMapCandidates", [])

    keys = load_keys()
    claude_key = keys.get("anthropic", "")
    if not claude_key:
        return jsonify({"error": "Claude APIキー未設定"}), 400

    content = []
    for img in images:
        m = re.match(r"data:([^;]+);base64,(.+)", img)
        if m:
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": m.group(1), "data": m.group(2)}
            })

    content.append({"type": "text", "text": f"""以下の画像に映っているボタン/UIを特定してください。

ユーザー入力: {user_text}

候補一覧:
{json.dumps(candidates, ensure_ascii=False, indent=2)}

JSON形式で返してください:
{{"matched":true/false, "screen":"画面名", "label":"ボタン名", "func":"関数名", "lineHint":行番号, "confidence":"high/medium/low", "reason":"特定理由", "userIntent":"ユーザー意図", "suggestedAction":"推奨アクション"}}
"""})

    try:
        resp = requests.post("https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": claude_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json"
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": content}]
            },
            timeout=60
        )
    except Exception as e:
        return jsonify({"error": f"API通信エラー: {e}"}), 500

    if resp.status_code == 200:
        result_text = resp.json()["content"][0]["text"]
        try:
            m = re.search(r"\{[\s\S]*\}", result_text)
            result = json.loads(m.group(0)) if m else {"matched": False}
        except Exception:
            result = {"matched": False, "error": "パース失敗"}

        request_id = data.get("requestId", f"direct-{int(time.time())}")
        result["requestId"] = request_id
        result_path = CODE_RESULT_DIR / f"{request_id}.json"
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

        return jsonify(result)
    else:
        return jsonify({"error": f"Claude API error: {resp.status_code}"}), resp.status_code


@app.route("/api/code/inspect-direct", methods=["POST"])
def code_inspect_direct():
    """CMD常駐が不在時、Claude APIで直接コード調査する"""
    data = request.get_json(force=True, silent=True) or {}
    target_file = data.get("targetFile", "")
    keywords = data.get("keywords", [])
    user_input = data.get("userInput", "")

    file_content = ""
    try:
        with open(target_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
        snippets = []
        for kw in keywords:
            for i, line in enumerate(lines):
                if kw.lower() in line.lower():
                    start = max(0, i - 20)
                    end = min(len(lines), i + 21)
                    snippet = "".join(lines[start:end])
                    snippets.append(f"--- 行{i+1}付近 (キーワード: {kw}) ---\n{snippet}")
                    break
        file_content = "\n\n".join(snippets[:5])
    except Exception as e:
        return jsonify({"found": False, "error": str(e)})

    if not file_content:
        return jsonify({"found": False, "error": "キーワードに該当する箇所なし"})

    keys = load_keys()
    claude_key = keys.get("anthropic", "")
    if not claude_key:
        return jsonify({"error": "Claude APIキー未設定"}), 400

    try:
        resp = requests.post("https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": claude_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json"
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 2048,
                "messages": [{"role": "user", "content": f"""以下のコード断片を調査してください。

ユーザーの依頼: {user_input}

コード断片:
{file_content}

JSON形式で返してください:
{{"found":true, "locations":[{{"lineNumber":行番号, "code":"該当コード", "description":"説明"}}], "error":"エラー原因", "suggestedFix":"修正案", "relatedFunctions":["関数名"]}}
"""}]
            },
            timeout=60
        )
    except Exception as e:
        return jsonify({"error": f"API通信エラー: {e}"}), 500

    if resp.status_code == 200:
        result_text = resp.json()["content"][0]["text"]
        try:
            m = re.search(r"\{[\s\S]*\}", result_text)
            result = json.loads(m.group(0)) if m else {"found": False}
        except Exception:
            result = {"found": False, "error": "パース失敗"}

        request_id = data.get("requestId", f"inspect-direct-{int(time.time())}")
        result["requestId"] = request_id
        result_path = CODE_RESULT_DIR / f"{request_id}.json"
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

        return jsonify(result)
    else:
        return jsonify({"error": f"Claude API error: {resp.status_code}"}), resp.status_code


@app.route("/api/code/identify", methods=["POST"])
def code_identify():
    """Claude Code特定ルート: スクショ画像を保存し、identify_targetリクエストを生成"""
    data = request.get_json(force=True, silent=True) or {}
    request_id = sanitize(data.get("requestId", ""))
    user_text = data.get("userText", "")
    target_file = sanitize(data.get("targetFile", DEFAULT_TARGET_FILE))
    images_b64 = data.get("images", [])  # base64画像の配列
    source_ctx = data.get("sourceButtonContext", None)
    ui_map_candidates = data.get("uiMapCandidates", [])

    if not request_id:
        request_id = f"IDENTIFY-{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}"

    # 画像がない場合はidentify不可（空振り防止）
    if not images_b64:
        return jsonify({"error": "images is empty. identify requires at least one image.", "requestId": request_id}), 400

    try:
        # 画像をファイルに保存
        img_dir = BRIDGE_DIR / "code_images" / request_id
        img_dir.mkdir(parents=True, exist_ok=True)
        saved_paths = []
        for i, b64 in enumerate(images_b64):
            # data:image/png;base64,... のヘッダーを除去
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            img_path = img_dir / f"screenshot_{i}.png"
            img_path.write_bytes(base64.b64decode(b64))
            saved_paths.append(str(img_path))

        # identifyリクエストJSON を code_requests/ に保存（CMDデーモンがポーリングで検知する）
        req_data = {
            "type": "identify",
            "mode": "identify_target",
            "requestId": request_id,
            "userText": user_text,
            "targetFile": target_file,
            "imagePaths": saved_paths,
            "sourceButtonContext": source_ctx,
            "uiMapCandidates": ui_map_candidates,
            "status": "pending",
            "requestedAt": datetime.datetime.now().isoformat(),
        }
        req_file = CODE_REQ_DIR / f"{request_id}.json"
        req_file.write_text(json.dumps(req_data, ensure_ascii=False, indent=2), encoding="utf-8")

        return jsonify({
            "status": "ok",
            "requestId": request_id,
            "imagePaths": saved_paths,
            "identifyFile": str(req_file),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/code/identify/<request_id>", methods=["GET"])
def get_identify_result(request_id):
    """identify_targetの結果をポーリングで取得"""
    request_id = re.sub(r'[^A-Za-z0-9_\-]', '', request_id)
    # code_results/ 内の _identify_result.json を探す
    for p in sorted(CODE_RESULT_DIR.glob(f"*{request_id}*_identify_result.json"), reverse=True):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            return jsonify(data)
        except Exception:
            continue
    return jsonify({"status": "pending"}), 202


@app.route("/api/code/identify/<request_id>", methods=["POST"])
def post_identify_result(request_id):
    """Claude Codeが特定結果を書き戻すエンドポイント"""
    request_id = re.sub(r'[^A-Za-z0-9_\-]', '', request_id)
    data = request.get_json(force=True, silent=True) or {}
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    result_file = CODE_RESULT_DIR / f"{ts}_{request_id}_identify_result.json"
    data["completedAt"] = datetime.datetime.now().isoformat()
    data["requestId"] = request_id
    result_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify({"status": "ok", "file": str(result_file)})


@app.route("/api/code/watch/<request_id>", methods=["GET"])
def watch_code_request(request_id):
    """対象ファイルのmtimeを比較して変更を検知する（watchdogライブラリ不使用）"""
    request_id = re.sub(r'[^A-Za-z0-9_\-]', '', request_id)
    meta_file = CODE_REQ_DIR / f"{request_id}_meta.json"

    if not meta_file.exists():
        return jsonify({"status": "error", "message": "requestId not found"}), 404

    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        target_file    = meta.get("targetFile", "")
        original_mtime = float(meta.get("targetMtime", 0))
        requested_at   = meta.get("requestedAt", "")

        elapsed = 0
        try:
            req_time = datetime.datetime.fromisoformat(requested_at)
            elapsed  = int((datetime.datetime.now() - req_time).total_seconds())
        except Exception:
            pass

        if not target_file or not os.path.exists(target_file):
            return jsonify({"status": "error", "message": f"対象ファイルなし: {target_file}"}), 404

        current_mtime = os.path.getmtime(target_file)

        if abs(current_mtime - original_mtime) > 0.5:
            return jsonify({
                "status":      "done",
                "requestId":   request_id,
                "changed_at":  datetime.datetime.fromtimestamp(current_mtime).isoformat(),
                "elapsed":     elapsed,
                "targetFile":  target_file,
            })
        else:
            return jsonify({
                "status":     "pending",
                "requestId":  request_id,
                "elapsed":    elapsed,
                "targetFile": target_file,
            })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/code/status", methods=["GET"])
def code_status():
    try:
        content = CODE_OUTPUT_PATH.read_text(encoding="utf-8").strip()
        if not content:
            return jsonify({"status": "waiting"})
        return jsonify({"status": "done", "result": content})
    except FileNotFoundError:
        return jsonify({"status": "waiting"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/code/result", methods=["POST"])
def post_code_result():
    """Claude Codeが修正完了後に結果をPOSTする"""
    data       = request.get_json(force=True, silent=True) or {}
    request_id = sanitize(data.get("requestId", ""))
    if not request_id:
        return jsonify({"error": "requestId is required"}), 400
    try:
        ts   = datetime.datetime.now().isoformat()
        data["receivedAt"] = ts
        dest = CODE_RESULTS_DIR / f"{request_id}.json"
        dest.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        # CODE_OUTPUT.txt にも書いて既存フローとの互換を保つ
        summary = data.get("summary", "完了")
        CODE_OUTPUT_PATH.write_text(f"done: {summary}", encoding="utf-8")
        return jsonify({"status": "saved", "requestId": request_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/code/result/<request_id>", methods=["GET"])
def get_code_result(request_id):
    """パイプラインが修正結果をポーリングする"""
    request_id = re.sub(r'[^A-Za-z0-9_\-]', '', request_id)  # sanitize path
    # 完全一致 or glob検索（watch_requests.pyは {ts}_{requestId}_request.json で保存する）
    # _result.json を優先検索（cmd_daemonの監査済み結果）
    dest = CODE_RESULTS_DIR / f"{request_id}_result.json"
    if not dest.exists():
        dest = CODE_RESULTS_DIR / f"{request_id}.json"
    if not dest.exists():
        # _result.json → それ以外の順で検索
        result_matches = sorted(CODE_RESULTS_DIR.glob(f"*{request_id}*_result.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if result_matches:
            dest = result_matches[0]
        else:
            other_matches = sorted(CODE_RESULTS_DIR.glob(f"*{request_id}*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
            if other_matches:
                dest = other_matches[0]
    if not dest.exists():
        # v2ではCODE_OUTPUTフォールバック無効（旧エンジンの残骸を拾わない）
        return jsonify({"status": "pending"})
    if False:
        # 旧CODE_OUTPUT.txt フォールバック（無効化済み）
        try:
            content = CODE_OUTPUT_PATH.read_text(encoding="utf-8").strip()
            if content and content != "processing":
                return jsonify({"status": "done", "requestId": request_id,
                                "summary": content, "files_changed": []})
        except Exception:
            pass
        return jsonify({"status": "pending"})
    try:
        data = json.loads(dest.read_text(encoding="utf-8"))
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════
# daemon実行ログ集計API（HTMLのAIがClaudeCodeと同じ判断をするために必要）
# ═══════════════════════════════════════

@app.route("/api/code/stats", methods=["GET"])
def code_stats():
    """code_resultsフォルダの結果を集計して返す"""
    try:
        results = sorted(CODE_RESULTS_DIR.glob("*_result.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        total = len(results)
        success = 0
        failed = 0
        recent = []
        error_reasons = []

        for r in results[:30]:  # 直近30件を集計
            try:
                data = json.loads(r.read_text(encoding="utf-8"))
                is_success = data.get("success", False)
                audit = data.get("audit", {})
                passed = audit.get("passed", False)

                if is_success and passed:
                    success += 1
                else:
                    failed += 1
                    reason = audit.get("reason", data.get("error", "不明"))
                    if reason:
                        error_reasons.append(reason[:100])

                if len(recent) < 10:
                    recent.append({
                        "id": data.get("requestId", r.stem),
                        "success": is_success and passed,
                        "reason": audit.get("reason", "")[:80],
                        "file": data.get("targetFile", ""),
                        "time": data.get("completedAt", ""),
                    })
            except Exception:
                continue

        # エラー傾向を集計
        from collections import Counter
        error_keywords = []
        for reason in error_reasons:
            for kw in ["429", "構文", "括弧", "不必要", "MODELS", "renderSessionList", "old_string", "タイムアウト"]:
                if kw in reason:
                    error_keywords.append(kw)
        error_trend = dict(Counter(error_keywords).most_common(5))

        sample_30 = min(30, total)
        rate = round(success / sample_30 * 100, 1) if sample_30 > 0 else 0

        # daemonログの末尾も返す
        daemon_log_tail = ""
        daemon_log = Path(__file__).parent / "logs" / "daemon.log"
        if daemon_log.exists():
            try:
                lines = daemon_log.read_text(encoding="utf-8", errors="replace").splitlines()
                daemon_log_tail = "\n".join(lines[-20:])
            except Exception:
                pass

        return jsonify({
            "total": total,
            "recent30": {"success": success, "failed": failed, "rate": rate},
            "recent": recent,
            "errorTrend": error_trend,
            "daemonLogTail": daemon_log_tail,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════
# ═══════════════════════════════════════
# UI構造自動解析API（ClaudeCodeの判断基準をHTMLのAIに共有する）
# ═══════════════════════════════════════

_ui_map_cache = {"mtime": 0, "data": None}

@app.route("/api/ui-map", methods=["GET"])
def get_ui_map():
    """v3.htmlのDOM構造を自動解析し、UIパーツマップを返す。
    コード変更に連動（mtimeチェックでキャッシュ）。
    HTMLのAIがスクショを見た時に「これは何か」を正確に判断するための材料。"""
    target = Path(DEFAULT_TARGET_FILE)
    if not target.exists():
        return jsonify({"error": "target not found"}), 404

    # mtimeチェック: ファイルが変わってなければキャッシュを返す
    current_mtime = target.stat().st_mtime
    if _ui_map_cache["mtime"] == current_mtime and _ui_map_cache["data"]:
        return jsonify(_ui_map_cache["data"])

    import re as _re
    content = target.read_text(encoding="utf-8")
    lines = content.split("\n")

    # HTMLセクション（<script>の前）を抽出
    script_start = content.find("<script>")
    html_section = content[:script_start] if script_start > 0 else content[:500]

    # UI要素の自動抽出
    elements = []

    # id付き要素
    for m in _re.finditer(r'id="([^"]+)"', html_section):
        eid = m.group(1)
        # 周辺のテキストからラベルを推測
        pos = m.start()
        context_start = max(0, pos - 100)
        context = html_section[context_start:pos + 100]
        # class, placeholder, textContent等を抽出
        cls = ""
        cls_m = _re.search(r'class="([^"]*)"', context)
        if cls_m:
            cls = cls_m.group(1)
        placeholder = ""
        ph_m = _re.search(r'placeholder="([^"]*)"', context)
        if ph_m:
            placeholder = ph_m.group(1)[:50]
        elements.append({"id": eid, "class": cls[:60], "placeholder": placeholder})

    # ボタン要素
    buttons = []
    for m in _re.finditer(r'<button[^>]*>(.*?)</button>', html_section, _re.DOTALL):
        text = _re.sub(r'<[^>]+>', '', m.group(1)).strip()[:30]
        onclick = ""
        onclick_m = _re.search(r'onclick="([^"]*)"', m.group(0))
        if onclick_m:
            onclick = onclick_m.group(1)[:40]
        if text:
            buttons.append({"text": text, "onclick": onclick})

    # CSSカスタムプロパティ（色定義）
    colors = {}
    for m in _re.finditer(r'--([\w-]+)\s*:\s*([^;]+);', html_section):
        colors[m.group(1)] = m.group(2).strip()

    # レイアウト構造（主要divのclass）
    layout = []
    for m in _re.finditer(r'<div\s+class="([^"]*(?:header|sidebar|main|conference|chat|pipeline)[^"]*)"', html_section):
        layout.append(m.group(1))

    # ステータスインジケータ
    indicators = []
    for m in _re.finditer(r'id="(status[^"]*|indicator[^"]*|dot[^"]*)"', html_section, _re.IGNORECASE):
        indicators.append(m.group(1))
    # server/daemon/launcher ドット
    for m in _re.finditer(r'title="([^"]*(?:server|daemon|launcher)[^"]*)"', html_section, _re.IGNORECASE):
        indicators.append(m.group(1))

    # JS関数一覧（主要なものだけ）
    js_section = content[script_start:] if script_start > 0 else ""
    functions = _re.findall(r'(?:async\s+)?function\s+(\w+)', js_section)

    # 結果構築
    ui_map = {
        "fileLines": len(lines),
        "elements": elements[:30],
        "buttons": buttons[:15],
        "layout": layout[:10],
        "indicators": indicators[:10],
        "colors": dict(list(colors.items())[:15]),
        "functionCount": len(functions),
        "keyFunctions": [f for f in functions if f in [
            "handleMainInput", "triageInput", "continueSession", "startNewMeeting",
            "executeCodeFix", "appendMinutes", "appendChatLog", "callAI",
            "gatherCodeContext", "buildMeetingSystemPrompt", "recommendExecutionMode",
            "renderSessionList", "checkFileChange", "checkDaemonStatus",
        ]],
        "environment": "Windows 11, Chrome, localhost:5000",
        "headerDescription": "左上:タイトル / 右上:緑緑赤の丸=server/daemon/launcher生存ドット(Macのボタンではない), API代概算, API設定ボタン",
        "threeColumns": "左=ラベルツリー(セッション一覧) / 中央=AI議事録+入力欄 / 右=議題+パイプライン+chat履歴",
    }

    _ui_map_cache["mtime"] = current_mtime
    _ui_map_cache["data"] = ui_map
    return jsonify(ui_map)


# 要約API（v3 GPT判定対応 — HTMLに生データを渡さない）
# ═══════════════════════════════════════

@app.route("/api/summary/progress", methods=["POST"])
def summary_progress():
    """daemon実行状況の要約を返す（HTMLが生データを解析しなくて済む）"""
    try:
        results = sorted(CODE_RESULTS_DIR.glob("*_result.json"),
                         key=lambda p: p.stat().st_mtime, reverse=True)
        total = len(results)
        success = 0
        failed = 0
        recent = []
        error_reasons = []

        for r in results[:30]:
            try:
                data = json.loads(r.read_text(encoding="utf-8"))
                is_success = data.get("success", False)
                audit = data.get("audit", {})
                passed = audit.get("passed", False)
                if is_success and passed:
                    success += 1
                else:
                    failed += 1
                    reason = audit.get("reason", data.get("error", "不明"))
                    if reason:
                        error_reasons.append(reason[:100])
                if len(recent) < 5:
                    recent.append({
                        "id": data.get("requestId", r.stem),
                        "success": is_success and passed,
                        "file": data.get("targetFile", ""),
                        "summary": (audit.get("reason", "") or data.get("summary", ""))[:60],
                    })
            except Exception:
                continue

        from collections import Counter
        error_keywords = []
        for reason in error_reasons:
            for kw in ["429", "構文", "括弧", "不必要", "old_string", "タイムアウト", "不一致"]:
                if kw in reason:
                    error_keywords.append(kw)
        error_trend = ", ".join(f"{k}({v}件)" for k, v in Counter(error_keywords).most_common(3)) if error_keywords else ""

        sample_30 = min(30, total)
        rate = f"{round(success / sample_30 * 100, 1)}%" if sample_30 > 0 else "0%"

        # キュー状態
        pending_reqs = list(CODE_REQ_DIR.glob("*_request.md"))
        running = 0
        pending = 0
        for req in pending_reqs:
            meta_path = req.with_name(req.name.replace("_request.md", "_meta.json"))
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    if meta.get("status") == "processing":
                        running += 1
                    else:
                        pending += 1
                except Exception:
                    pending += 1
            else:
                pending += 1

        return jsonify({
            "success_rate": rate,
            "recent": recent,
            "error_trend": error_trend,
            "queue": {"pending": pending, "running": running},
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/summary/failure", methods=["POST"])
def summary_failure():
    """直近の失敗原因を分析して要約を返す"""
    data = request.get_json(force=True, silent=True) or {}
    request_id = sanitize(data.get("requestId", ""))
    try:
        # 特定のリクエストIDがあればそれを分析
        if request_id:
            dest = CODE_RESULTS_DIR / f"{request_id}_result.json"
            if not dest.exists():
                dest = CODE_RESULTS_DIR / f"{request_id}.json"
            if not dest.exists():
                matches = sorted(CODE_RESULTS_DIR.glob(f"*{request_id}*.json"),
                                 key=lambda p: p.stat().st_mtime, reverse=True)
                if matches:
                    dest = matches[0]
            if dest.exists():
                result = json.loads(dest.read_text(encoding="utf-8"))
                audit = result.get("audit", {})
                error = result.get("error", "")
                reason = audit.get("reason", error) or "不明"
                # 失敗タイプの分類
                if "old_string" in reason or "不一致" in reason:
                    failure_type = "old_string_mismatch"
                    suggestion = "キーワードを変えて再検索するか、行番号を指定する"
                elif "429" in reason or "rate" in reason.lower():
                    failure_type = "rate_limit"
                    suggestion = "少し待ってからリトライする"
                elif "構文" in reason or "括弧" in reason or "syntax" in reason.lower():
                    failure_type = "syntax_error"
                    suggestion = "修正コードの構文を確認する"
                else:
                    failure_type = "unknown"
                    suggestion = "修正指示をより具体的にする"
                return jsonify({
                    "failureType": failure_type,
                    "analysis": reason[:200],
                    "suggestion": suggestion,
                })

        # リクエストIDなし → 直近の失敗を集計
        results = sorted(CODE_RESULTS_DIR.glob("*_result.json"),
                         key=lambda p: p.stat().st_mtime, reverse=True)
        failures = []
        for r in results[:10]:
            try:
                d = json.loads(r.read_text(encoding="utf-8"))
                if not d.get("success", False) or not d.get("audit", {}).get("passed", False):
                    failures.append(d.get("audit", {}).get("reason", d.get("error", "不明"))[:100])
            except Exception:
                continue
        return jsonify({
            "failureType": "multiple",
            "analysis": "; ".join(failures[:3]) if failures else "直近の失敗なし",
            "suggestion": "エラー傾向を確認して指示を調整する",
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/summary/code", methods=["POST"])
def summary_code():
    """ユーザー入力に関連するコード箇所の要約を返す（HTML全文は返さない）"""
    data = request.get_json(force=True, silent=True) or {}
    user_input = data.get("userInput", "")
    target_file = sanitize(data.get("targetFile", DEFAULT_TARGET_FILE))

    try:
        target_path = BRIDGE_DIR / target_file
        if not target_path.exists():
            return jsonify({"relatedFunctions": [], "relatedLines": "", "summary": "ファイルが見つからない"})

        content = target_path.read_text(encoding="utf-8")
        lines = content.split("\n")

        # キーワード抽出
        import re as _re
        keywords = _re.findall(r'[a-zA-Z_][a-zA-Z0-9_]{2,}', user_input)
        jp_keywords = _re.findall(r'セッション|ラベル|リロード|保存|表示|入力|送信|修正|エラー|ボタン|ヘッダー|議事録|パイプライン|スレッド|監査|診断|設定|クリア', user_input)
        keywords.extend(jp_keywords)
        keywords = list(set(keywords))[:10]

        # 関連関数を検索
        all_funcs = _re.findall(r'(?:async\s+)?function\s+(\w+)', content)
        related_funcs = []
        for func in all_funcs:
            for kw in keywords:
                if kw.lower() in func.lower():
                    related_funcs.append(func)
                    break

        # 関連行を検索（行番号範囲で返す、コード本文は返さない）
        related_ranges = []
        seen = set()
        for kw in keywords[:5]:
            for i, line in enumerate(lines):
                if kw.lower() in line.lower():
                    start = max(0, i - 2)
                    range_key = start // 20
                    if range_key not in seen:
                        seen.add(range_key)
                        # 関数名を特定
                        func_name = ""
                        for j in range(i, max(0, i - 30), -1):
                            fm = _re.match(r'\s*(?:async\s+)?function\s+(\w+)', lines[j])
                            if fm:
                                func_name = fm.group(1)
                                break
                        related_ranges.append(f"{i+1}行({func_name or '?'})")
                    if len(related_ranges) >= 8:
                        break
            if len(related_ranges) >= 8:
                break

        # 要約生成（AIを呼ばず、構造的に要約）
        summary_parts = []
        if related_funcs:
            summary_parts.append(f"関連関数: {', '.join(related_funcs[:5])}")
        if related_ranges:
            summary_parts.append(f"関連箇所: {', '.join(related_ranges[:5])}")
        summary = " / ".join(summary_parts) if summary_parts else "関連コードが見つからなかった"

        return jsonify({
            "relatedFunctions": related_funcs[:10],
            "relatedLines": ", ".join(related_ranges[:8]),
            "summary": summary,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════
# APIキー管理
# ═══════════════════════════════════════

def _mask(v: str) -> str:
    if not v or len(v) < 8:
        return "未設定"
    return v[:6] + "****" + v[-4:]

@app.route("/api/keys", methods=["GET"])
def get_keys():
    keys = load_keys()
    return jsonify({k: _mask(v) for k, v in keys.items()})

@app.route("/api/keys", methods=["POST"])
def save_keys():
    data = request.get_json(force=True, silent=True) or {}
    keys = load_keys()
    for k, v in data.items():
        if k in _ENV_MAP and isinstance(v, str) and v.strip():
            keys[k] = v.strip()
    try:
        _write_env(keys)
        return jsonify({"status": "saved"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════
# Vault APIキー管理 (api_vault.html 用)
# ═══════════════════════════════════════

VAULT_PROVIDERS = ("anthropic", "openai", "xai", "gemini")

@app.route("/api/vault/keys", methods=["GET"])
def vault_get_keys():
    keys = load_keys()
    show_full = request.args.get("full", "false").lower() == "true"
    result = {k: keys.get(k, "") for k in VAULT_PROVIDERS}
    if not show_full:
        result = {k: _mask(v) for k, v in result.items()}
    return jsonify(result)


@app.route("/api/vault/save", methods=["POST"])
def vault_save_keys():
    data = request.get_json(force=True, silent=True) or {}
    keys = load_keys()
    for k in VAULT_PROVIDERS:
        v = data.get(k, "")
        if isinstance(v, str) and v.strip():
            keys[k] = v.strip()
    try:
        _write_env(keys)
        return jsonify({"status": "saved"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/vault/test", methods=["POST"])
def vault_test_keys():
    keys = load_keys()
    results = {}

    # Anthropic
    k = keys.get("anthropic", "")
    if k:
        t0 = time.time()
        try:
            res = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={"Content-Type": "application/json", "x-api-key": k, "anthropic-version": "2023-06-01"},
                json={"model": "claude-haiku-4-5-20251001", "max_tokens": 8,
                      "messages": [{"role": "user", "content": "hi"}]},
                timeout=15
            )
            elapsed = round(time.time() - t0, 2)
            results["anthropic"] = {"status": "PASS" if res.status_code == 200 else "FAIL",
                                    "time": elapsed, "code": res.status_code}
        except Exception as e:
            results["anthropic"] = {"status": "ERROR", "time": 0, "message": str(e)}
    else:
        results["anthropic"] = {"status": "UNSET", "time": 0}

    # OpenAI
    k = keys.get("openai", "")
    if k:
        t0 = time.time()
        try:
            res = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {k}"},
                json={"model": "gpt-4o-mini", "max_tokens": 8,
                      "messages": [{"role": "user", "content": "hi"}]},
                timeout=15
            )
            elapsed = round(time.time() - t0, 2)
            results["openai"] = {"status": "PASS" if res.status_code == 200 else "FAIL",
                                 "time": elapsed, "code": res.status_code}
        except Exception as e:
            results["openai"] = {"status": "ERROR", "time": 0, "message": str(e)}
    else:
        results["openai"] = {"status": "UNSET", "time": 0}

    # xAI / Grok
    k = keys.get("xai", "")
    if k:
        t0 = time.time()
        try:
            res = requests.post(
                "https://api.x.ai/v1/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {k}"},
                json={"model": "grok-3-latest", "max_tokens": 8,
                      "messages": [{"role": "user", "content": "hi"}]},
                timeout=15
            )
            elapsed = round(time.time() - t0, 2)
            results["xai"] = {"status": "PASS" if res.status_code == 200 else "FAIL",
                              "time": elapsed, "code": res.status_code}
        except Exception as e:
            results["xai"] = {"status": "ERROR", "time": 0, "message": str(e)}
    else:
        results["xai"] = {"status": "UNSET", "time": 0}

    # Gemini
    k = keys.get("gemini", "")
    if k:
        t0 = time.time()
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={k}"
            res = requests.post(
                url,
                json={"contents": [{"role": "user", "parts": [{"text": "hi"}]}],
                      "generationConfig": {"maxOutputTokens": 8}},
                timeout=15
            )
            elapsed = round(time.time() - t0, 2)
            results["gemini"] = {"status": "PASS" if res.status_code == 200 else "FAIL",
                                 "time": elapsed, "code": res.status_code}
        except Exception as e:
            results["gemini"] = {"status": "ERROR", "time": 0, "message": str(e)}
    else:
        results["gemini"] = {"status": "UNSET", "time": 0}

    return jsonify(results)


# ═══════════════════════════════════════
# ═══════════════════════════════════════
# v3 セッション管理API（SQLite）
# ═══════════════════════════════════════

SESSIONS_DB = BRIDGE_DIR / "sessions.db"

def _init_sessions_db():
    """v3セッションテーブル + 修正履歴テーブルを初期化"""
    conn = sqlite3.connect(str(SESSIONS_DB))
    conn.execute("""CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        label TEXT,
        label_color TEXT,
        title TEXT,
        status TEXT DEFAULT 'active',
        scope TEXT DEFAULT 'user',
        created_at TEXT,
        updated_at TEXT,
        minutes TEXT,
        diagnosis TEXT,
        chat_log TEXT
    )""")
    # ─── 修正履歴テーブル: 壊れた→直した→結果の対応関係を構造化 ───
    conn.execute("""CREATE TABLE IF NOT EXISTS fix_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        created_at TEXT,
        -- 何が壊れたか
        issue_type TEXT,
        issue_summary TEXT,
        issue_target TEXT,
        issue_keywords TEXT,
        -- どう直したか
        fix_method TEXT,
        fix_instruction TEXT,
        fix_model TEXT,
        -- 結果
        result_success INTEGER,
        result_audit_passed INTEGER,
        result_audit_reason TEXT,
        result_file_changed INTEGER,
        -- 検証
        verify_method TEXT,
        verify_result TEXT,
        -- メタ
        retry_count INTEGER DEFAULT 0,
        related_fix_id INTEGER,
        session_id TEXT
    )""")
    # 検索用インデックス
    conn.execute("CREATE INDEX IF NOT EXISTS idx_fix_keywords ON fix_history(issue_keywords)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_fix_target ON fix_history(issue_target)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_fix_type ON fix_history(issue_type)")
    conn.commit()
    conn.close()
    print("  [v3] セッションDB + 修正履歴テーブル初期化完了:", SESSIONS_DB)

def _get_sessions_db():
    return sqlite3.connect(str(SESSIONS_DB))

# ═══════════════════════════════════════
# 修正履歴API（壊れた→直した→結果の構造化記録）
# ═══════════════════════════════════════

@app.route("/api/fix-history/record", methods=["POST"])
def record_fix():
    """修正の結果を履歴テーブルに記録する"""
    data = request.get_json(force=True, silent=True) or {}
    try:
        conn = _get_sessions_db()
        conn.execute("""INSERT INTO fix_history
            (request_id, created_at, issue_type, issue_summary, issue_target, issue_keywords,
             fix_method, fix_instruction, fix_model, result_success, result_audit_passed,
             result_audit_reason, result_file_changed, verify_method, verify_result,
             retry_count, related_fix_id, session_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
            sanitize(data.get("requestId", "")),
            datetime.datetime.now().isoformat(),
            sanitize(data.get("issueType", "")),
            sanitize(data.get("issueSummary", ""))[:500],
            sanitize(data.get("issueTarget", "")),
            sanitize(data.get("issueKeywords", "")),
            sanitize(data.get("fixMethod", "daemon")),
            sanitize(data.get("fixInstruction", ""))[:500],
            sanitize(data.get("fixModel", "sonnet")),
            1 if data.get("resultSuccess") else 0,
            1 if data.get("resultAuditPassed") else 0,
            sanitize(data.get("resultAuditReason", ""))[:300],
            1 if data.get("resultFileChanged") else 0,
            sanitize(data.get("verifyMethod", "")),
            sanitize(data.get("verifyResult", "")),
            int(data.get("retryCount", 0)),
            data.get("relatedFixId"),
            sanitize(data.get("sessionId", "")),
        ))
        conn.commit()
        fix_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.close()
        return jsonify({"status": "recorded", "fixId": fix_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/fix-history/search", methods=["POST"])
def search_fix_history():
    """過去の修正履歴を検索する（同じ問題で前にどう直したか引く用）"""
    data = request.get_json(force=True, silent=True) or {}
    keywords = sanitize(data.get("keywords", ""))
    target = sanitize(data.get("target", ""))
    issue_type = sanitize(data.get("issueType", ""))
    only_success = data.get("onlySuccess", False)
    only_failed = data.get("onlyFailed", False)
    limit = min(int(data.get("limit", 10)), 50)

    try:
        conn = _get_sessions_db()
        conn.row_factory = sqlite3.Row

        conditions = []
        params = []

        if keywords:
            # キーワードでissue_summary, issue_keywords, fix_instructionをLIKE検索
            kw_conds = []
            for kw in keywords.split():
                kw = kw.strip()
                if kw:
                    kw_conds.append("(issue_summary LIKE ? OR issue_keywords LIKE ? OR fix_instruction LIKE ?)")
                    params.extend([f"%{kw}%", f"%{kw}%", f"%{kw}%"])
            if kw_conds:
                conditions.append("(" + " AND ".join(kw_conds) + ")")

        if target:
            conditions.append("issue_target LIKE ?")
            params.append(f"%{target}%")

        if issue_type:
            conditions.append("issue_type = ?")
            params.append(issue_type)

        if only_success:
            conditions.append("result_success = 1 AND result_audit_passed = 1")
        elif only_failed:
            conditions.append("(result_success = 0 OR result_audit_passed = 0)")

        where = "WHERE " + " AND ".join(conditions) if conditions else ""
        params.append(limit)

        rows = conn.execute(f"""
            SELECT * FROM fix_history
            {where}
            ORDER BY created_at DESC
            LIMIT ?
        """, params).fetchall()

        conn.close()

        results = []
        for r in rows:
            results.append({
                "id": r["id"],
                "requestId": r["request_id"],
                "createdAt": r["created_at"],
                "issueType": r["issue_type"],
                "issueSummary": r["issue_summary"],
                "issueTarget": r["issue_target"],
                "fixMethod": r["fix_method"],
                "fixInstruction": r["fix_instruction"][:200] if r["fix_instruction"] else "",
                "fixModel": r["fix_model"],
                "success": bool(r["result_success"]),
                "auditPassed": bool(r["result_audit_passed"]),
                "auditReason": r["result_audit_reason"],
                "verifyResult": r["verify_result"],
                "retryCount": r["retry_count"],
            })

        return jsonify({
            "results": results,
            "total": len(results),
            "query": {"keywords": keywords, "target": target, "issueType": issue_type},
        })
    except Exception as e:
        return jsonify({"error": str(e), "results": []}), 500


@app.route("/api/fix-history/stats", methods=["GET"])
def fix_history_stats():
    """修正履歴の統計（よく壊れるパターン、成功率の高い修正方法）"""
    try:
        conn = _get_sessions_db()
        conn.row_factory = sqlite3.Row
        total = conn.execute("SELECT count(*) FROM fix_history").fetchone()[0]
        success = conn.execute("SELECT count(*) FROM fix_history WHERE result_success = 1 AND result_audit_passed = 1").fetchone()[0]
        # よく壊れるターゲット
        top_targets = conn.execute("""
            SELECT issue_target, count(*) as cnt,
                   SUM(CASE WHEN result_success=1 AND result_audit_passed=1 THEN 1 ELSE 0 END) as ok
            FROM fix_history
            GROUP BY issue_target ORDER BY cnt DESC LIMIT 5
        """).fetchall()
        # よく壊れるタイプ
        top_types = conn.execute("""
            SELECT issue_type, count(*) as cnt,
                   SUM(CASE WHEN result_success=1 AND result_audit_passed=1 THEN 1 ELSE 0 END) as ok
            FROM fix_history
            GROUP BY issue_type ORDER BY cnt DESC LIMIT 5
        """).fetchall()
        conn.close()
        return jsonify({
            "total": total, "success": success,
            "successRate": round(success / total * 100, 1) if total > 0 else 0,
            "topTargets": [{"target": r["issue_target"], "count": r["cnt"], "successCount": r["ok"]} for r in top_targets],
            "topTypes": [{"type": r["issue_type"], "count": r["cnt"], "successCount": r["ok"]} for r in top_types],
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/sessions", methods=["GET"])
def list_sessions():
    conn = _get_sessions_db()
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT session_id, label, label_color, title, status, scope, created_at, updated_at FROM sessions ORDER BY updated_at DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route("/api/sessions", methods=["POST"])
def create_session():
    data = request.get_json(force=True)
    conn = _get_sessions_db()
    now = datetime.datetime.now().isoformat()
    conn.execute(
        "INSERT INTO sessions (session_id, label, label_color, title, status, scope, created_at, updated_at, minutes, diagnosis, chat_log) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (data.get("session_id", f"sess_{int(time.time()*1000)}"),
         data.get("label", ""),
         data.get("label_color", "#888"),
         data.get("title", ""),
         data.get("status", "active"),
         data.get("scope", "user"),
         data.get("created_at", now),
         now,
         json.dumps(data.get("minutes", []), ensure_ascii=False),
         json.dumps(data.get("diagnosis"), ensure_ascii=False),
         json.dumps(data.get("chat_log", []), ensure_ascii=False))
    )
    conn.commit()
    conn.close()
    return jsonify({"status": "ok", "session_id": data.get("session_id")})

@app.route("/api/sessions/<session_id>", methods=["GET"])
def get_session(session_id):
    conn = _get_sessions_db()
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "not found"}), 404
    result = dict(row)
    for field in ["minutes", "diagnosis", "chat_log"]:
        try: result[field] = json.loads(result[field]) if result[field] else None
        except: pass
    return jsonify(result)

@app.route("/api/sessions/<session_id>", methods=["PUT"])
def update_session(session_id):
    data = request.get_json(force=True)
    conn = _get_sessions_db()
    sets = []
    vals = []
    for field in ["label", "label_color", "title", "status", "scope"]:
        if field in data:
            sets.append(f"{field}=?")
            vals.append(data[field])
    for field in ["minutes", "diagnosis", "chat_log"]:
        if field in data:
            sets.append(f"{field}=?")
            vals.append(json.dumps(data[field], ensure_ascii=False))
    sets.append("updated_at=?")
    vals.append(datetime.datetime.now().isoformat())
    vals.append(session_id)
    conn.execute(f"UPDATE sessions SET {', '.join(sets)} WHERE session_id=?", vals)
    conn.commit()
    conn.close()
    return jsonify({"status": "ok"})

@app.route("/api/sessions/<session_id>", methods=["DELETE"])
def delete_session(session_id):
    conn = _get_sessions_db()
    conn.execute("DELETE FROM sessions WHERE session_id=?", (session_id,))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok"})

@app.route("/api/sessions/<session_id>/reopen", methods=["PUT"])
def reopen_session(session_id):
    conn = _get_sessions_db()
    conn.execute("UPDATE sessions SET status='active', updated_at=? WHERE session_id=?",
                 (datetime.datetime.now().isoformat(), session_id))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok", "new_status": "active"})

@app.route("/api/sessions/labels", methods=["GET"])
def list_labels():
    conn = _get_sessions_db()
    rows = conn.execute("SELECT DISTINCT label, label_color FROM sessions").fetchall()
    conn.close()
    return jsonify([{"label": r[0], "color": r[1]} for r in rows])

@app.route("/api/session/image", methods=["POST"])
def save_session_image():
    """セッションの画像をファイルに保存し、パスを返す"""
    data = request.get_json(force=True)
    session_id = re.sub(r'[^A-Za-z0-9_\-]', '', data.get("sessionId", "unknown"))
    images_b64 = data.get("images", [])
    description = data.get("description", "")

    if not images_b64:
        return jsonify({"error": "no images"}), 400

    try:
        img_dir = BRIDGE_DIR / "session_images" / session_id
        img_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        saved = []
        for i, b64 in enumerate(images_b64):
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            fname = f"{ts}_{i}.png"
            fpath = img_dir / fname
            fpath.write_bytes(base64.b64decode(b64))
            saved.append(str(fpath))
        # メタ情報も保存
        meta = {"timestamp": ts, "description": description, "images": saved}
        meta_path = img_dir / f"{ts}_meta.json"
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return jsonify({"status": "ok", "paths": saved, "meta": str(meta_path)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# 起動
# ═══════════════════════════════════════

def _auto_reload_watcher():
    """server.pyの変更を検知して自動再起動するバックグラウンドスレッド"""
    my_file = Path(__file__).resolve()
    last_mtime = my_file.stat().st_mtime
    print(f"  [AutoReload] 監視中: {my_file.name} (mtime={last_mtime:.0f})")
    while True:
        time.sleep(3)
        try:
            current_mtime = my_file.stat().st_mtime
            if current_mtime != last_mtime:
                print(f"\n  [AutoReload] server.py変更検知! 再起動します...")
                import subprocess
                subprocess.Popen(
                    [sys.executable, str(my_file)],
                    cwd=str(my_file.parent),
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS,
                    close_fds=True
                )
                time.sleep(1)
                os._exit(0)
        except Exception:
            pass


if __name__ == "__main__":
    keys = load_keys()
    configured = [k for k, v in keys.items() if v]

    print("=" * 50)
    print("  OS_FOR_HUMAN API Proxy Server")
    print("=" * 50)
    print(f"  URL       : http://localhost:5000")
    print(f"  ログ保存先: {LOGS_DIR}")
    print(f"  設定済みAPI: {', '.join(configured) if configured else '（未設定）'}")
    print("=" * 50)

    # watch_identify.py / watch_requests.py / process_manager.py → CMD常駐デーモンに置換済み（2026-04-05）
    # CMDでClaude Code対話モードを常駐起動し、code_requests/ポーリングで処理する
    # CMD不在時は /api/code/identify-direct, /api/code/inspect-direct でAPI直叩きフォールバック
    print("  常駐デーモン: CMD Claude Code方式（watch_*.py廃止済み）")
    print("=" * 50)

    # v3セッションテーブル初期化
    _init_sessions_db()

    # server.pyファイル変更の自動検知→再起動
    threading.Thread(target=_auto_reload_watcher, daemon=True).start()

    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
