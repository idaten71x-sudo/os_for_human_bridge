"""
OS_FOR_HUMAN CMD Daemon
code_requests/ をポーリングし、新しい修正依頼を検知したら
Claude API + /api/file/edit で実行する（claude -pは使わない）。
server.py の /api/daemon/ping に5秒ごとに生存報告する。
"""

import os
import sys
import json
import time
import datetime
# Windows cp932でem dashなどが出力できずクラッシュする問題を回避
if sys.stdout.encoding != 'utf-8':
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', errors='replace', buffering=1)
    sys.stderr = open(sys.stderr.fileno(), mode='w', encoding='utf-8', errors='replace', buffering=1)
import re
import glob
import subprocess
import threading
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError
BRIDGE_DIR = Path(__file__).parent
CODE_REQ_DIR = BRIDGE_DIR / "code_requests"
CODE_RESULT_DIR = BRIDGE_DIR / "code_results"
DONE_DIR = CODE_REQ_DIR / "done"
FAILED_QUEUE_DIR = BRIDGE_DIR / "failed_queue"
SERVER_URL = "http://localhost:5000"
# claude -p は使わない（Claude API + /api/file/edit 方式に移行済み）

def _record_fix_history(result_data, instruction=""):
    """修正結果をfix_historyテーブルに自動記録する（結果JSON書き込み時に呼ぶ）"""
    try:
        import urllib.request
        payload = json.dumps({
            "requestId": result_data.get("requestId", ""),
            "issueType": "code_fix",
            "issueSummary": result_data.get("audit", {}).get("reason", "")[:200],
            "issueTarget": result_data.get("targetFile", ""),
            "issueKeywords": "",
            "fixMethod": result_data.get("engine", "daemon"),
            "fixInstruction": instruction[:300],
            "fixModel": "",
            "resultSuccess": result_data.get("success", False),
            "resultAuditPassed": result_data.get("audit", {}).get("passed", False),
            "resultAuditReason": result_data.get("audit", {}).get("reason", "")[:200],
            "resultFileChanged": result_data.get("file_changed", False),
        }).encode("utf-8")
        req = urllib.request.Request(f"{SERVER_URL}/api/fix-history/record",
            data=payload, headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass  # 記録失敗は無視（修正処理を止めない）

CODE_REQ_DIR.mkdir(exist_ok=True)
CODE_RESULT_DIR.mkdir(exist_ok=True)
DONE_DIR.mkdir(exist_ok=True)
FAILED_QUEUE_DIR.mkdir(exist_ok=True)

# 処理済みリクエストID
_processed = set()

# リトライ対象のエラーコード文字列
_RETRYABLE_ERRORS = ['429', '529', '503']


def ping_server():
    """server.py に生存報告"""
    while True:
        try:
            req = Request(f"{SERVER_URL}/api/daemon/ping", method="POST",
                          headers={"Content-Type": "application/json"},
                          data=b'{"source":"cmd_daemon"}')
            urlopen(req, timeout=3)
        except Exception:
            pass
        time.sleep(5)


def mark_as_pending(request_id):
    """コードリクエストを差し戻し状態にマークする。"""
    with open(CODE_REQ_DIR / f"{request_id}.pending", 'w') as f:
        f.write("")


def find_new_requests():
    """未処理の修正依頼を探す"""
    requests = []
    for meta_file in CODE_REQ_DIR.glob("*_meta.json"):
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            req_id = meta.get("requestId", "")
            if not req_id or req_id in _processed:
                continue

            # 対応する request.md を探す
            md_files = list(CODE_REQ_DIR.glob(f"*_{req_id}_request.md"))
            if not md_files:
                continue

            instruction = md_files[0].read_text(encoding="utf-8")

            # 画像ファイルがあれば読み込む
            images = []
            img_file = CODE_REQ_DIR / f"{req_id}_images.json"
            if img_file.exists():
                try:
                    images = json.loads(img_file.read_text(encoding="utf-8"))
                except Exception:
                    pass

            requests.append({
                "requestId": req_id,
                "targetFile": meta.get("targetFile", ""),
                "instruction": instruction,
                "images": images,
                "meta_file": meta_file,
                "md_file": md_files[0],
                "img_file": img_file if img_file.exists() else None,
            })
        except Exception as e:
            print(f"[daemon] meta読み取りエラー: {e}")
    # 自動差し戻し機能をこの位置で統合する予定
    return requests


def get_file_content(filepath):
    """ファイル内容を取得（存在しなければ空文字）"""
    try:
        return Path(filepath).read_text(encoding="utf-8")
    except Exception:
        return ""


def audit_fix(req_id, target, instruction, before_content, after_content, claude_output):
    """修正結果を別AIで監査する。合格/不合格を返す"""
    if before_content == after_content:
        return {"passed": False, "reason": "ファイルが変更されていない（修正が実行されなかった）"}

    # diff生成（unified diff形式 — 変更箇所のコンテキストが正確にわかる）
    import difflib as _difflib
    before_lines = before_content.splitlines(keepends=True)
    after_lines = after_content.splitlines(keepends=True)
    diff_lines = list(_difflib.unified_diff(before_lines, after_lines, fromfile="before", tofile="after", n=3))
    diff_summary = "".join(diff_lines)[:2500] if diff_lines else "差分なし"

    # 監査プロンプト（構文正しさ + 意図達成 を重視）
    audit_prompt = f"""あなたはコード修正の監査官です。以下の修正が正しいか判定してください。

【修正依頼】
{instruction[:1000]}

【修正差分】
{diff_summary[:2000]}

【Claude Code出力】
{claude_output[:1000]}

判定基準（重要度順）:
1. **構文が正しいか**: 括弧の対応、セミコロン、インデントは正しいか。構文エラーがあれば即不合格
2. **修正依頼の意図を達成しているか**: 依頼の文言と完全一致する必要はない。意図（何をしたいか）が達成されていればOK
3. **無関係な変更が混入していないか**: 依頼と関係ない箇所を変更していたら不合格
4. **コードが壊れていないか**: 既存機能を破壊する変更は不合格

注意:
- HTMLファイルのインラインscript内のJS修正で「scriptタグがない」は不合格理由にならない
- 関数名やアプローチが依頼の文言と違っても、意図が同じなら合格
- 修正が1箇所だけであるべきところ複数箇所に変更されていたら不合格
- 既存のclass属性（dev-only等）やid属性が削除されていたら不合格（HTML構造破壊）
- 同名の関数が既にファイル内にあるのに新規追加していたら不合格（重複）
- 新しいdivタグで既存構造を囲み直していたら不合格（HTML構造破壊）
- 「削除しろ」「消せ」「取り除け」という指示に対してCSSのdisplay:noneで非表示にしただけなら**不合格**。HTML要素の物理削除（diffで行が消えている）が必須

以下のJSON形式で回答してください（これ以外は出力しないこと）:
{{"passed": true/false, "reason": "判定理由（1文）"}}"""

    # 監査AIを複数プロバイダで試行（429対策）
    audit_endpoints = [
        ("/api/claude", "claude-sonnet-4-20250514", "claude"),
        ("/api/gpt", None, "gpt"),
        ("/api/gemini", None, "gemini"),
    ]
    import re
    for endpoint, model, provider_name in audit_endpoints:
        for attempt in range(2):
            try:
                payload = {
                    "messages": [{"role": "system", "content": "コード監査官"}, {"role": "user", "content": audit_prompt}],
                }
                if model:
                    payload["model"] = model
                req_data = json.dumps(payload).encode("utf-8")
                req_obj = Request(
                    f"{SERVER_URL}{endpoint}",
                    method="POST",
                    headers={"Content-Type": "application/json"},
                    data=req_data,
                )
                res = urlopen(req_obj, timeout=30)
                body = res.read().decode("utf-8")
                data = json.loads(body)
                # レスポンス形式はプロバイダにより異なる
                if "content" in data and isinstance(data["content"], list):
                    answer = "".join(c.get("text", "") for c in data["content"])
                elif "choices" in data:
                    answer = data["choices"][0].get("message", {}).get("content", "")
                else:
                    answer = data.get("response", "") or data.get("text", "") or body

                m = re.search(r'\{[^}]*"passed"\s*:\s*(true|false)[^}]*\}', answer)
                if m:
                    result = json.loads(m.group())
                    print(f"[daemon] 監査AI ({provider_name}): {'合格' if result.get('passed') else '不合格'}")
                    return result
                return {"passed": False, "reason": f"監査AI({provider_name})応答のパース失敗: {answer[:200]}"}
            except URLError as e:
                err_str = str(e)
                if any(code in err_str for code in _RETRYABLE_ERRORS):
                    matched_code = next(c for c in _RETRYABLE_ERRORS if c in err_str)
                    if attempt == 0:
                        print(f"[daemon] 監査AI ({provider_name}) {matched_code} → 15秒待機")
                        time.sleep(15)
                        continue
                    else:
                        print(f"[daemon] 監査AI ({provider_name}) {matched_code}連続 → 次のプロバイダへ")
                        break
                print(f"[daemon] 監査AI ({provider_name}) エラー: {e} → 次のプロバイダへ")
                break
            except Exception as e:
                print(f"[daemon] 監査AI ({provider_name}) エラー: {e} → 次のプロバイダへ")
                break
    return {"passed": False, "reason": "全監査AIが応答不可（429/エラー）"}


def call_ai_api(system_prompt, user_msg, images=None):
    """server.py経由でAI APIを叩く（Claude→GPT→Geminiフォールバック・429対策）"""
    endpoints = [
        ("/api/claude", "claude-sonnet-4-20250514", "claude"),
        ("/api/gpt", None, "gpt"),
        ("/api/gemini", None, "gemini"),
    ]
    last_error = None
    for endpoint, model, provider_name in endpoints:
        for attempt in range(3):
            try:
                payload = {
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_msg}
                    ],
                    "images": images or [],
                }
                if model:
                    payload["model"] = model
                req_data = json.dumps(payload).encode("utf-8")
                req_obj = Request(
                    f"{SERVER_URL}{endpoint}",
                    method="POST",
                    headers={"Content-Type": "application/json"},
                    data=req_data,
                )
                res = urlopen(req_obj, timeout=90)
                body = res.read().decode("utf-8")
                data = json.loads(body)
                # レスポンス形式はプロバイダにより異なる
                if "content" in data and isinstance(data["content"], list):
                    text = "".join(c.get("text", "") for c in data["content"])
                elif "choices" in data:
                    text = data["choices"][0].get("message", {}).get("content", "")
                else:
                    text = data.get("response", "") or data.get("text", "") or body
                if provider_name != "claude":
                    print(f"[daemon] 編集生成: {provider_name}にフォールバック成功")
                return text
            except URLError as e:
                last_error = e
                err_str = str(e)
                # 429/529/503 はリトライ対象（通常1分程度で復旧）
                if any(code in err_str for code in _RETRYABLE_ERRORS):
                    matched_code = next(c for c in _RETRYABLE_ERRORS if c in err_str)
                    wait = (attempt + 1) * 20
                    if attempt < 2:
                        print(f"[daemon] 編集生成 ({provider_name}) {matched_code}エラー → {wait}秒待機して再試行 (試行{attempt+1}/3)")
                        time.sleep(wait)
                        continue
                    else:
                        print(f"[daemon] 編集生成 ({provider_name}) {matched_code}が60秒経っても復旧しない → 次のプロバイダへ")
                        break
                print(f"[daemon] 編集生成 ({provider_name}) エラー: {e} → 次のプロバイダへ")
                break
            except Exception as e:
                last_error = e
                print(f"[daemon] 編集生成 ({provider_name}) エラー: {e} → 次のプロバイダへ")
                break
    # 全AI失敗：キュー退避（後で復旧スレッドがリトライ）
    _enqueue_failed_request(system_prompt, user_msg, images)
    raise Exception(f"全AI編集生成失敗（最後のエラー: {last_error}）→ failed_queueに退避済み")


