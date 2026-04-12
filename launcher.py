"""
OS_FOR_HUMAN Launcher — port 5001
server.py が死んでも生きている別経路。
server.py の起動/再起動/状態確認を提供する。
起動時に server.py も自動で立ち上げる。
"""

import os
import sys
import json
import time
import signal
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import urlopen
from pathlib import Path

BRIDGE_DIR = Path(__file__).parent
SERVER_SCRIPT = BRIDGE_DIR / "server.py"
SERVER_PORT = 5000
LAUNCHER_PORT = 5001
# claude -p は使わない（cmd_daemon.pyがClaude API方式で実行）

# server.py のプロセス参照
_server_proc = None
_server_lock = threading.Lock()


def is_server_alive():
    """server.py が応答するか確認"""
    try:
        res = urlopen(f"http://localhost:{SERVER_PORT}/api/server/ping", timeout=3)
        return res.status == 200
    except Exception:
        return False


def start_server():
    """server.py を起動する（既に起動中なら何もしない）"""
    global _server_proc
    with _server_lock:
        if is_server_alive():
            return {"status": "already_running"}

        # 残存プロセスがあれば終了
        if _server_proc and _server_proc.poll() is None:
            try:
                _server_proc.terminate()
                _server_proc.wait(timeout=5)
            except Exception:
                pass

        try:
            _server_proc = subprocess.Popen(
                [sys.executable, str(SERVER_SCRIPT)],
                cwd=str(BRIDGE_DIR),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )

            # 起動待ち（最大15秒）
            for _ in range(30):
                time.sleep(0.5)
                if is_server_alive():
                    return {"status": "started", "pid": _server_proc.pid}

            return {"status": "timeout", "error": "server.py が15秒以内に応答しなかった"}
        except Exception as e:
            return {"status": "error", "error": str(e)}


def restart_server():
    """server.py を再起動する"""
    global _server_proc
    with _server_lock:
        # 既存プロセスを停止
        if _server_proc and _server_proc.poll() is None:
            try:
                _server_proc.terminate()
                _server_proc.wait(timeout=5)
            except Exception:
                try:
                    _server_proc.kill()
                except Exception:
                    pass

        # /api/server/restart を試す（プロセス参照がない場合）
        if is_server_alive():
            try:
                urlopen(f"http://localhost:{SERVER_PORT}/api/server/restart", timeout=5)
                time.sleep(2)
            except Exception:
                pass

    # start_server で新規起動
    return start_server()


def get_status():
    """server.py + CMDデーモンの状態を返す"""
    alive = is_server_alive()
    pid = _server_proc.pid if (_server_proc and _server_proc.poll() is None) else None
    daemon = is_daemon_alive()
    daemon_pid = _daemon_proc.pid if (_daemon_proc and _daemon_proc.poll() is None) else None
    return {
        "server_alive": alive,
        "server_pid": pid,
        "daemon_alive": daemon,
        "daemon_pid": daemon_pid,
        "launcher_pid": os.getpid(),
    }


# ─── CMDデーモン（Claude Code常駐）管理 ───
_daemon_proc = None
_daemon_lock = threading.Lock()


def is_daemon_alive():
    """CMDデーモンが生きてるか（server.py経由で確認）"""
    try:
        res = urlopen(f"http://localhost:{SERVER_PORT}/api/daemon/status", timeout=3)
        data = json.loads(res.read().decode("utf-8"))
        return data.get("alive", False)
    except Exception:
        return False


DAEMON_PID_FILE = BRIDGE_DIR / "logs" / "daemon.pid"


def _kill_old_daemon():
    """PIDファイルから旧daemonプロセスを確実に殺す"""
    if DAEMON_PID_FILE.exists():
        try:
            old_pid = int(DAEMON_PID_FILE.read_text().strip())
            import signal
            os.kill(old_pid, signal.SIGTERM)
            print(f"[launcher] 旧daemon(PID={old_pid})をkill")
            time.sleep(1)
        except (ProcessLookupError, ValueError, OSError):
            pass
        try:
            DAEMON_PID_FILE.unlink()
        except Exception:
            pass


