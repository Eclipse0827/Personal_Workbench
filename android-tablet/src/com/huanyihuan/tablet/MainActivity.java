package com.huanyihuan.tablet;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * Tablet shell for the existing web workbench.
 * The web app keeps running from server/server.js on the computer; this
 * activity only renders it in a WebView over the local network.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "tablet";
    private static final String KEY_URL = "server_url";
    private static final String KEY_CONFIGURED = "configured";
    private static final String DEFAULT_URL = "http://192.168.119.77:5181";
    private static final int REQ_FILE = 1001;

    private final int paper = Color.parseColor("#F6F1E7");
    private final int ink = Color.parseColor("#2B2620");

    private WebView webView;
    private ProgressBar spinner;
    private LinearLayout errorPanel;
    private TextView errorText;
    private SharedPreferences prefs;
    private String serverUrl;
    private android.webkit.ValueCallback<Uri[]> uploadCallback;
    private WebView popupView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverUrl = prefs.getString(KEY_URL, DEFAULT_URL);

        getWindow().setStatusBarColor(paper);
        getWindow().setNavigationBarColor(paper);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(paper);

        webView = new WebView(this);
        webView.setBackgroundColor(paper);
        configureWebView();
        root.addView(webView, fill());

        spinner = new ProgressBar(this, null, android.R.attr.progressBarStyleLarge);
        FrameLayout.LayoutParams spinnerParams = new FrameLayout.LayoutParams(dp(44), dp(44), Gravity.CENTER);
        spinner.setVisibility(View.GONE);
        root.addView(spinner, spinnerParams);

        errorPanel = buildErrorPanel();
        root.addView(errorPanel, fill());

        setContentView(root);

        if (getIntent().getBooleanExtra("open_server_settings", false)) {
            promptForServer(false);
        } else if (!prefs.getBoolean(KEY_CONFIGURED, false)) {
            promptForServer(true);
        } else {
            loadHome();
        }
    }

    private FrameLayout.LayoutParams fill() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setUserAgentString(settings.getUserAgentString() + " ThinkkkTablet/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                openExternally(uri);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                errorPanel.setVisibility(View.GONE);
                spinner.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                spinner.setVisibility(View.GONE);
                injectTabletTweaks();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                spinner.setVisibility(View.GONE);
                CharSequence detail = error == null ? "" : error.getDescription();
                showError(request.getUrl().toString(), detail == null ? "" : detail.toString());
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                if (!request.isForMainFrame()) return;
                spinner.setVisibility(View.GONE);
                showError(request.getUrl().toString(), "HTTP " + response.getStatusCode());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             android.webkit.ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (uploadCallback != null) uploadCallback.onReceiveValue(null);
                uploadCallback = callback;
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                } catch (ActivityNotFoundException error) {
                    uploadCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                                          boolean isUserGesture, Message resultMsg) {
                final WebView popup = new WebView(MainActivity.this);
                popup.getSettings().setJavaScriptEnabled(true);
                popup.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView child, WebResourceRequest request) {
                        Uri uri = request.getUrl();
                        String scheme = uri.getScheme();
                        if ("http".equals(scheme) || "https".equals(scheme)) {
                            openExternally(uri);
                            child.post(child::destroy);
                            if (popupView == child) popupView = null;
                            return true;
                        }
                        return "about".equals(scheme);
                    }
                });
                popupView = popup;
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
        });
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // No browser / handler installed; keep the current page untouched.
        }
    }

    /**
     * Tablet-only adjustments injected at runtime. The desktop web files are
     * not modified:
     *   1. touch-action: manipulation keeps double-tap from zooming the page,
     *      so the existing double-click sentence lookup still receives events;
     *   2. Android WebView does not always emit mouseup after long-press text
     *      selection, so a completed long-press is translated into the mouseup
     *      the existing selection toolbar listens for.
     */
    private void injectTabletTweaks() {
        String script = "(function(){"
                + "if(document.getElementById('tablet-shell-style'))return;"
                + "var style=document.createElement('style');style.id='tablet-shell-style';"
                + "style.textContent='html{touch-action:manipulation}';"
                + "(document.head||document.documentElement).appendChild(style);"
                + "var started=0;"
                + "document.addEventListener('touchstart',function(){started=Date.now();},true);"
                + "document.addEventListener('touchend',function(){"
                + "if(Date.now()-started<420)return;"
                + "var selection=window.getSelection();"
                + "if(!selection||selection.isCollapsed||!selection.rangeCount)return;"
                + "var node=selection.anchorNode;"
                + "var el=node&&node.nodeType===3?node.parentNode:node;"
                + "while(el&&el!==document.body){"
                + "if(el.dataset&&el.dataset.paragraphId)break;el=el.parentNode;}"
                + "if(!el||el===document.body)return;"
                + "var rect=selection.getRangeAt(0).getBoundingClientRect();"
                + "setTimeout(function(){"
                + "el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,"
                + "clientX:rect.left+rect.width/2,clientY:rect.bottom}));"
                + "},80);"
                + "},true);"
                + "})();";
        webView.evaluateJavascript(script, null);
    }

    private String normalizeUrl(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://" + value;
        }
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        Uri uri = Uri.parse(value);
        if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
        return value;
    }

    private void promptForServer(final boolean firstRun) {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(serverUrl);
        input.setSelection(input.getText().length());
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_URI);

        FrameLayout wrap = new FrameLayout(this);
        int padding = dp(20);
        wrap.setPadding(padding, dp(4), padding, 0);
        wrap.addView(input, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(firstRun ? "连接电脑上的工作台" : "服务器地址")
                .setMessage(firstRun
                        ? "平板和电脑需要连同一个 Wi-Fi，电脑上的服务要保持运行。\n\n例如：http://192.168.1.10:5181"
                        : null)
                .setView(wrap)
                .setPositiveButton("连接", null)
                .setNegativeButton(firstRun ? "退出" : "取消", null)
                .create();
        dialog.setCancelable(!firstRun);
        dialog.setCanceledOnTouchOutside(!firstRun);
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                String normalized = normalizeUrl(input.getText().toString());
                if (normalized == null) {
                    input.setError("请输入 http:// 开头的完整地址");
                    return;
                }
                serverUrl = normalized;
                prefs.edit()
                        .putString(KEY_URL, normalized)
                        .putBoolean(KEY_CONFIGURED, true)
                        .apply();
                dialog.dismiss();
                loadHome();
            });
            if (firstRun) {
                dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener(v -> {
                    dialog.dismiss();
                    finish();
                });
            }
        });
        dialog.show();
        input.requestFocus();
        dialog.getWindow().setSoftInputMode(
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
    }

    private void loadHome() {
        errorPanel.setVisibility(View.GONE);
        spinner.setVisibility(View.VISIBLE);
        webView.loadUrl(serverUrl + "/");
    }

    private LinearLayout buildErrorPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setBackgroundColor(paper);
        panel.setPadding(dp(36), dp(36), dp(36), dp(36));
        panel.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText("连不上电脑上的工作台");
        title.setTextColor(ink);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        panel.addView(title);

        errorText = new TextView(this);
        errorText.setTextColor(Color.parseColor("#6B5F52"));
        errorText.setTextSize(14);
        errorText.setLineSpacing(dp(4), 1f);
        errorText.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        textParams.topMargin = dp(16);
        panel.addView(errorText, textParams);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams buttonsParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonsParams.topMargin = dp(24);
        panel.addView(buttons, buttonsParams);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> loadHome());
        buttons.addView(retry);

        Button change = new Button(this);
        change.setText("修改地址");
        change.setOnClickListener(v -> promptForServer(false));
        LinearLayout.LayoutParams changeParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        changeParams.leftMargin = dp(12);
        buttons.addView(change, changeParams);

        return panel;
    }

    private void showError(String url, String detail) {
        String message = "请确认平板和电脑在同一个 Wi-Fi，电脑上的服务已启动，"
                + "并且地址填写正确。\n\n"
                + "当前地址：" + serverUrl + "\n"
                + "访问地址：" + url;
        if (detail != null && !detail.isEmpty()) message += "\n错误信息：" + detail;
        errorText.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
        errorPanel.bringToFront();
    }

    @Override
    public void onBackPressed() {
        if (errorPanel.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getBooleanExtra("open_server_settings", false)) {
            promptForServer(false);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (uploadCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                }
                uploadCallback.onReceiveValue(results);
                uploadCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (popupView != null) {
            popupView.destroy();
            popupView = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}