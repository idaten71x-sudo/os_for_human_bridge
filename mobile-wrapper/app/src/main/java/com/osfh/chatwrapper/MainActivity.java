package com.osfh.chatwrapper;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends Activity {
    private WebView webView;
    private TextView statusView;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final StringBuilder diagnosticLog = new StringBuilder();
    private int lastUserCount = -1;
    private int lastAssistantCount = -1;
    private long waitingSince = 0L;

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            if (webView != null) {
                String js = "(function(){try{" +
                        "var u=document.querySelectorAll('[data-message-author-role=\\\"user\\\"]').length;" +
                        "var a=document.querySelectorAll('[data-message-author-role=\\\"assistant\\\"]').length;" +
                        "return u+'|'+a;" +
                        "}catch(e){return 'ERR|'+String(e);}})();";
                webView.evaluateJavascript(js, value -> handleCounts(value));
            }
            handler.postDelayed(this, 1000L);
        }
    };

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        statusView = new TextView(this);
        statusView.setText("ChatGPTを読み込み中…");
        statusView.setTextSize(14f);
        statusView.setTextColor(Color.DKGRAY);
        statusView.setPadding(24, 12, 24, 12);
        statusView.setBackgroundColor(Color.rgb(245, 245, 245));
        statusView.setOnClickListener(v -> copyDiagnostics());
        root.addView(statusView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f));
        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportZoom(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);

        String ua = s.getUserAgentString();
        if (ua != null) {
            s.setUserAgentString(ua.replace("; wv", ""));
            log("UA " + s.getUserAgentString());
        }

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                log("CONSOLE " + consoleMessage.messageLevel() + " " +
                        consoleMessage.sourceId() + ":" + consoleMessage.lineNumber() + " " +
                        consoleMessage.message());
                return super.onConsoleMessage(consoleMessage);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                setStatus("ChatGPTを読み込み中…");
                log("PAGE_STARTED " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                setStatus("準備完了");
                log("PAGE_FINISHED " + url);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                log("WEB_ERROR " + request.getUrl() + " code=" + error.getErrorCode() + " " + error.getDescription());
                super.onReceivedError(view, request, error);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                log("HTTP_ERROR " + request.getUrl() + " status=" + errorResponse.getStatusCode());
                super.onReceivedHttpError(view, request, errorResponse);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                log("SSL_ERROR " + error.toString());
                handler.cancel();
            }
        });

        log("DIAGNOSTIC_BUILD v0.2.3");
        webView.loadUrl("https://chatgpt.com/");
        handler.postDelayed(pollRunnable, 1000L);
    }

    private void handleCounts(String raw) {
        if (raw == null) return;
        String clean = raw.replace("\\\"", "").replace("\"", "");
        if (clean.startsWith("ERR|")) {
            log("DOM_POLL_ERROR " + clean);
            return;
        }
        String[] parts = clean.split("\\|");
        if (parts.length != 2) return;
        try {
            int userCount = Integer.parseInt(parts[0]);
            int assistantCount = Integer.parseInt(parts[1]);

            if (lastUserCount < 0) {
                lastUserCount = userCount;
                lastAssistantCount = assistantCount;
                log("DOM_COUNTS user=" + userCount + " assistant=" + assistantCount);
                return;
            }

            if (userCount > lastUserCount) {
                waitingSince = System.currentTimeMillis();
                setStatus("回答待ち…");
                log("USER_MESSAGE_DETECTED user=" + userCount + " assistant=" + assistantCount);
            }

            if (assistantCount > lastAssistantCount) {
                waitingSince = 0L;
                setStatus("回答表示");
                log("ASSISTANT_MESSAGE_DETECTED user=" + userCount + " assistant=" + assistantCount);
            }

            if (waitingSince > 0L && System.currentTimeMillis() - waitingSince >= 30000L) {
                setStatus("回答を表示できていません（タップで診断情報をコピー）");
                log("ANSWER_TIMEOUT_30S user=" + userCount + " assistant=" + assistantCount);
                waitingSince = 0L;
            }

            lastUserCount = userCount;
            lastAssistantCount = assistantCount;
        } catch (NumberFormatException e) {
            log("DOM_PARSE_ERROR " + clean);
        }
    }

    private void setStatus(String text) {
        runOnUiThread(() -> statusView.setText(text));
    }

    private void log(String text) {
        String stamp = new SimpleDateFormat("HH:mm:ss.SSS", Locale.JAPAN).format(new Date());
        String line = stamp + " " + text + "\n";
        diagnosticLog.append(line);
        if (diagnosticLog.length() > 20000) {
            diagnosticLog.delete(0, diagnosticLog.length() - 16000);
        }
    }

    private void copyDiagnostics() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("OSFH WebView diagnostics", diagnosticLog.toString()));
        Toast.makeText(this, "診断情報をコピーしました", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(pollRunnable);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