# 後方互換: 既存コードからの呼び出し用
def call_claude_api(system_prompt, user_msg, images=None, max_retries=3):
    """call_ai_apiのエイリアス（後方互換）"""
    return call_ai_api(system_prompt, user_msg, images)


# ─── 全AI失敗時のキュー退避＋自動復旧 ───

def _enqueue_failed_request(system_prompt, user_msg, images=None):
    """全AIが応答不能な場合、リクエストをファイルに退避"""
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    entry = {
        "timestamp": ts,
        "system_prompt": system_prompt,
        "user_msg": user_msg[:500],  # 巨大メッセージは切り詰め
        "images": bool(images),
        "retry_count": 0,
        "status": "queued"
    }
    path = FAILED_QUEUE_DIR / f"failed_{ts}.json"
    path.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[daemon] 全AI失敗 → failed_queueに退避: {path.name}")


def _recovery_worker():
    """failed_queue内の未処理リクエストを定期的にリトライする復旧スレッド"""
    while True:
        time.sleep(120)  # 2分ごとにチェック
        queued_files = sorted(FAILED_QUEUE_DIR.glob("failed_*.json"))
        if not queued_files:
            continue
        print(f"[daemon] 復旧スレッド: {len(queued_files)}件の失敗リクエストを検出")
        # まずAPIが生きてるかチェック（軽量ping）
        api_alive = False
        for endpoint in ["/api/claude", "/api/gpt", "/api/gemini"]:
            try:
                payload = json.dumps({
                    "messages": [{"role": "user", "content": "ping"}]
                }).encode("utf-8")
                req_obj = Request(
                    f"{SERVER_URL}{endpoint}",
                    method="POST",
                    headers={"Content-Type": "application/json"},
                    data=payload,
                )
                res = urlopen(req_obj, timeout=15)
                if res.status == 200:
                    api_alive = True
                    print(f"[daemon] 復旧スレッド: {endpoint} が応答 → 復旧開始")
                    break
            except Exception:
                continue
        if not api_alive:
            print("[daemon] 復旧スレッド: 全APIまだ応答なし → 2分後に再チェック")
            continue
        # API復旧確認 → server.pyに復旧通知を送信
        try:
            notify_data = json.dumps({
                "event": "api_recovered",
                "queued_count": len(queued_files),
                "timestamp": datetime.datetime.now().isoformat()
            }).encode("utf-8")
            req_obj = Request(
                f"{SERVER_URL}/api/daemon/recovery-notify",
                method="POST",
                headers={"Content-Type": "application/json"},
                data=notify_data,
            )
            urlopen(req_obj, timeout=5)
        except Exception:
            pass
        # 古いキューから処理（最大3件ずつ）
        for qf in queued_files[:3]:
            try:
                entry = json.loads(qf.read_text(encoding="utf-8"))
                if entry.get("retry_count", 0) >= 5:
                    # 5回リトライしても無理 → 諦め
                    entry["status"] = "abandoned"
                    qf.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
                    print(f"[daemon] 復旧スレッド: {qf.name} は5回失敗 → 放棄")
                    continue
                entry["retry_count"] = entry.get("retry_count", 0) + 1
                entry["status"] = "retrying"
                qf.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"[daemon] 復旧スレッド: {qf.name} を再試行 ({entry['retry_count']}回目)")
                # 再試行は通知のみ（元のリクエストコンテキストは既に失われている）
                # キューから削除して「復旧済み」とする
                qf.unlink()
                print(f"[daemon] 復旧スレッド: {qf.name} をキューから削除（API復旧確認済み）")
            except Exception as e:
                print(f"[daemon] 復旧スレッド: {qf.name} 処理エラー: {e}")


# 復旧スレッドを起動（daemon起動時に自動開始）
threading.Thread(target=_recovery_worker, daemon=True, name="recovery_worker").start()


def _extract_proposed_code(instruction):
    """instructionに含まれるAI提案コードブロックを抽出（共通インデント除去）"""
    import re
    import textwrap
    blocks = re.findall(r'```(?:javascript|js|html|python|py|css)?\s*\n([\s\S]*?)\n\s*```', instruction)
    return [textwrap.dedent(b).strip() for b in blocks]


def _build_edits_from_proposed(target, instruction, file_content):
    """AI提案コードが含まれている場合、Claude APIを使わず直接editを生成"""
    blocks = _extract_proposed_code(instruction)
    if not blocks:
        return None

    lines = file_content.splitlines()
    edits = []

    for block in blocks:
        block = block.strip()
        if not block:
            continue
        # HTMLの修正（onclick追加等）
        if '<button' in block and 'onclick' in block:
            # 既存のボタンタグを探してonclick付きに置換
            import re
            # block内のボタンのテキスト内容を抽出して既存ボタンを検索
            btn_text_m = re.search(r'>([^<]+)</button>', block)
            if btn_text_m:
                btn_text = btn_text_m.group(1)
                for i, line in enumerate(lines):
                    if btn_text in line and '<button' in line:
                        edits.append({"old_string": line, "new_string": block})
                        break
        # Python関数の追加（@app.route / def）
        elif target.endswith('.py') and ('def ' in block or '@app.route' in block):
            import re
            # @app.routeがあればルート名を取得して近くに挿入
            route_m = re.search(r"@app\.route\(['\"]([^'\"]+)", block)
            if route_m:
                route_path = route_m.group(1)
                # 同じパスの既存ルートがあれば置換
                for i, line in enumerate(lines):
                    if route_path in line and '@app.route' in line:
                        # 既存ルートの範囲（@app.route + def + 本体）を見つけて置換
                        end = i + 1
                        # def行を飛ばす
                        if end < len(lines) and lines[end].strip().startswith('def '):
                            end += 1
                        # インデントされた本体を飛ばす
                        while end < len(lines) and (lines[end].startswith('    ') or lines[end].strip() == ''):
                            end += 1
                        old = "\n".join(lines[i:end])
                        edits.append({"old_string": old, "new_string": block})
                        break
                else:
                    # 新規ルート → 最後の@app.routeブロックの後ろに挿入
                    last_code_line = -1
                    for i in range(len(lines) - 1, -1, -1):
                        if '@app.route' in lines[i]:
                            # @app.route → def → 本体 の全体を飛ばす
                            j = i + 1
                            # def行を飛ばす
                            if j < len(lines) and lines[j].strip().startswith('def '):
                                j += 1
                            # インデントされた本体を飛ばす（最後のコード行を記録）
                            last_body = j - 1
                            while j < len(lines) and (lines[j].startswith('    ') or lines[j].strip() == ''):
                                if lines[j].strip():  # 空行じゃない行を記録
                                    last_body = j
                                j += 1
                            last_code_line = last_body
                            break
                    if last_code_line > 0:
                        old = lines[last_code_line]
                        edits.append({"old_string": old, "new_string": old + "\n\n\n" + block})
                    else:
                        # fallback: ファイル末尾に追加
                        old = lines[-1]
                        edits.append({"old_string": old, "new_string": old + "\n\n\n" + block})
            else:
                # @app.routeなしのdef → ファイル末尾の関数定義の後に追加
                for i in range(len(lines) - 1, -1, -1):
                    if lines[i].startswith('def '):
                        j = i + 1
                        while j < len(lines) and (lines[j].startswith('    ') or lines[j].strip() == ''):
                            j += 1
                        old = lines[j - 1] if j - 1 < len(lines) else lines[-1]
                        edits.append({"old_string": old, "new_string": old + "\n\n\n" + block})
                        break
        # JS関数の追加
        elif ('function ' in block or 'async function' in block):
            import re as _re2
            # 同名関数が既にファイル内にあれば置換、なければ新規追加
            func_name_m = _re2.search(r'(?:async\s+)?function\s+(\w+)', block)
            if func_name_m:
                fname = func_name_m.group(1)
                # 既存の同名関数を探す
                existing_start = -1
                for i, line in enumerate(lines):
                    if _re2.search(r'(?:async\s+)?function\s+' + _re2.escape(fname) + r'\s*\(', line):
                        existing_start = i
                        break
                if existing_start >= 0:
                    # 既存関数を新しいブロックで置換（関数末尾を探す）
                    brace_count = 0
                    end = existing_start
                    for j in range(existing_start, len(lines)):
                        brace_count += lines[j].count('{') - lines[j].count('}')
                        if brace_count <= 0 and j > existing_start:
                            end = j
                            break
                    old = "\n".join(lines[existing_start:end + 1])
                    edits.append({"old_string": old, "new_string": block})
                    print(f"[daemon] 既存関数 {fname}() を置換 (行{existing_start+1}-{end+1})")
                    continue  # 次のblockへ

            # 新規追加: __CODE_FIX_ANCHOR__ の直後に挿入
            anchor = "// __CODE_FIX_ANCHOR__"
            for i, line in enumerate(lines):
                if anchor in line:
                    old = line
                    edits.append({"old_string": old, "new_string": old + "\n\n" + block})
                    break
            else:
                # fallback: </script>の直前に挿入
                for i in range(len(lines) - 1, -1, -1):
                    if '</script>' in lines[i]:
                        old = lines[i]
                        edits.append({"old_string": old, "new_string": block + "\n" + old})
                        break

    return edits if edits else None


