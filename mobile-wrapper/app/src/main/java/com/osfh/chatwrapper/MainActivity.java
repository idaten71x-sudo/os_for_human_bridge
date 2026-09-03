package com.osfh.chatwrapper;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private WebView webView;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectLogger();
            }
        });
        webView.addJavascriptInterface(new LogBridge(), "OSFHLogBridge");
        webView.loadUrl("https://chatgpt.com/");
    }

    private void injectLogger() {
        String js = "(() => {" +
                "if (window.__osfhLoggerInstalled) return;" +
                "window.__osfhLoggerInstalled = true;" +
                "const seen = new Set();" +
                "const scan = () => {" +
                "document.querySelectorAll('[data-message-author-role]').forEach(el => {" +
                "const role = el.getAttribute('data-message-author-role');" +
                "if (role !== 'user' && role !== 'assistant') return;" +
                "const text = (el.innerText || el.textContent || '').trim();" +
                "if (!text) return;" +
                "const key = role + '\\n' + text;" +
                "if (seen.has(key)) return;" +
                "seen.add(key);" +
                "OSFHLogBridge.save(JSON.stringify({ts:new Date().toISOString(),role:role,text:text,url:location.href}));" +
                "});" +
                "};" +
                "scan();" +
                "new MutationObserver(scan).observe(document.documentElement,{subtree:true,childList:true,characterData:true});" +
                "})();";
        webView.evaluateJavascript(js, null);
    }

    public class LogBridge {
        @JavascriptInterface
        public void save(String line) {
            try {
                File f = new File(getFilesDir(), "chat_log.jsonl");
                try (FileOutputStream out = new FileOutputStream(f, true)) {
                    out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
