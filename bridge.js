require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isAntigravityRunning, restartAntigravity } = require('./lib/process_manager');
const { runClaudeCode } = require('./lib/claude_code');

const app = express();
const PORT = process.env.BRIDGE_PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// 簡易ステータス
app.get('/api/status', async (req, res) => {
  const agRunning = await isAntigravityRunning();
  res.json({
    bridge: "running",
    uptime: process.uptime(),
    antigravity: agRunning ? "running" : "stopped",
    claudeCode: "available",
    apiKeys: {
      openai: !!process.env.OPENAI_API_KEY,
      xai: !!process.env.XAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY
    }
  });
});

// APIキーの有無確認
app.get('/api/keys', (req, res) => {
  res.json({
    openai: !!process.env.OPENAI_API_KEY,
    xai: !!process.env.XAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY
  });
});

// AI 代理実行 (Proxy)
app.post('/api/proxy', async (req, res) => {
  const { provider, model, system, user, max_tokens } = req.body;
  console.log(`[PROXY] Calling ${provider} with model ${model}`);
  
  if (!process.env[`${provider.toUpperCase()}_API_KEY`]) {
    return res.status(400).json({ error: `${provider} のAPIキーが設定されていません。` });
  }

  // TODO: 本格的な fetch (OpenAI/Anthropic/Google/XAI) 呼び出し
  res.status(501).json({ error: "代理呼び出しの各社API接続はライブラリの追加が必要です。現在は骨組みのみです。" });
});

// Claude Code CLI連携
app.post('/api/claude', async (req, res) => {
  const { instruction } = req.body;
  try {
    const result = await runClaudeCode(instruction);
    res.json({ result });
  } catch (err) {
    res.status(500).json(err);
  }
});

// Antigravity タスク投入
app.post('/api/agy/task', (req, res) => {
  const { task, files } = req.body;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const taskDir = path.join(process.env.ANTIGRAVITY_WORKSPACE || './', 'tasks');
  const taskFile = path.join(taskDir, `task_${timestamp}.md`);

  if (!fs.existsSync(taskDir)) {
    fs.mkdirSync(taskDir, { recursive: true });
  }

  fs.writeFileSync(taskFile, task);
  res.json({ message: "Task created", path: taskFile });
});

// Antigravity を強制再起動
app.post('/api/agy/restart', async (req, res) => {
  const ws = process.env.ANTIGRAVITY_WORKSPACE || '/Users/user/os_for_human';
  await restartAntigravity(ws);
  res.json({ message: "Restarting Antigravity..." });
});

// 相互監視 (Watchdog) - 無限ループ回避のためコメントアウト
/*
setInterval(() => {
  exec('tasklist /FI "WINDOWTITLE eq OS_FOR_HUMAN Watchdog"', (err, stdout) => {
    if (!stdout.toLowerCase().includes('cmd.exe')) {
      console.log('[WATCHDOG] Watchdog dead. Restarting...');
      spawn('cmd.exe', ['/c', 'start', 'watchdog.bat'], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore'
      }).unref();
    }
  });
}, 10000);
*/

app.listen(PORT, () => {
  console.log(`OS_FOR_HUMAN Bridge running on port ${PORT}`);
  console.log(`OS_FOR_HUMAN Bridge started successfully in ${process.uptime()}s`);
});

process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: Port ${PORT} is already in use. Please kill the existing process.`);
  } else {
    console.error('Caught exception: ', err);
  }
});