def _check_js_syntax(code):
    """Node.jsでJavaScriptの構文チェック。エラーがあればメッセージを返す。正常ならNone"""
    try:
        # Windows対策: コマンドライン長制限を回避するため一時ファイル経由で渡す
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False, encoding='utf-8') as f:
            f.write(f'new Function({json.dumps(code)})')
            tmp_path = f.name
        try:
            result = subprocess.run(
                ['node', tmp_path],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                err = result.stderr.strip().split('\n')[-1] if result.stderr else 'unknown error'
                return err[:200]
            return None
        finally:
            try: os.unlink(tmp_path)
            except: pass
    except Exception as e:
        return f"node実行エラー: {e}"


def _dry_run_edits(edits, target, file_content):
    """editを仮適用して構文チェック。問題があればエラー文字列を返す。OKならNone。
    実ファイルには一切触らない。"""
    test_content = file_content
    for i, e in enumerate(edits):
        old = e.get("old_string", "")
        new = e.get("new_string", "")
        if old not in test_content:
            return f"edit{i+1}: old_stringがファイル内に存在しない"
        test_content = test_content.replace(old, new, 1)

    if target.endswith('.html'):
        # 括弧バランスチェック
        ob = test_content.count('{'); cb = test_content.count('}')
        op = test_content.count('('); cp = test_content.count(')')
        if abs(ob - cb) > 2:
            return f"波括弧不一致: 開{ob} vs 閉{cb}"
        if abs(op - cp) > 2:
            return f"丸括弧不一致: 開{op} vs 閉{cp}"
        # script内のJSをNode.jsで構文チェック
        import re as _re
        scripts = _re.findall(r'<script[^>]*>([\s\S]*?)</script>', test_content)
        for j, script in enumerate(scripts):
            if len(script.strip()) < 50:
                continue
            err = _check_js_syntax(script)
            if err:
                return f"JS構文エラー (script#{j+1}): {err}"
    elif target.endswith('.py'):
        try:
            compile(test_content, target, 'exec')
        except SyntaxError as se:
            return f"Python構文エラー: {se.msg} (行{se.lineno})"
    return None


def _strip_line_numbers(text):
    """AIが行番号プレフィックスを含めてしまった場合に除去する。
    パターン: '123: コード' や '  45: コード' など"""
    import re as _re
    lines = text.splitlines()
    # 全行が行番号パターンに一致するかチェック
    numbered = [bool(_re.match(r'^\s*\d{1,5}:\s?', l)) for l in lines if l.strip()]
    if numbered and sum(numbered) >= len(numbered) * 0.7:
        # 70%以上が行番号パターン → 行番号を除去
        stripped = [_re.sub(r'^\s*\d{1,5}:\s?', '', l) for l in lines]
        return "\n".join(stripped)
    return None


def _fuzzy_find_old_string(old_string, file_content, cutoff=0.7):
    """old_stringがファイル内に完全一致しない場合、最も近いブロックをfuzzy matchで探す。
    高速化: old_stringの1行目からキーワードを抽出→キーワードを含む行の周辺のみスキャン
    まず行番号プレフィックス除去を試みてから完全一致を再確認する"""
    import difflib
    import re as _re

    # Step 0: AIが行番号を含めてしまった場合の自動除去
    stripped = _strip_line_numbers(old_string)
    if stripped and stripped in file_content:
        print(f"[daemon] fuzzy match: 行番号プレフィックス除去で完全一致")
        return stripped
    if stripped:
        old_string = stripped  # 以降のfuzzy matchも行番号除去版で行う

    old_lines = old_string.splitlines()
    file_lines = file_content.splitlines()
    old_len = len(old_lines)
    if old_len == 0:
        return None

    # Step 1: old_stringの1行目からキーワードを抽出して候補行を絞り込む
    first_line = old_lines[0].strip()
    keywords = _re.findall(r'[a-zA-Z_][a-zA-Z0-9_]+', first_line)
    # 3文字以上の固有キーワード（短すぎるものは除外）
    keywords = [k for k in keywords if len(k) > 3][:5]

    candidate_starts = set()
    for i, line in enumerate(file_lines):
        for kw in keywords:
            if kw.lower() in line.lower():
                # この行の周辺をスキャン対象に
                for offset in range(-3, 4):
                    idx = i + offset
                    if 0 <= idx < len(file_lines):
                        candidate_starts.add(idx)
                break

    if not candidate_starts:
        # キーワードが見つからない → 全行フォールバック（ただし上限500行）
        candidate_starts = set(range(min(len(file_lines), 500)))

    # Step 2: 候補行の周辺でブロック単位比較
    best_ratio = 0
    best_block = None

    for window_size in range(max(1, old_len - 1), old_len + 2):
        if window_size > len(file_lines):
            continue
        for start in sorted(candidate_starts):
            if start + window_size > len(file_lines):
                continue
            candidate = "\n".join(file_lines[start:start + window_size])
            ratio = difflib.SequenceMatcher(None, old_string, candidate).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_block = candidate

    if best_ratio >= cutoff and best_block and best_block in file_content:
        # 追加検証: 固有識別子チェック
        _generic = {'route', 'methods', 'POST', 'GET', 'PUT', 'DELETE', 'def', 'return',
                     'function', 'async', 'const', 'class', 'self', 'app', 'jsonify',
                     'request', 'true', 'false', 'None', 'True', 'False', 'button',
                     'click', 'style', 'type', 'value', 'name', 'this', 'document'}
        identifiers = _re.findall(r'[a-zA-Z_/][a-zA-Z0-9_/]+', first_line)
        key_ids = [x for x in identifiers if len(x) > 3 and x not in _generic]
        if key_ids:
            if not any(kid in best_block for kid in key_ids):
                print(f"[daemon] fuzzy match: ratio={best_ratio:.2f} だが固有識別子{key_ids[:3]}が候補に不在 → 棄却")
                return None
        print(f"[daemon] fuzzy match: ratio={best_ratio:.2f} (cutoff={cutoff})")
        return best_block
    return None


def _estimate_tokens(text):
    """テキストのトークン数を概算（日本語4文字≈1トークン、英語4文字≈1トークン）"""
    return max(len(text) // 3, len(text.split()) * 2)

# プロバイダ別のトークン上限（安全マージン込み）
_PROVIDER_TOKEN_LIMITS = {
    "claude": 180000,  # Claude: 200K入力だが余裕を持つ
    "gpt": 25000,      # GPT-4o: TPM 30000だが予算管理で25000に
    "gemini": 90000,   # Gemini: 1M入力だが余裕を持つ
}


def _compress_for_budget(file_snippet, budget_tokens, lines, total, instruction):
    """トークン予算に収まるようにfile_snippetを圧縮する"""
    import re as _re
    est = _estimate_tokens(file_snippet)
    if est <= budget_tokens:
        return file_snippet  # 予算内 → そのまま

    print(f"[daemon] トークン予算超過: {est} > {budget_tokens} → 自動圧縮")

    # 圧縮戦略1: キーワード周辺だけに絞る
    keywords = _re.findall(r'[a-zA-Z_]\w{3,}', instruction)
    keywords += _re.findall(r'[「『](.*?)[」』]', instruction)
    # 削除系指示の場合、日本語キーワードも抽出（HTML要素特定用）
    jp_kw = _re.findall(r'[\u3040-\u9fff]{2,}', instruction)
    keywords += jp_kw
    keywords = list(dict.fromkeys(keywords))[:15]
    seen = set()
    chunks = [f"--- L1-60 ---\n" + "\n".join(f"{i+1}: {l}" for i, l in enumerate(lines[:60]))]
    for kw in keywords:
        for i, line in enumerate(lines):
            if kw.lower() in line.lower():
                s = max(0, i - 20)
                e = min(total, i + 20)
                rng = (s // 10, e // 10)  # 粗いグルーピング
                if rng not in seen:
                    seen.add(rng)
                    chunks.append(f"--- L{s+1}-{e} ---\n" + "\n".join(f"{j+1}: {lines[j]}" for j in range(s, e)))
                break
    chunks.append(f"--- L{total-30}-{total} ---\n" + "\n".join(f"{j+1}: {lines[j]}" for j in range(max(0, total-30), total)))
    compressed = "\n\n".join(chunks)
    est2 = _estimate_tokens(compressed)
    print(f"[daemon] 圧縮後: {est2}トークン（{est}→{est2}）")
    if est2 <= budget_tokens:
        return compressed

    # 圧縮戦略2: さらに絞る（先頭40行 + キーワード周辺10行 + 末尾20行）
    chunks2 = ["\n".join(f"{i+1}: {l}" for i, l in enumerate(lines[:40]))]
    for kw in keywords[:5]:
        for i, line in enumerate(lines):
            if kw.lower() in line.lower():
                s = max(0, i - 5)
                e = min(total, i + 5)
                chunks2.append("\n".join(f"{j+1}: {lines[j]}" for j in range(s, e)))
                break
    chunks2.append("\n".join(f"{j+1}: {lines[j]}" for j in range(max(0, total-20), total)))
    ultra_compressed = "\n\n".join(chunks2)
    print(f"[daemon] 超圧縮: {_estimate_tokens(ultra_compressed)}トークン")
    return ultra_compressed


def _search_past_fixes(target, instruction):
    """過去の修正履歴から同様の案件を検索し、失敗パターンと成功パターンを返す"""
    import re as _re
    try:
        import requests as _req
        # キーワード抽出
        keywords = _re.findall(r'[a-zA-Z_]\w{3,}', instruction)
        jp_kw = _re.findall(r'[\u3040-\u9fff]{2,}', instruction)
        search_kw = ' '.join(list(dict.fromkeys(keywords + jp_kw))[:8])
        if not search_kw:
            return ""

        # 過去の失敗を検索
        fail_res = _req.post('http://localhost:5000/api/fix-history/search',
            json={"keywords": search_kw, "target": target, "onlyFailed": True, "limit": 3}, timeout=3)
        # 過去の成功を検索
        ok_res = _req.post('http://localhost:5000/api/fix-history/search',
            json={"keywords": search_kw, "target": target, "onlySuccess": True, "limit": 3}, timeout=3)

        past_context = ""
        if fail_res.ok:
            fails = fail_res.json().get("results", [])
            if fails:
                past_context += "\n【過去の失敗事例 — 同じ失敗を繰り返すな】\n"
                for f in fails:
                    past_context += f"  ❌ {f['requestId']}: {f['auditReason'][:80]}\n"
                past_context += "上記のパターンで失敗してる。同じやり方は避けろ。\n"

        if ok_res.ok:
            oks = ok_res.json().get("results", [])
            if oks:
                past_context += "\n【過去の成功事例 — このやり方なら通る】\n"
                for o in oks:
                    past_context += f"  ✅ {o['requestId']}: {o['auditReason'][:80]}\n"
                past_context += "上記のパターンで成功してる。参考にしろ。\n"

        if past_context:
            print(f"[daemon] 過去の修正履歴を注入: 失敗{len(fails if fail_res.ok else [])}件 / 成功{len(oks if ok_res.ok else [])}件")
        return past_context
    except Exception as e:
        print(f"[daemon] 過去履歴検索エラー（無視して続行）: {e}")
        return ""


def generate_edit(target, instruction, file_content, images=None):
    """Claude APIでold_string/new_stringの編集指示を生成する"""
    # AI提案コードが含まれていたら、Claude APIを使わず直接edit生成
    proposed_edits = _build_edits_from_proposed(target, instruction, file_content)
    if proposed_edits:
        print(f"[daemon] AI提案コードから直接edit生成: {len(proposed_edits)}件")
        for e in proposed_edits:
            e["_from_proposed"] = True
        return proposed_edits

    lines = file_content.splitlines()
    total = len(lines)

    # CSS/UI修正判定: CSSだけで済む修正なら<style>部分だけ送る（トークン削減）
    import re as _re
    is_css_fix = bool(_re.search(r'CSS|色|配置|レイアウト|左右|右寄せ|左寄せ|余白|padding|margin|font|背景|ボーダー|border|width|height|表示.*スタイル|スタイル.*変更|明るく|暗く|太く|細く|大きく|小さく', instruction, _re.IGNORECASE))
    if is_css_fix and target.endswith('.html'):
        # 全<style>タグを送る（複数styleタグの詳細度競合を検知するため）
        css_chunks = []
        in_style = False
        style_block_start = None
        style_count = 0
        for i, line in enumerate(lines):
            if '<style' in line and not in_style:
                in_style = True
                style_block_start = max(0, i - 1)
            if '</style>' in line and in_style:
                in_style = False
                style_count += 1
                s = style_block_start
                e = min(i + 2, total)
                css_chunks.append(f"--- CSS部分{style_count} L{s+1}-{e} ---\n" + "\n".join(f"{j+1}: {lines[j]}" for j in range(s, e)))
        # appendMinutes周辺（class構造確認用）
        for i, line in enumerate(lines):
            if 'function appendMinutes' in line or "className = `ai-msg" in line or "colorClass = " in line:
                s = max(0, i - 3)
                e = min(total, i + 10)
                css_chunks.append(f"--- appendMinutes class構造 L{s+1}-{e} ---\n" + "\n".join(f"{j+1}: {lines[j]}" for j in range(s, e)))
                break
        if css_chunks:
            file_snippet = "\n\n".join(css_chunks)
            print(f"[daemon] CSS修正モード: 全styleタグ({style_count}個)+class構造を送信（{len(file_snippet)}文字）")
        else:
            # フォールバック: 先頭400行
            file_snippet = "\n".join(f"{i+1}: {line}" for i, line in enumerate(lines[:400]))

    elif total <= 3000:
        # 3000行以下なら全文送信（AIがファイル全体を理解できる）
        numbered_lines = [f"{i+1}: {line}" for i, line in enumerate(lines)]
        file_snippet = "\n".join(numbered_lines)
    else:
        # 大きいファイルはキーワード周辺を拡大抽出
        keywords = _re.findall(r'[a-zA-Z_]\w{3,}', instruction)
        keywords += _re.findall(r'[「『](.*?)[」』]', instruction)
        keywords = list(dict.fromkeys(keywords))
        seen_ranges = set()
        chunks = [f"--- L1-120 ---\n" + "\n".join(f"{i+1}: {l}" for i, l in enumerate(lines[:120]))]
        for kw in keywords[:15]:
            matches_found = 0
            for i, line in enumerate(lines):
                if kw.lower() in line.lower():
                    s = max(0, i - 50)
                    e = min(total, i + 50)
                    rng = (s, e)
                    if rng not in seen_ranges:
                        seen_ranges.add(rng)
                        chunks.append(f"--- L{s+1}-{e} ---\n" + "\n".join(f"{j+1}: {lines[j]}" for j in range(s, e)))
                        matches_found += 1
                    if matches_found >= 3:
                        break
            chunks.append(f"--- L{total-60}-{total} ---\n" + "\n".join(f"{j+1}: {lines[j]}" for j in range(max(0, total-60), total)))
        file_snippet = "\n\n".join(chunks)

    # ─── 送信前トークン予算管理 ───
    # GPTフォールバック時に429を防ぐため、最も厳しい制限に合わせて事前圧縮
    gpt_budget = _PROVIDER_TOKEN_LIMITS["gpt"]
    # プロンプト全体のオーバーヘッド（system_prompt + 指示テンプレ等）≈ 2000トークン
    file_budget = gpt_budget - 2000 - _estimate_tokens(instruction)
    file_budget = max(file_budget, 5000)  # 最低5000トークンは確保
    file_snippet = _compress_for_budget(file_snippet, file_budget, lines, total, instruction)

    image_instruction = ""
    if images:
        image_instruction = """
【画像について】
添付画像はこのHTMLのスクリーンショットです。
1. まず画像に映っているUI要素（ボタン、テキスト、モーダル、アイコン等）を特定してください
2. 次に、上記ファイル内容からそのUI要素に対応するHTML/JS/CSSコードを照合してください
   - ボタンならonclick属性や関数名、テキストなら表示箇所
3. 照合結果に基づいて修正箇所を確定し、editを生成してください
画像に映っている要素とコードの照合が最優先です。推測ではなく、実コードと画像の一致で判断すること。
"""

    # ファイル種別に応じた追加文脈
    file_context = ""
    if target.endswith('.html'):
        file_context = """
【ファイル構造の注意】
このHTMLファイルはインラインscript方式（全JSがscriptタグ内に記述）です。
- 新規関数追加: 既存関数の閉じ括弧の直後をold_stringにし、new_stringに閉じ括弧+改行+新関数を含める
- scriptタグ自体の追加は不要（既に存在する）
- 関数名はcamelCase（既存コードに合わせる）

【JS関数を書くときの絶対ルール】
1. async関数でfetchする場合は必ずこのパターンに従え:
   async function funcName() {
     try {
       const res = await fetch(url, options);
       const data = await res.json();
       // dataを使う処理
     } catch (e) {
       // エラー処理
     }
   }
2. resを使う前にawaitしろ。res.json()の結果もawaitしろ
3. 変数は使う前に必ず定義しろ。未定義変数の参照は絶対NG
4. 開いた括弧は必ず閉じろ。関数末尾の閉じ括弧を忘れるな
5. new_stringを書き終えたら、波括弧と丸括弧の数を数えて一致を確認しろ
"""
    elif target.endswith('.py'):
        file_context = """
【ファイル構造の注意】
このPythonファイルはインデント=4スペースです。
- 新規関数を追加する場合: 既存の関数定義の直後をold_stringにし、new_stringにold_string + 空行2つ + 新関数を含める
- import文が必要なら既存のimportブロックに追加すること
"""

    # 過去の修正履歴を検索して注入
    past_fixes = _search_past_fixes(target, instruction)

    prompt = f"""あなたはコード修正エンジンです。

【対象ファイル】{target}（全{total}行）
{file_context}
【ファイル内容】
{file_snippet}
{image_instruction}
【修正依頼】
{instruction}
{past_fixes}

【絶対ルール — 違反すると失敗する】
1. old_stringはファイル内に**実在する文字列をそのままコピー**すること。⚠️行番号プレフィックス（例: "123: "）は絶対にold_stringに含めるな⚠️ 行番号はファイルの一部ではない。1文字でも違うと失敗する。空白・インデントも正確に一致させろ
2. **old_stringは最大10行**にしろ。既存の大きな関数を丸ごとold_stringに入れるな — 必ず失敗する
3. **既存関数を書き換えるな**。新しい関数を追加する場合は、既存関数を壊さず、挿入位置の直前1-3行をold_stringにしてnew_stringにold_string+改行+新関数を含めろ
4. HTMLファイルの場合、**新規JS関数は // __CODE_FIX_ANCHOR__ の直後に挿入**しろ。old_stringに「// __CODE_FIX_ANCHOR__」を使い、new_stringに「// __CODE_FIX_ANCHOR__\n\n新関数」を書け
5. HTMLボタン追加は、既存ボタンの行をold_stringにして、new_stringにold_string+改行+新ボタンを含めろ
6. 最小限の変更にすること。不要な行を追加するな。<!-- 修正前 --><!-- 修正後 -->等のHTMLコメントや// 修正前 // 修正後等のJSコメントをnew_stringに入れるな。コードだけ書け
7. 新規関数は必ず完全な実装を書くこと。途中で省略するな
8. **重要**: 修正依頼に【AIが提案したコード】が含まれている場合、そのコードをそのままコピーして使え。自分で書き直すな
9. 各editのnew_stringは**15行以内**にしろ
10. editsの数は**最大3つ**まで
11. **最重要**: new_stringの括弧は必ず対応を確認。波括弧を開いたら閉じろ。丸括弧を開いたら閉じろ。new_stringだけで波括弧と丸括弧の数を数えて一致させろ
12. **同名関数の重複追加禁止**: ファイル内容を検索して、追加しようとする関数名が既に存在するなら新規追加するな。既存関数を置換するか、追加をスキップしろ
13. **既存HTML属性を消すな**: old_stringにclass属性（dev-only等）やid属性が含まれている場合、new_stringにも同じ属性を残すこと。属性を勝手に消すと表示が壊れる
14. **HTML構造を壊すな**: 新しいdivやタグを追加する場合、既存のHTML構造（開きタグと閉じタグの対応）を壊さないこと
15. **HTML要素の削除はold_string/new_stringで物理削除しろ**: 「消せ」「削除しろ」「取り除け」という指示に対してCSSのdisplay:noneで隠すのは禁止。old_stringに削除対象のHTML要素を入れて、new_stringを空文字列にしろ。CSSで隠すのは「削除」ではない

【UI修正（見た目・レイアウト）の鉄則】
- 見た目の変更（色、配置、余白、左右分け、サイズ等）は**まずCSSだけで対応しろ**。JSの関数追加は最終手段
- ただし「削除」「消せ」「取り除け」の指示に対してはCSSで隠すのではなくHTML要素を物理削除すること
- appendMinutesは speaker ごとに class を吐いている: user→user-interrupt, system→system-msg, AI→claude/gpt/gemini/grok
- これらの既存classに対するCSSルールを追加/変更するだけで大半のUI修正はできる。新関数を作るな
- appendMinutes / appendChatLog 等の保護関数の新バージョン（appendMinutesLeftRight等）を作るな。既存classの活用で対応しろ
- style属性やCSSセレクタ（.ai-msg.user-interrupt等）を使って対応しろ

【CSS修正の最重要ルール — 同じセレクタが複数箇所にある場合】
- CSSは**後に書かれたルールが先のルールを上書きする**（詳細度が同じ場合）
- 修正したいプロパティ（max-width, font-size等）が**ファイル内の複数箇所**に存在する場合、**全箇所を修正しろ**。1箇所だけ変えても他の箇所に上書きされて効かない
- 送られたCSS部分に同じセレクタが2回以上出てきたら、**最後に出てくるもの**が実際に適用される。そこを修正しろ
- 確実に効かせたい場合は、ファイル内で**最後に書かれている該当セレクタ**を修正すること

複数箇所の変更が必要な場合は配列で返してください（最大3つ）。
以下のJSON形式で回答してください（これ以外は出力しないこと）:
{{"edits": [{{"old_string": "置換前1", "new_string": "置換後1"}}, {{"old_string": "置換前2", "new_string": "置換後2"}}]}}

1箇所だけなら:
{{"edits": [{{"old_string": "置換前", "new_string": "置換後"}}]}}"""

    answer = call_claude_api("コード修正エンジン。JSON以外出力禁止。", prompt, images)
    print(f"[daemon] Claude API応答: {answer[:300]}")

    import re
    # ```json ... ``` の中身を抽出、またはraw JSON
    code_block = re.search(r'```(?:json)?\s*\n([\s\S]*?)\n```', answer)
    json_text = code_block.group(1) if code_block else answer

    try:
        parsed = json.loads(json_text)
        # edits配列形式
        if "edits" in parsed and isinstance(parsed["edits"], list):
            valid = [e for e in parsed["edits"] if e.get("old_string") and e.get("new_string")]
            return valid if valid else None
        # 旧形式（単一edit）
        if parsed.get("old_string") and parsed.get("new_string"):
            return [parsed]
    except Exception:
        pass

    # フォールバック: 正規表現で抽出
    edits = []
    for m in re.finditer(r'\{[^{}]*?"old_string"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"new_string"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}', json_text):
        edits.append({"old_string": m.group(1).replace('\\"', '"').replace('\\n', '\n'),
                       "new_string": m.group(2).replace('\\"', '"').replace('\\n', '\n')})
    return edits if edits else None


_last_exec = {}  # {instruction_hash: timestamp} 同一案件限定の重複実行防止

def _instruction_hash(instruction):
    """修正依頼のハッシュ（同一内容の重複検知用）"""
    import hashlib
    # instructionの主要部分だけハッシュ（リトライ時の追加文言は除外）
    core = instruction.split('【前回の修正が失敗した理由】')[0].strip()
    # threadName / phenomenon 部分を抽出（JSON埋め込みの場合）
    import re
    m = re.search(r'"threadName"\s*:\s*"([^"]*)"', core)
    key = m.group(1) if m else core[:200]
    return hashlib.md5(key.encode()).hexdigest()[:12]

def execute_request(req, error_feedback=""):
    """Claude API → file/edit で修正依頼を実行 + 監査
    error_feedback: 前回失敗時のエラー理由（リトライ時に渡される）"""
    req_id = req["requestId"]
    target = req["targetFile"]
    instruction = req["instruction"]

    # 重複実行防止: 同一案件（同じinstruction内容）への17秒以内の連続実行をスキップ
    # ※別案件や失敗分析後の正当な再実行はスキップしない
    import time as _time
    now = _time.time()
    inst_hash = _instruction_hash(instruction)
    if inst_hash in _last_exec and now - _last_exec[inst_hash] < 17:
        elapsed = now - _last_exec[inst_hash]
        print(f"[daemon] 重複スキップ: {req_id} (同一案件[{inst_hash}]へ{elapsed:.0f}秒以内)")
        # 結果ファイルを書いてからスキップ（HTMLのポーリングがpendingのまま止まるのを防ぐ）
        skip_result = {
            "requestId": req_id, "targetFile": target, "success": False, "file_changed": False,
            "audit": {"passed": False, "reason": f"重複スキップ: 同一案件へ{elapsed:.0f}秒以内の連続実行"},
            "output": "重複実行防止でスキップ", "error": "",
            "completedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        }
        skip_file = CODE_RESULT_DIR / f"{req_id}_result.json"
        skip_file.write_text(json.dumps(skip_result, ensure_ascii=False, indent=2), encoding="utf-8")
        _processed.add(req_id)
        return False
    _last_exec[inst_hash] = now
    if error_feedback:
        instruction += f"\n\n【前回の修正が失敗した理由】\n{error_feedback}\nこの問題を回避して修正してください。"
    target_path = BRIDGE_DIR / target

    # status が 'reverted' の場合は処理をスキップ
    if req.get("status") == "reverted":
        print(f"[daemon] スキップ（reverted）: {req_id}")
        _processed.add(req_id)
        return False

    # 差し戻し処理
    if req.get("type") == "return":
        print(f"[daemon] 差し戻し実行: {req_id} → {target}")
        try:
            # バックアップから復元
            backup_file = BRIDGE_DIR / f"{target}.backup"
            if backup_file.exists():
                backup_content = backup_file.read_text(encoding="utf-8")
                target_path.write_text(backup_content, encoding="utf-8")
                print(f"[daemon] 差し戻し完了: {req_id}")
                
                # 結果保存
                result_data = {
                    "requestId": req_id,
                    "targetFile": target,
                    "success": True,
                    "file_changed": True,
                    "audit": {"passed": True, "reason": "差し戻し処理完了"},
                    "output": "バックアップから復元完了",
                    "error": "",
                    "completedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                }
                result_file = CODE_RESULT_DIR / f"{req_id}_result.json"
                result_file.write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
                
                # 処理済みに移動
                try:
                    req["meta_file"].rename(DONE_DIR / req["meta_file"].name)
                    req["md_file"].rename(DONE_DIR / req["md_file"].name)
                    if req.get("img_file") and req["img_file"].exists():
                        req["img_file"].rename(DONE_DIR / req["img_file"].name)
                except Exception:
                    pass
                
                _processed.add(req_id)
                return True
            else:
                print(f"[daemon] バックアップファイルが存在しません: {backup_file}")
                _processed.add(req_id)
                return False
        except Exception as e:
            print(f"[daemon] 差し戻しエラー: {req_id} - {e}")
            _processed.add(req_id)
            return False

    print(f"[daemon] 実行開始: {req_id} → {target}")

    # 修正前のファイル内容を保存
    before_content = get_file_content(target_path)
    before_mtime = target_path.stat().st_mtime if target_path.exists() else 0

    try:
        # Step 1: Claude APIで編集内容を生成
        print(f"[daemon] Claude APIで編集生成中...")
        images = req.get("images", [])
        edit = generate_edit(target, instruction, before_content, images)

        # edit は [{"old_string":..., "new_string":...}, ...] のリスト
        if not edit:
            output = "編集指示の生成に失敗（JSON抽出不可）"
            audit = {"passed": False, "reason": output}
        else:
            # 括弧バランスチェック+自動補完
            # old_stringとnew_stringの差分で括弧バランスが崩れてないかチェック
            for e in edit:
                os_ = e.get("old_string", "")
                ns = e.get("new_string", "")
                # old_stringの括弧バランス（これが置換されるので差分を見る）
                old_braces = os_.count('{') - os_.count('}')
                new_braces = ns.count('{') - ns.count('}')
                old_parens = os_.count('(') - os_.count(')')
                new_parens = ns.count('(') - ns.count(')')
                # new_stringはold_stringと同じバランスであるべき
                brace_diff = new_braces - old_braces
                paren_diff = new_parens - old_parens
                fixed = False
                if brace_diff > 0:
                    ns += '\n' + '}\n' * brace_diff
                    fixed = True
                if paren_diff > 0:
                    ns += ')' * paren_diff
                    fixed = True
                if fixed:
                    e["new_string"] = ns
                    print(f"[daemon] 括弧補完: 波括弧差{brace_diff}, 丸括弧差{paren_diff}")
            # edit適用前: new_string内のJS関数をNode.jsで構文チェック
            if target.endswith('.html'):
                for e in edit:
                    ns = e.get("new_string", "")
                    # JS関数が含まれてるか判定
                    if 'function ' in ns or 'async function' in ns:
                        js_error = _check_js_syntax(ns)
                        if js_error:
                            print(f"[daemon] JS構文チェック: NG → {js_error}")
                            # 括弧補完を試みる
                            fixed_ns = ns
                            for _ in range(3):
                                ob = fixed_ns.count('{') - fixed_ns.count('}')
                                op = fixed_ns.count('(') - fixed_ns.count(')')
                                if ob > 0:
                                    fixed_ns += '\n' + '}\n' * ob
                                if op > 0:
                                    fixed_ns += ')' * op
                                err2 = _check_js_syntax(fixed_ns)
                                if not err2:
                                    e["new_string"] = fixed_ns
                                    print(f"[daemon] JS構文チェック: 括弧補完で修復OK")
                                    break
                            else:
                                print(f"[daemon] JS構文チェック: 修復不可 → 監査で判定")
            # edit適用前の構文チェック（HTML/JSの場合、仮適用して括弧バランスを検証）
            if target.endswith('.html'):
                for retry_gen in range(2):
                    # 仮適用して全体の括弧バランスをチェック
                    test_content = before_content
                    for e in edit:
                        test_content = test_content.replace(e["old_string"], e["new_string"], 1)
                    test_open = test_content.count('{')
                    test_close = test_content.count('}')
                    test_popen = test_content.count('(')
                    test_pclose = test_content.count(')')
                    brace_ok = abs(test_open - test_close) <= 2
                    paren_ok = abs(test_popen - test_pclose) <= 2
                    if brace_ok and paren_ok:
                        print(f"[daemon] 構文プリチェック: OK (波{test_open}/{test_close} 丸{test_popen}/{test_pclose})")
                        break
                    if retry_gen == 0:
                        print(f"[daemon] 構文プリチェック: NG (波{test_open}/{test_close} 丸{test_popen}/{test_pclose}) → 再生成")
                        edit = generate_edit(target, instruction, before_content, images)
                        if not edit:
                            break
                        # 括弧補完を再適用
                        for e in edit:
                            os_ = e.get("old_string", "")
                            ns = e.get("new_string", "")
                            bd = (ns.count('{') - ns.count('}')) - (os_.count('{') - os_.count('}'))
                            pd = (ns.count('(') - ns.count(')')) - (os_.count('(') - os_.count(')'))
                            if bd > 0:
                                e["new_string"] = ns + '\n' + '}\n' * bd
                            if pd > 0:
                                e["new_string"] = e["new_string"] + ')' * pd
                    else:
                        print(f"[daemon] 構文プリチェック: 再生成後もNG → そのまま適用（監査で判定）")

            # バックアップ作成（初回修正時のみ）
            backup_file = BRIDGE_DIR / f"{target}.backup"
            if not backup_file.exists() and before_content:
                backup_file.write_text(before_content, encoding="utf-8")
                print(f"[daemon] バックアップ作成: {backup_file}")

            # ═══ 保護関数ガード: 保護対象の関数を書き換えるeditは拒否 ═══
            PROTECTED_FUNCTIONS = [
                "handleMainInput",
                "checkDaemonStatus",
                "checkServerHealth",
                "checkLauncherStatus",
                "updateRecoveryBar",
                "recoverAll",
                "renderSessionList",
                "toggleDevMode",
                "executeCodeFix",
                "callAI",
                "buildMeetingSystemPrompt",
                "stripDiagnosisBlock",
                "appendChatLog",
                "appendMinutes",
            ]
            protected_edit = []
            for i, e in enumerate(edit):
                old = e.get("old_string", "")
                for pf in PROTECTED_FUNCTIONS:
                    if f"function {pf}" in old or f"async function {pf}" in old:
                        print(f"[daemon] *** 保護関数ガード発動: edit {i+1} が保護関数 {pf}() を書き換えようとした → 拒否 ***")
                        protected_edit.append((i, pf))
                        break
            if protected_edit:
                rejected = [f"{pf}()" for _, pf in protected_edit]
                print(f"[daemon] 保護関数 {', '.join(rejected)} への書き換えを全拒否。ロールバック。")
                result_data = {
                    "requestId": req_id,
                    "targetFile": target,
                    "success": False,
                    "file_changed": False,
                    "audit": {"passed": False, "reason": f"保護関数ガード: {', '.join(rejected)} は書き換え禁止"},
                    "output": f"保護関数{', '.join(rejected)}への書き換えを拒否",
                    "error": "",
                    "completedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                }
                result_file = CODE_RESULT_DIR / f"{req_id}_result.json"
                result_file.write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
                _processed.add(req_id)
                return False

            # ═══ HTML部分へのJS挿入ガード: <script>タグ外にfunctionやconstを挿入しようとしたら拒否 ═══
            current_content_check = get_file_content(target_path)
            script_start = current_content_check.find('<script>')
            script_end = current_content_check.rfind('</script>')
            html_inject = []
            for i, e in enumerate(edit):
                old = e.get("old_string", "")
                new = e.get("new_string", "")
                if old in current_content_check:
                    old_pos = current_content_check.find(old)
                    # old_stringが<script>外（HTML部分）にある場合、JSコード挿入を検知
                    if old_pos < script_start or old_pos > script_end:
                        if re.search(r'\bfunction\s+\w+|^\s*const\s+|^\s*let\s+|^\s*var\s+', new, re.MULTILINE):
                            html_inject.append(i)
                            print(f"[daemon] *** HTML部分JSインジェクション検知: edit {i+1} がHTML部分にJSコードを挿入 → 拒否 ***")
            if html_inject:
                print(f"[daemon] HTML部分へのJS挿入を{len(html_inject)}件拒否。")
                # 該当editだけ除去
                edit = [e for i, e in enumerate(edit) if i not in html_inject]
                if not edit:
                    result_data = {
                        "requestId": req_id, "targetFile": target, "success": False, "file_changed": False,
                        "audit": {"passed": False, "reason": "HTML部分へのJavaScriptコード挿入を拒否"},
                        "output": "HTML部分にJSコードを挿入しようとしたため拒否", "error": "",
                        "completedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                    }
                    result_file = CODE_RESULT_DIR / f"{req_id}_result.json"
                    result_file.write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
                    _processed.add(req_id)
                    return False

            # Step 2: old_stringプリチェック + fuzzy match自動修正 + /api/file/edit で適用
            current_content = get_file_content(target_path)
            valid_edits = []
            for i, e in enumerate(edit):
                if e["old_string"] in current_content:
                    valid_edits.append(e)
                else:
                    # fuzzy match: old_stringに最も近い行ブロックをファイルから探す
                    corrected = _fuzzy_find_old_string(e["old_string"], current_content)
                    if corrected:
                        print(f"[daemon]   edit {i+1}/{len(edit)}: old_string不在 → fuzzy match で修正")
                        original_old = e["old_string"]
                        e["old_string"] = corrected
                        # new_string内のold部分も同期修正（old→correctedに置換）
                        if original_old in e["new_string"]:
                            e["new_string"] = e["new_string"].replace(original_old, corrected, 1)
                        valid_edits.append(e)
                    else:
                        print(f"[daemon]   edit {i+1}/{len(edit)}: old_stringがファイル内に不在 → スキップ")
            if not valid_edits and edit:
                print(f"[daemon] 全editのold_stringが不在 → 失敗として処理")
                output = f"適用: 0/{len(edit)}件成功 / 失敗: 全editのold_stringがファイル内に存在しない"
                audit = {"passed": False, "reason": f"全editのold_stringがファイル内に不在（{len(edit)}件全滅）。AIが生成したold_stringが実際のファイル内容と一致していない"}
                result_data = {
                    "requestId": req_id, "targetFile": target, "success": False, "file_changed": False,
                    "audit": audit, "output": output, "error": "",
                    "completedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                }
                result_file = CODE_RESULT_DIR / f"{req_id}_result.json"
                result_file.write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
                _processed.add(req_id)
                # リトライに回すためFalseを返す（poll_loopがリトライキューに追加）
                return False
            edit = valid_edits

            # ═══ dry-run: 仮適用して構文チェック（実ファイルに触らない） ═══
            dry_err = _dry_run_edits(edit, target, current_content)
            if dry_err:
                print(f"[daemon] dry-run NG: {dry_err}")
                # 1回だけ再生成を試みる
                print(f"[daemon] dry-run失敗 → 再生成を試行")
                edit2 = generate_edit(target, instruction + f"\n\n【前回のdry-run失敗理由】{dry_err}\nこの問題を回避して修正してください。", before_content, images)
                if edit2:
                    # 再生成版もold_stringチェック
                    valid2 = []
                    for ie, e2 in enumerate(edit2):
                        if e2["old_string"] in current_content:
                            valid2.append(e2)
                        else:
                            stripped2 = _strip_line_numbers(e2["old_string"])
                            if stripped2 and stripped2 in current_content:
                                e2["old_string"] = stripped2
                                valid2.append(e2)
                    if valid2:
                        dry_err2 = _dry_run_edits(valid2, target, current_content)
                        if not dry_err2:
                            edit = valid2
                            print(f"[daemon] dry-run再生成OK: {len(edit)}件")
                        else:
                            print(f"[daemon] dry-run再生成もNG: {dry_err2} → 失敗処理")
                            result_data = {
                                "requestId": req_id, "targetFile": target, "success": False, "file_changed": False,
                                "audit": {"passed": False, "reason": f"dry-run構文チェック不合格: {dry_err2}"},
                                "output": f"dry-runで構文エラー検出。再生成後も不合格: {dry_err2}", "error": "",
                                "completedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                            }
                            result_file = CODE_RESULT_DIR / f"{req_id}_result.json"
                            result_file.write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
                            _processed.add(req_id)
                            return False
                else:
                    print(f"[daemon] dry-run失敗+再生成も失敗 → 失敗処理")
                    result_data = {
                        "requestId": req_id, "targetFile": target, "success": False, "file_changed": False,
                        "audit": {"passed": False, "reason": f"dry-run構文チェック不合格: {dry_err}"},
                        "output": f"dry-runで構文エラー検出: {dry_err}", "error": "",
                        "completedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                    }
                    result_file = CODE_RESULT_DIR / f"{req_id}_result.json"
                    result_file.write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
                    _processed.add(req_id)
                    return False
            else:
                print(f"[daemon] dry-run OK")

            print(f"[daemon] file/edit適用中... ({len(edit)}件)")
            applied = 0
            failed_edits = []
            for i, e in enumerate(edit):
                try:
                    edit_payload = {
                        "filename": target,
                        "old_string": e["old_string"],
                        "new_string": e["new_string"],
                    }
                    edit_data = json.dumps(edit_payload, ensure_ascii=False).encode("utf-8")
                    print(f"[daemon]   edit {i+1}: old={len(e['old_string'])}chars, new={len(e['new_string'])}chars, json={len(edit_data)}bytes")
                    print(f"[daemon]   edit {i+1} old_string: {repr(e['old_string'][:100])}")
                    print(f"[daemon]   edit {i+1} new_string first 200: {repr(e['new_string'][:200])}")
                    print(f"[daemon]   edit {i+1} new_string last 200: {repr(e['new_string'][-200:])}")
                    edit_req = Request(
                        f"{SERVER_URL}/api/file/edit",
                        method="POST",
                        headers={"Content-Type": "application/json"},
                        data=edit_data,
                    )
                    edit_res = urlopen(edit_req, timeout=10)
                    edit_result = json.loads(edit_res.read().decode("utf-8"))
                    if edit_result.get("status") == "ok":
                        applied += 1
                        print(f"[daemon]   edit {i+1}/{len(edit)}: OK")
                    else:
                        failed_edits.append(f"edit{i+1}: {edit_result.get('error','?')}")
                        print(f"[daemon]   edit {i+1}/{len(edit)}: FAIL - {edit_result.get('error','')}")
                except Exception as ex:
                    failed_edits.append(f"edit{i+1}: {ex}")
                    print(f"[daemon]   edit {i+1}/{len(edit)}: ERROR - {ex}")

            output = f"適用: {applied}/{len(edit)}件成功"
            if failed_edits:
                output += f" / 失敗: {', '.join(failed_edits)}"

        # 修正後のファイル内容を取得
        after_content = get_file_content(target_path)
        after_mtime = target_path.stat().st_mtime if target_path.exists() else 0
        file_changed = (after_mtime > before_mtime) and (before_content != after_content)

        # ── 監査 ──
        if file_changed:
            # AI提案コードから直接生成+構文プリチェックOKの場合は構文チェックのみ（AI監査スキップ）
            is_proposed = any(e.get("_from_proposed") or '// __CODE_FIX_ANCHOR__' in e.get("old_string", "") for e in edit) if edit else False
            if is_proposed:
                # AI提案コード直接適用 → 構文チェックのみで合格（監査AI不要）
                syntax_pass = True
                if target.endswith('.html'):
                    after = get_file_content(target_path)
                    ob = after.count('{'); cb = after.count('}')
                    op = after.count('('); cp = after.count(')')
                    syntax_pass = abs(ob - cb) <= 2 and abs(op - cp) <= 2
                    check_detail = f"波{ob}/{cb} 丸{op}/{cp}"
                elif target.endswith('.py'):
                    try:
                        compile(get_file_content(target_path), str(target_path), 'exec')
                        check_detail = "Python compile OK"
                    except SyntaxError as se:
                        syntax_pass = False
                        check_detail = f"Python構文エラー: {se.msg} (行{se.lineno})"
                else:
                    check_detail = "構文チェック対象外"
                if syntax_pass:
                    audit = {"passed": True, "reason": f"AI提案コード直接適用+構文OK ({check_detail})"}
                    print(f"[daemon] AI提案コード直接適用 → 構文チェックのみで合格")
                else:
                    audit = {"passed": False, "reason": f"AI提案コード直接適用+構文NG ({check_detail})"}
                    print(f"[daemon] AI提案コード直接適用 → 構文NG")
            else:
                print(f"[daemon] 修正検知 → 監査開始: {req_id}")
                audit = audit_fix(req_id, target, instruction, before_content, after_content, output)
        elif not edit:
            pass  # audit already set above
        else:
            audit = {"passed": False, "reason": f"編集適用後もファイル変更なし: {output}"}

        success = audit.get("passed", False)
        print(f"[daemon] 監査結果: {'合格' if success else '不合格'} -{audit.get('reason', '')}")

        # 構文チェック（Python/HTMLファイルが壊れてないか）
        if success and file_changed:
            syntax_ok = True
            if target.endswith('.py'):
                try:
                    result = subprocess.run(
                        [sys.executable, '-c', f'import importlib.util; spec = importlib.util.spec_from_file_location("test", r"{target_path}"); importlib.util.module_from_spec(spec)'],
                        capture_output=True, text=True, timeout=10, cwd=str(BRIDGE_DIR)
                    )
                    # 簡易チェック: compileだけ
                    compile(get_file_content(target_path), str(target_path), 'exec')
                    print(f"[daemon] 構文チェック: Python OK")
                except SyntaxError as se:
                    syntax_ok = False
                    audit = {"passed": False, "reason": f"構文エラー: {se.msg} (行{se.lineno})"}
                    print(f"[daemon] 構文チェック: Python NG - {se}")
                except Exception as e:
                    print(f"[daemon] 構文チェック: 警告 - {e}")
            elif target.endswith('.html'):
                # HTMLはscriptタグ内のJSをチェック（簡易: 括弧の対応）
                after = get_file_content(target_path)
                open_braces = after.count('{')
                close_braces = after.count('}')
                if abs(open_braces - close_braces) > 2:
                    syntax_ok = False
                    audit = {"passed": False, "reason": f"HTML構文疑い: 波括弧の不一致 ({open_braces}開 vs {close_braces}閉)"}
                    print(f"[daemon] 構文チェック: HTML NG - 波括弧不一致")
                else:
                    print(f"[daemon] 構文チェック: HTML OK")

            if not syntax_ok:
                success = False

        # 不合格でファイルが変わってたら元に戻す
        if not success and file_changed:
            print(f"[daemon] 不合格のためロールバック: {req_id}")
            target_path.write_text(before_content, encoding="utf-8")

        # 結果保存
        result_data = {
            "requestId": req_id,
            "targetFile": target,
            "success": success,
            "file_changed": file_changed,
            "audit": audit,
            "output": output[:5000],
            "error": "",
            "completedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        result_file = CODE_RESULT_DIR / f"{req_id}_result.json"
        result_file.write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
        _record_fix_history(result_data, instruction)

        # 処理済みに移動
        try:
            req["meta_file"].rename(DONE_DIR / req["meta_file"].name)
            req["md_file"].rename(DONE_DIR / req["md_file"].name)
            if req.get("img_file") and req["img_file"].exists():
                req["img_file"].rename(DONE_DIR / req["img_file"].name)
        except Exception:
            pass

        _processed.add(req_id)

        # server.py に完了報告（監査結果付き）
        try:
            report = Request(
                f"{SERVER_URL}/api/code/result",
                method="POST",
                headers={"Content-Type": "application/json"},
                data=json.dumps({
                    "requestId": req_id,
                    "status": "completed" if success else "audit_failed",
                    "audit": audit,
                    "file_changed": file_changed,
                    "output": output[:2000],
                }).encode("utf-8"),
            )
            urlopen(report, timeout=5)
        except Exception:
            pass

        status = "成功" if success else "失敗"
        print(f"[daemon] 実行{status}: {req_id}")

        # 自分自身（Python側）を修正した場合 → launcher経由で自動再起動
        if success and file_changed and target in ('cmd_daemon.py', 'server.py', 'launcher.py'):
            print(f"[daemon] ⚠️ {target}を修正 → launcher経由で再起動リクエスト")
            try:
                if target in ('cmd_daemon.py',):
                    url = "http://localhost:5001/restart-daemon"
                elif target == 'server.py':
                    url = "http://localhost:5001/restart-server"
                else:
                    url = "http://localhost:5001/start-all"
                restart_req = Request(url, method="POST",
                    headers={"Content-Type": "application/json"}, data=b'{}')
                urlopen(restart_req, timeout=5)
                print(f"[daemon] 再起動リクエスト送信完了")
            except Exception as e:
                print(f"[daemon] 再起動リクエスト失敗（手動再起動が必要）: {e}")

        return success

    except subprocess.TimeoutExpired:
        print(f"[daemon] タイムアウト: {req_id}")
        _processed.add(req_id)
        return False
    except Exception as e:
        print(f"[daemon] エラー: {req_id} -{e}")
        _processed.add(req_id)
        return False


def find_identify_requests():
    """未処理のidentifyリクエスト（画像UI特定）を探す"""
    requests = []
    for req_file in CODE_REQ_DIR.glob("*.json"):
        if req_file.name.endswith("_meta.json"):
            continue
        try:
            data = json.loads(req_file.read_text(encoding="utf-8"))
            if data.get("type") != "identify" or data.get("status") != "pending":
                continue
            req_id = data.get("requestId", "")
            if not req_id or req_id in _processed:
                continue
            requests.append(data)
        except Exception:
            continue
    return requests


def process_identify(req):
    """画像からUI要素を特定してcode_fixまで一気通貫で処理"""
    req_id = req["requestId"]
    _processed.add(req_id)
    print(f"[daemon] 画像特定開始: {req_id}")

    user_text = req.get("userText", "")
    target_file = req.get("targetFile", "os_for_human_pipeline_v3.html")
    image_paths = req.get("imagePaths", [])

    # 画像をbase64で読む
    import base64
    images_b64 = []
    for p in image_paths:
        try:
            with open(p, "rb") as f:
                images_b64.append(base64.b64encode(f.read()).decode("utf-8"))
        except Exception as e:
            print(f"[daemon] 画像読み込み失敗: {p} - {e}")

    # 対象ファイルの内容を取得
    target_path = BRIDGE_DIR / target_file
    file_content = get_file_content(target_path)
    lines = file_content.splitlines()

    # 全関数一覧
    import re
    funcs = [m.group(1) for m in re.finditer(r'(?:async\s+)?function\s+(\w+)\s*\(', file_content)]

    # HTML要素（id/onclick付き）
    elements = []
    for i, line in enumerate(lines):
        if 'onclick=' in line or 'id=' in line:
            elements.append(f"行{i+1}: {line.strip()[:120]}")

    # ヘッダー周辺のボタン一覧（AIの誤判定防止用）
    header_buttons = []
    for i, line in enumerate(lines):
        if i < 400 and ('btn-header' in line or 'onclick=' in line):
            header_buttons.append(f"行{i+1}: {line.strip()[:150]}")

    prompt = f"""あなたはUI特定エンジンです。ユーザーが送ったスクリーンショットの中のUI要素を特定し、対応するコードを見つけてください。

【ユーザーの指示】{user_text}

【対象ファイル】{target_file}（{len(lines)}行）

【v3.htmlのヘッダー部分のボタン一覧（スクショがヘッダー付近なら必ずここから選べ）】
{chr(10).join(header_buttons)}

【重要な注意】
- 🔧アイコン（レンチ）はopacity:0.3で非常に薄い。「スピナー」「ローディング」「骨」ではない。レンチ（工具）アイコン
- ⚙アイコンはAPI設定ボタン
- ヘッダー右側には: ステータスドット(3つ) / 会議番号 / 利用額 / ⚙API設定 / 🔧DevMode の順で並んでいる

【全関数({len(funcs)}個)】{', '.join(funcs[:50])}

【onclick/id付きHTML要素（抜粋）】
{chr(10).join(elements[:40])}

【タスク】
1. スクリーンショットに映っているUI要素を特定しろ（ボタン、アイコン、テキスト等）
2. 上記のヘッダーボタン一覧・要素リストから該当するHTML行を見つけろ
3. onclick先の関数名を特定しろ
4. 「動かない」「反応しない」場合、その関数の中身を確認しろ（存在するか、エラーがないか）
5. 修正が必要なら具体的な修正コードを書け（視覚的フィードバックがないなら追加しろ）

以下のJSON形式で回答（これ以外出力禁止）:
{{"screenState": "画面の状態（1文）", "visibleText": "映っているテキスト", "userIntent": "ユーザーが何をしたいか", "suggestedAction": "推奨アクション", "matched": "特定した要素（行番号+コード）", "targetFunc": "対象関数名", "fixCode": "修正コード（不要ならnull）"}}"""

    try:
        answer = call_ai_api("UI特定エンジン。JSON以外出力禁止。", prompt, images_b64 if images_b64 else None)
        print(f"[daemon] 画像特定応答: {answer[:200]}")

        # JSON抽出
        code_block = re.search(r'```(?:json)?\s*\n([\s\S]*?)\n```', answer)
        json_text = code_block.group(1) if code_block else answer
        m = re.search(r'\{[\s\S]*\}', json_text)
        if m:
            result = json.loads(m.group())
        else:
            result = {"screenState": "解析失敗", "suggestedAction": answer[:200]}

        # 結果をcode_results/に保存
        result["requestId"] = req_id
        result["status"] = "completed"
        result_file = CODE_RESULT_DIR / f"{req_id}_identify_result.json"
        result_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

        # code_requestsの元ファイルをcompletedに更新
        req_file = CODE_REQ_DIR / f"{req_id}.json"
        if req_file.exists():
            req["status"] = "completed"
            req_file.write_text(json.dumps(req, ensure_ascii=False, indent=2), encoding="utf-8")

        print(f"[daemon] 画像特定完了: {req_id} → {result.get('matched', '不明')[:80]}")

        # fixCodeがあればcode_fixとして自動実行
        fix_code = result.get("fixCode")
        if fix_code and fix_code != "null" and len(fix_code) > 10:
            print(f"[daemon] 画像特定からcode_fix自動実行: {req_id}")
            # code_fixリクエストとして処理
            fix_instruction = f"【画像特定結果に基づく修正】\n対象: {result.get('matched', '不明')}\n関数: {result.get('targetFunc', '不明')}\n修正内容: {result.get('suggestedAction', '')}\n\n```javascript\n{fix_code}\n```"
            fix_req = {
                "requestId": f"{req_id}_fix",
                "targetFile": target_file,
                "instruction": fix_instruction,
                "images": [],
            }
            execute_request(fix_req)

        return True
    except Exception as e:
        print(f"[daemon] 画像特定エラー: {req_id} - {e}")
        result_file = CODE_RESULT_DIR / f"{req_id}_identify_result.json"
        result_file.write_text(json.dumps({
            "requestId": req_id, "status": "error",
            "screenState": f"エラー: {e}", "suggestedAction": "再試行してください"
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        return False


def poll_loop():
    """メインポーリングループ（失敗時はエラーフィードバック付きリトライ最大3回）"""
    _retry_queue = []  # [(req, error_feedback, retry_count)]
    while True:
        try:
            # identifyリクエスト（画像UI特定）の処理
            for iq in find_identify_requests():
                process_identify(iq)

            # リトライキューの処理
            new_retry = []
            for req, feedback, count in _retry_queue:
                if count >= 3:
                    print(f"[daemon] リトライ上限到達: {req['requestId']}")
                    _processed.add(req["requestId"])
                    continue
                # _processedを一時的に解除してリトライ
                _processed.discard(req["requestId"])
                result = execute_request(req, error_feedback=feedback)
                if not result:
                    # 失敗結果から理由を取得
                    result_file = CODE_RESULT_DIR / f"{req['requestId']}_result.json"
                    reason = ""
                    if result_file.exists():
                        try:
                            rdata = json.loads(result_file.read_text(encoding="utf-8"))
                            reason = rdata.get("audit", {}).get("reason", "")
                        except Exception:
                            pass
                    new_retry.append((req, reason, count + 1))
            _retry_queue = new_retry

            # 新規リクエストの処理
            requests = find_new_requests()
            for req in requests:
                result = execute_request(req)
                if not result:
                    # 失敗結果から理由を取得してリトライキューに追加
                    result_file = CODE_RESULT_DIR / f"{req['requestId']}_result.json"
                    reason = ""
                    if result_file.exists():
                        try:
                            rdata = json.loads(result_file.read_text(encoding="utf-8"))
                            reason = rdata.get("audit", {}).get("reason", "")
                        except Exception:
                            pass
                    if reason and "JSON抽出不可" not in reason:
                        _retry_queue.append((req, reason, 1))
                        print(f"[daemon] リトライキューに追加: {req['requestId']} (理由: {reason[:80]})")
        except Exception as e:
            print(f"[daemon] ポーリングエラー: {e}")
        time.sleep(3)


def main():
    print("=" * 50)
    print("  OS_FOR_HUMAN CMD Daemon")
    print(f"  監視先: {CODE_REQ_DIR}")
    print("=" * 50)

    # 既に done/ にあるリクエストIDを処理済みに登録
    # resultファイルが無い場合は「未完了」として生成（HTMLのポーリング解放用）
    orphan_count = 0
    for f in DONE_DIR.glob("*_meta.json"):
        try:
            meta = json.loads(f.read_text(encoding="utf-8"))
            req_id = meta.get("requestId", "")
            if req_id:
                _processed.add(req_id)
                result_file = CODE_RESULT_DIR / f"{req_id}_result.json"
                if not result_file.exists():
                    result_file.write_text(json.dumps({
                        "requestId": req_id,
                        "status": "done",
                        "success": False,
                        "summary": "daemon再起動により処理が中断されました",
                        "audit": {"passed": False, "reason": "daemon再起動による中断"},
                        "files_changed": [],
                        "completedAt": datetime.datetime.now().isoformat(),
                    }, ensure_ascii=False, indent=2), encoding="utf-8")
                    orphan_count += 1
        except Exception:
            pass
    print(f"  処理済み: {len(_processed)}件 (孤立result補完: {orphan_count}件)")

    # 生存報告スレッド
    threading.Thread(target=ping_server, daemon=True).start()

    # ポーリングループ
    try:
        poll_loop()
    except KeyboardInterrupt:
        print("\n[daemon] 停止")


if __name__ == "__main__":
    main()
