package com.osfh.chatwrapper;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.View;
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
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setDescendantFocusability(View.FOCUS_AFTER_DESCENDANTS);
        webView.requestFocus(View.FOCUS_DOWN);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectEnhancements();
            }
        });
        webView.addJavascriptInterface(new LogBridge(), "OSFHLogBridge");
        webView.setOnTouchListener((v, event) -> {
            if (!webView.hasFocus()) webView.requestFocus(View.FOCUS_DOWN);
            return false;
        });
        webView.loadUrl("https://chatgpt.com/");
    }

    private void injectEnhancements() {
        String js = "(() => {" +
                "if (window.__osfhEnhancedInstalled) return;" +
                "window.__osfhEnhancedInstalled = true;" +
                "const seen = new Set();" +
                "const observed = new WeakMap();" +
                "const fmt = d => new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d);" +
                "const cleanTitle = t => (t || '').replace(/\\s*[|·-]\\s*ChatGPT\\s*$/i,'').replace(/^ChatGPT\\s*[|·-]?\\s*/i,'').trim();" +
                "const ensureHeader = () => {" +
                "let h = document.getElementById('osfh-thread-header');" +
                "if (!h) {" +
                "h = document.createElement('div');" +
                "h.id = 'osfh-thread-header';" +
                "h.style.cssText = 'position:fixed;top:0;left:56px;right:56px;height:48px;z-index:2147483646;display:flex;align-items:center;justify-content:center;pointer-events:none;font:600 15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:var(--text-primary,#111);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 8px;box-sizing:border-box;';" +
                "document.body.appendChild(h);" +
                "}" +
                "let title = cleanTitle(document.title);" +
                "if (!title || title.toLowerCase() === 'chatgpt') {" +
                "const active = document.querySelector('nav a[aria-current=page], aside a[aria-current=page]');" +
                "if (active) title = (active.innerText || active.textContent || '').trim();" +
                "}" +
                "h.textContent = title || '新しいチャット';" +
                "};" +
                "const stampFor = (el,d) => {" +
                "let s = el.nextElementSibling;" +
                "if (s && s.classList && s.classList.contains('osfh-msg-time')) return;" +
                "s = document.createElement('div');" +
                "s.className = 'osfh-msg-time';" +
                "s.textContent = fmt(d);" +
                "s.title = 'この専用アプリがメッセージを確認した時刻';" +
                "s.style.cssText = 'font-size:11px;line-height:16px;opacity:.48;margin-top:2px;margin-bottom:4px;user-select:none;pointer-events:none;';" +
                "el.insertAdjacentElement('afterend',s);" +
                "};" +
                "const scan = () => {" +
                "ensureHeader();" +
                "document.querySelectorAll('[data-message-author-role]').forEach(el => {" +
                "const role = el.getAttribute('data-message-author-role');" +
                "if (role !== 'user' && role !== 'assistant') return;" +
                "let d = observed.get(el);" +
                "if (!d) { d = new Date(); observed.set(el,d); }" +
                "stampFor(el,d);" +
                "const text = (el.innerText || el.textContent || '').trim();" +
                "if (!text) return;" +
                "const key = role + '\\n' + text;" +
                "if (seen.has(key)) return;" +
                "seen.add(key);" +
                "OSFHLogBridge.save(JSON.stringify({ts:d.toISOString(),role:role,text:text,url:location.href,title:cleanTitle(document.title)}));" +
                "});" +
                "};" +
                "scan();" +
                "new MutationObserver(scan).observe(document.body,{subtree:true,childList:true,characterData:true});" +
                "setInterval(ensureHeader,1000);" +
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