def start_daemon():
    """Claude Code対話モードをCMDで常駐起動する"""
    global _daemon_proc
    with _daemon_lock:
        if is_daemon_alive():
            return {"status": "already_running"}

        # 旧プロセスを確実に殺す（PIDファイル + プロセス参照の両方）
        _kill_old_daemon()
        if _daemon_proc and _daemon_proc.poll() is None:
            try:
                _daemon_proc.terminate()
                _daemon_proc.wait(timeout=5)
            except Exception:
                try:
                    _daemon_proc.kill()
                except Exception:
                    pass

        try:
            # claude コマンドで対話モード起動 + code_requests ポーリング
            daemon_script = BRIDGE_DIR / "cmd_daemon.py"
            if not daemon_script.exists():
                return {"status": "error", "error": "cmd_daemon.py が見つかりません"}
            daemon_log = BRIDGE_DIR / "logs" / "daemon.log"
            daemon_log.parent.mkdir(exist_ok=True)
            _daemon_log_fh = open(str(daemon_log), "a", encoding="utf-8")
            _daemon_proc = subprocess.Popen(
                [sys.executable, "-u", str(daemon_script)],
                cwd=str(BRIDGE_DIR),
                stdout=_daemon_log_fh,
                stderr=_daemon_log_fh,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            # PIDファイルに記録
            DAEMON_PID_FILE.parent.mkdir(exist_ok=True)
            DAEMON_PID_FILE.write_text(str(_daemon_proc.pid))

            # 起動待ち（最大10秒）
            for _ in range(20):
                time.sleep(0.5)
                if _daemon_proc.poll() is not None:
                    return {"status": "error", "error": f"デーモンが即終了 (exit={_daemon_proc.returncode})"}
                if is_daemon_alive():
                    return {"status": "started", "pid": _daemon_proc.pid}

            # プロセスは生きてるがdaemon/statusがまだaliveにならない場合
            if _daemon_proc.poll() is None:
                return {"status": "started_no_ping", "pid": _daemon_proc.pid,
                        "note": "プロセスは起動したがdaemon pingはまだ未到達"}
            return {"status": "timeout", "error": "デーモンが10秒以内に応答しなかった"}
        except FileNotFoundError:
            return {"status": "error", "error": "claudeコマンドが見つかりません。Claude Codeをインストールしてください"}
        except Exception as e:
            return {"status": "error", "error": str(e)}


class LauncherHandler(BaseHTTPRequestHandler):
    """CORSフル許可の小さいHTTPハンドラ"""

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json_response(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/status":
            self._json_response(get_status())
        elif self.path == "/ping":
            self._json_response({"status": "ok", "launcher": True})
        else:
            self._json_response({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/start":
            result = start_server()
            code = 200 if result["status"] in ("started", "already_running") else 500
            self._json_response(result, code)
        elif self.path == "/restart":
            result = restart_server()
            code = 200 if result["status"] in ("started", "already_running") else 500
            self._json_response(result, code)
        elif self.path == "/daemon/start":
            result = start_daemon()
            code = 200 if result["status"] in ("started", "already_running", "started_no_ping") else 500
            self._json_response(result, code)
        elif self.path == "/start-all":
            srv = start_server()
            dmn = start_daemon()
            self._json_response({"server": srv, "daemon": dmn})
        elif self.path == "/restart-daemon":
            # daemon再起動（コード変更後に呼ぶ）
            global _daemon_proc
            _kill_old_daemon()
            if _daemon_proc and _daemon_proc.poll() is None:
                try:
                    _daemon_proc.terminate()
                    _daemon_proc.wait(timeout=5)
                except Exception:
                    try: _daemon_proc.kill()
                    except Exception: pass
            _daemon_proc = None
            time.sleep(2)
            result = start_daemon()
            self._json_response(result)
        elif self.path == "/restart-server":
            result = restart_server()
            self._json_response(result)
        else:
            self._json_response({"error": "not found"}, 404)

    def log_message(self, format, *args):
        pass


def main():
    print("=" * 50)
    print("  OS_FOR_HUMAN Launcher")
    print(f"  URL: http://localhost:{LAUNCHER_PORT}")
    print("=" * 50)

    # 起動時に server.py + daemon も立ち上げる
    print("  [launcher] server.py を起動中...")
    result = start_server()
    print(f"  [launcher] server.py: {result['status']}")
    if "pid" in result:
        print(f"  [launcher] server.py PID: {result['pid']}")

    print("  [launcher] CMD daemon を起動中...")
    dmn = start_daemon()
    print(f"  [launcher] daemon: {dmn['status']}")
    if "pid" in dmn:
        print(f"  [launcher] daemon PID: {dmn['pid']}")
    print("=" * 50)

    server = HTTPServer(("0.0.0.0", LAUNCHER_PORT), LauncherHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[launcher] 停止")
        server.shutdown()


if __name__ == "__main__":
    main()
