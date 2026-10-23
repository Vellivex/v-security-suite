package app.vguard.firewall;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Editable;
import android.text.TextWatcher;
import android.text.TextUtils;
import android.text.format.Formatter;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native, local-only user interface. Every protection status comes from GuardService. */
public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(7, 9, 9);
    private static final int PANEL = Color.rgb(17, 21, 20);
    private static final int PANEL_ALT = Color.rgb(12, 16, 15);
    private static final int LINE = Color.rgb(43, 51, 46);
    private static final int TEXT = Color.rgb(233, 237, 231);
    private static final int MUTED = Color.rgb(152, 162, 155);
    private static final int QUIET = Color.rgb(125, 137, 129);
    private static final int ACCENT = Color.rgb(145, 166, 132);
    private static final int INK = Color.rgb(14, 21, 14);
    private static final int AMBER = Color.rgb(203, 172, 124);
    private static final int CONSENT_REQUEST = 31;
    private static final int EXPORT_REQUEST = 32;
    private static final String[] TAB_NAMES = {"Overview", "Apps", "Activity", "Settings"};

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ArrayList<AppEntry> installedApps = new ArrayList<>();
    private final ArrayList<AppEntry> visibleApps = new ArrayList<>();
    private final LinearLayout[] tabButtons = new LinearLayout[4];
    private final TextView[] tabLabels = new TextView[4];
    private final MarkView[] tabIcons = new MarkView[4];
    private FrameLayout page;
    private View brandingBar;
    private View navigationBar;
    private View upperDivider;
    private View lowerDivider;
    private TextView headerState;
    private View headerDot;
    private int tab = 0;
    private String mode = "normal";
    private Set<String> blocked = new LinkedHashSet<>();
    private boolean showSystemApps;
    private boolean appsLoaded;
    private boolean resumed;
    private boolean inventoryLoading;
    private boolean inventoryRefreshQueued;
    private boolean inventoryReceiverRegistered;
    private String inventoryError = "";
    private String appSearch = "";
    private TextView appSummary;
    private TextView appEmpty;
    private AppAdapter appAdapter;
    private ListView appsList;
    private TextView phaseText;
    private View phaseDot;
    private TextView phaseTitle;
    private TextView phaseDetail;
    private TextView countValue;
    private TextView countLabel;
    private TextView packetValue;
    private TextView bytesValue;
    private TextView sessionValue;
    private TextView startButton;
    private LinearLayout modeButtons;
    private LinearLayout activityItems;
    private TextView activitySummary;
    private TextView exportButton;
    private TextView clearButton;
    private long renderedEventSignature = Long.MIN_VALUE;
    private List<PacketInfo> pendingExport;
    private boolean exportPending;
    private boolean consentPending;
    private String pendingStartMode;
    private Set<String> pendingStartRules;

    private final BroadcastReceiver packageChanges = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!resumed || intent == null) return;
            if (Intent.ACTION_PACKAGE_REMOVED.equals(intent.getAction())
                && intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return;
            loadApps();
        }
    };

    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (!resumed) return;
            refreshStatus();
            handler.postDelayed(this, 1000L);
        }
    };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Installed-app inventory and destination metadata are private. Keep
        // them out of screenshots, recents previews and non-secure displays.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        mode = RuleStore.getMode(this);
        blocked = new LinkedHashSet<>(RuleStore.getBlocked(this, mode));
        if (savedInstanceState != null) {
            tab = Math.max(0, Math.min(3, savedInstanceState.getInt("tab", 0)));
            appSearch = savedInstanceState.getString("search", "");
            showSystemApps = savedInstanceState.getBoolean("system", false);
            exportPending = savedInstanceState.getBoolean("exportPending", false);
        }
        Object retained = getLastNonConfigurationInstance();
        if (retained instanceof RetainedUiState) {
            RetainedUiState state = (RetainedUiState) retained;
            pendingExport = state.pendingExport;
            exportPending = state.exportPending;
            consentPending = state.consentPending;
            pendingStartMode = state.pendingStartMode;
            pendingStartRules = state.pendingStartRules;
        }
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }

        final LinearLayout root = column();
        root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars());
                    android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                    root.setPadding(safe.left, safe.top, safe.right, Math.max(safe.bottom, ime.bottom));
                    setKeyboardLayout(ime.bottom > safe.bottom);
                } else {
                    root.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                    setKeyboardLayout(insets.getSystemWindowInsetBottom() > dp(120));
                }
                return insets;
            }
        });
        brandingBar = buildHeader();
        upperDivider = hairline();
        root.addView(brandingBar);
        root.addView(upperDivider);
        page = new FrameLayout(this);
        root.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));
        lowerDivider = hairline();
        navigationBar = buildNavigation();
        root.addView(lowerDivider);
        root.addView(navigationBar);
        setContentView(root);
        showTab(tab);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        mode = RuleStore.getMode(this);
        blocked = new LinkedHashSet<>(RuleStore.getBlocked(this, mode));
        registerInventoryReceiver();
        loadApps();
        paintModeSelector(modeButtons);
        refreshApps();
        handler.removeCallbacks(ticker);
        handler.post(ticker);
    }

    @Override protected void onPause() {
        resumed = false;
        if (inventoryReceiverRegistered) {
            unregisterReceiver(packageChanges);
            inventoryReceiverRegistered = false;
        }
        handler.removeCallbacks(ticker);
        super.onPause();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacks(ticker);
        worker.shutdown();
        super.onDestroy();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putInt("tab", tab);
        state.putString("search", appSearch);
        state.putBoolean("system", showSystemApps);
        // Only an operation marker is saved. Packet metadata stays in process memory.
        state.putBoolean("exportPending", exportPending);
        super.onSaveInstanceState(state);
    }

    @Override public Object onRetainNonConfigurationInstance() {
        return new RetainedUiState(pendingExport, exportPending, consentPending,
            pendingStartMode, pendingStartRules);
    }

    private void registerInventoryReceiver() {
        if (inventoryReceiverRegistered) return;
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_PACKAGE_ADDED);
        filter.addAction(Intent.ACTION_PACKAGE_REMOVED);
        filter.addAction(Intent.ACTION_PACKAGE_REPLACED);
        filter.addDataScheme("package");
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(packageChanges, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(packageChanges, filter);
        inventoryReceiverRegistered = true;
    }

    private void setKeyboardLayout(boolean keyboardVisible) {
        // Give the app search/list the available viewport when the keyboard is
        // open, including compact landscape. Back dismisses the keyboard.
        int visibility = keyboardVisible && tab == 1 ? View.GONE : View.VISIBLE;
        if (brandingBar != null) brandingBar.setVisibility(visibility);
        if (navigationBar != null) navigationBar.setVisibility(visibility);
        if (upperDivider != null) upperDivider.setVisibility(visibility);
        if (lowerDivider != null) lowerDivider.setVisibility(visibility);
    }

    private View buildHeader() {
        LinearLayout header = row();
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(22), dp(18), dp(22), dp(16));
        MarkView mark = new MarkView(this, 4);
        mark.tint = TEXT;
        header.addView(mark, new LinearLayout.LayoutParams(dp(45), dp(37)));
        LinearLayout brand = column();
        LinearLayout.LayoutParams brandLp = new LinearLayout.LayoutParams(0, -2, 1);
        brandLp.leftMargin = dp(12);
        header.addView(brand, brandLp);
        TextView title = label("VGUARD", 17, TEXT, true);
        title.setLetterSpacing(0.16f);
        brand.addView(title);
        TextView descriptor = micro("PHONE FIREWALL", QUIET);
        descriptor.setPadding(0, dp(4), 0, 0);
        brand.addView(descriptor);

        LinearLayout badge = row();
        badge.setGravity(Gravity.CENTER_VERTICAL);
        badge.setPadding(dp(10), dp(8), dp(10), dp(8));
        badge.setBackground(surface(PANEL_ALT, LINE, 30));
        headerDot = dot(QUIET, 5);
        badge.addView(headerDot, new LinearLayout.LayoutParams(dp(5), dp(5)));
        headerState = micro("OFF", MUTED);
        headerState.setPadding(dp(7), 0, 0, 0);
        badge.addView(headerState);
        header.addView(badge, new LinearLayout.LayoutParams(-2, -2));
        return header;
    }

    private View buildNavigation() {
        LinearLayout nav = row();
        nav.setBackgroundColor(PANEL_ALT);
        nav.setPadding(dp(8), dp(3), dp(8), dp(4));
        for (int i = 0; i < 4; i++) {
            final int destination = i;
            LinearLayout item = column();
            item.setGravity(Gravity.CENTER);
            item.setMinimumHeight(dp(64));
            item.setPadding(dp(3), dp(9), dp(3), dp(8));
            item.setContentDescription(TAB_NAMES[i] + " tab");
            item.setFocusable(true);
            item.setBackground(ripple(Color.TRANSPARENT, Color.TRANSPARENT, 8));
            MarkView icon = new MarkView(this, i);
            item.addView(icon, new LinearLayout.LayoutParams(dp(20), dp(20)));
            TextView text = label(TAB_NAMES[i], 11, QUIET, false);
            text.setPadding(0, dp(6), 0, 0);
            item.addView(text);
            item.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { showTab(destination); }
            });
            tabButtons[i] = item;
            tabLabels[i] = text;
            tabIcons[i] = icon;
            nav.addView(item, new LinearLayout.LayoutParams(0, -2, 1));
        }
        return nav;
    }

    private void showTab(int destination) {
        if (page == null) return;
        if (tab != destination) {
            InputMethodManager input = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (input != null) input.hideSoftInputFromWindow(page.getWindowToken(), 0);
        }
        tab = destination;
        page.removeAllViews();
        phaseText = null;
        startButton = null;
        modeButtons = null;
        activityItems = null;
        appAdapter = null;
        appSummary = null;
        appEmpty = null;
        appsList = null;
        for (int i = 0; i < 4; i++) {
            boolean selected = i == destination;
            tabLabels[i].setTextColor(selected ? TEXT : QUIET);
            tabLabels[i].setTypeface(Typeface.create("sans-serif", selected ? Typeface.BOLD : Typeface.NORMAL));
            tabIcons[i].tint = selected ? ACCENT : QUIET;
            tabIcons[i].invalidate();
            tabButtons[i].setSelected(selected);
            tabButtons[i].setContentDescription(TAB_NAMES[i] + " tab" + (selected ? ", selected" : ""));
        }
        View content;
        if (tab == 1) content = buildApps();
        else if (tab == 2) content = buildActivity();
        else if (tab == 3) content = buildSettings();
        else content = buildOverview();
        page.addView(content, new FrameLayout.LayoutParams(-1, -1));
        refreshStatus();
    }

    private View buildOverview() {
        LinearLayout content = screenContent();
        addHeading(content, "NETWORK CONTROL", "Your apps. Your rules.",
            "Choose which apps can use the internet on this phone.");
        content.addView(gap(24));

        LinearLayout state = card();
        LinearLayout stateLine = row();
        stateLine.setGravity(Gravity.CENTER_VERTICAL);
        phaseDot = dot(QUIET, 7);
        stateLine.addView(phaseDot, new LinearLayout.LayoutParams(dp(7), dp(7)));
        phaseText = micro("OFF", MUTED);
        phaseText.setPadding(dp(9), 0, 0, 0);
        stateLine.addView(phaseText);
        state.addView(stateLine);
        phaseTitle = label("Blocking is off", 27, TEXT, true);
        phaseTitle.setPadding(0, dp(17), 0, dp(7));
        state.addView(phaseTitle);
        phaseDetail = paragraph("Select apps, then start blocking.");
        state.addView(phaseDetail);
        state.addView(gap(22));
        state.addView(hairline());
        state.addView(gap(18));

        LinearLayout figures = row();
        LinearLayout appsFigure = column();
        countValue = number("0");
        countLabel = micro("SELECTED APPS", QUIET);
        appsFigure.addView(countValue);
        appsFigure.addView(countLabel);
        figures.addView(appsFigure, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout packetFigure = column();
        packetValue = number("0");
        packetFigure.addView(packetValue);
        packetFigure.addView(micro("PACKETS DROPPED", QUIET));
        figures.addView(packetFigure, new LinearLayout.LayoutParams(0, -2, 1));
        state.addView(figures);
        LinearLayout session = row();
        session.setPadding(0, dp(16), 0, 0);
        bytesValue = micro("0 B DISCARDED", MUTED);
        sessionValue = micro("NO SESSION", MUTED);
        sessionValue.setGravity(Gravity.END);
        session.addView(bytesValue, new LinearLayout.LayoutParams(0, -2, 1));
        session.addView(sessionValue, new LinearLayout.LayoutParams(0, -2, 1));
        state.addView(session);
        state.addView(gap(20));
        startButton = button("Start blocking", true);
        startButton.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { toggleBlocking(); }
        });
        state.addView(startButton, new LinearLayout.LayoutParams(-1, -2));
        TextView local = micro("LOCAL FILTERING  /  NO ACCOUNT", QUIET);
        local.setGravity(Gravity.CENTER);
        local.setPadding(0, dp(14), 0, 0);
        state.addView(local);
        content.addView(state);
        content.addView(gap(23));
        content.addView(micro("RULE PROFILE", QUIET));
        content.addView(gap(10));
        modeButtons = buildModeSelector();
        content.addView(modeButtons);
        TextView modeNote = paragraph("Normal and Journey keep separate app selections. Switching a profile while blocking applies its rules immediately.");
        modeNote.setTextSize(12);
        modeNote.setPadding(0, dp(10), 0, dp(22));
        content.addView(modeNote);

        LinearLayout choose = card();
        TextView chooseTitle = label("Pause only what you choose", 17, TEXT, true);
        choose.addView(chooseTitle);
        TextView chooseCopy = paragraph("Select the apps to block. Other apps keep their normal internet connection.");
        chooseCopy.setPadding(0, dp(8), 0, dp(16));
        choose.addView(chooseCopy);
        TextView chooseButton = button("Choose apps", false);
        chooseButton.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showTab(1); }
        });
        choose.addView(chooseButton);
        content.addView(choose);
        content.addView(gap(18));
        TextView limit = paragraph("Packet counts show discarded traffic, not evidence of tracking or spyware. Blocking internet access does not remove an app’s camera, microphone or location permissions.");
        limit.setTextSize(12);
        content.addView(limit);
        content.addView(gap(18));
        addPreviewNotice(content);
        return scroll(content);
    }

    private LinearLayout buildModeSelector() {
        LinearLayout modes = row();
        modes.setPadding(dp(4), dp(4), dp(4), dp(4));
        modes.setBackground(surface(PANEL_ALT, LINE, 9));
        String[] names = {"normal", "journey"};
        for (int i = 0; i < names.length; i++) {
            final String target = names[i];
            TextView choice = label(i == 0 ? "Normal" : "Journey", 14, MUTED, true);
            choice.setGravity(Gravity.CENTER);
            choice.setMinimumHeight(dp(48));
            choice.setTag(target);
            choice.setFocusable(true);
            choice.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View view) { changeMode(target); }
            });
            modes.addView(choice, new LinearLayout.LayoutParams(0, -2, 1));
        }
        paintModeSelector(modes);
        return modes;
    }

    private void paintModeSelector(LinearLayout selector) {
        if (selector == null) return;
        for (int i = 0; i < selector.getChildCount(); i++) {
            TextView child = (TextView) selector.getChildAt(i);
            boolean selected = mode.equals(child.getTag());
            child.setTextColor(selected ? TEXT : MUTED);
            child.setBackground(ripple(selected ? Color.rgb(32, 41, 34) : Color.TRANSPARENT,
                selected ? Color.rgb(55, 69, 54) : Color.TRANSPARENT, 6));
            child.setSelected(selected);
            child.setContentDescription(child.getText() + " profile" + (selected ? ", selected" : ""));
        }
    }

    private void changeMode(String nextMode) {
        if (mode.equals(nextMode)) return;
        mode = nextMode;
        RuleStore.setMode(this, mode);
        blocked = new LinkedHashSet<>(RuleStore.getBlocked(this, mode));
        applyIfRunning();
        paintModeSelector(modeButtons);
        refreshApps();
        refreshStatus();
    }

    private View buildApps() {
        LinearLayout layout = column();
        layout.setPadding(dp(22), 0, dp(22), 0);
        layout.setFocusableInTouchMode(true);
        final LinearLayout controls = column();
        controls.setPadding(0, dp(24), 0, 0);
        addHeading(controls, "APP RULES", "You set the boundary.",
            "Switch on Block for each app you want to keep offline.");
        controls.addView(gap(18));
        modeButtons = buildModeSelector();
        controls.addView(modeButtons);
        controls.addView(gap(12));

        EditText search = new EditText(this);
        search.setSingleLine(true);
        search.setTextSize(14);
        search.setTextColor(TEXT);
        search.setHintTextColor(QUIET);
        search.setHint("Search apps or package names");
        search.setContentDescription("Search apps or package names");
        search.setPadding(dp(15), dp(10), dp(15), dp(10));
        search.setMinimumHeight(dp(52));
        search.setBackground(surface(PANEL, LINE, 8));
        search.setText(appSearch);
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                appSearch = s.toString();
                refreshApps();
            }
            @Override public void afterTextChanged(Editable s) { }
        });
        controls.addView(search, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout options = row();
        options.setGravity(Gravity.CENTER_VERTICAL);
        options.setPadding(0, dp(5), 0, 0);
        appSummary = micro("READING INSTALLED APPS", QUIET);
        options.addView(appSummary, new LinearLayout.LayoutParams(0, -2, 1));
        Switch systems = makeSwitch();
        systems.setText("System apps");
        systems.setTextColor(MUTED);
        systems.setTextSize(12);
        systems.setSwitchPadding(dp(8));
        systems.setChecked(showSystemApps);
        systems.setContentDescription("Include system apps in list");
        options.addView(systems);
        controls.addView(options);
        final TextView caution = paragraph("System components may support calls and updates. Only block apps you recognise.");
        caution.setTextColor(AMBER);
        caution.setTextSize(12);
        caution.setPadding(0, 0, 0, dp(10));
        caution.setVisibility(showSystemApps ? View.VISIBLE : View.GONE);
        systems.setOnCheckedChangeListener((buttonView, checked) -> {
            showSystemApps = checked;
            caution.setVisibility(checked ? View.VISIBLE : View.GONE);
            refreshApps();
        });
        controls.addView(caution);
        TextView savedNote = paragraph("Unavailable selections stay listed so you can remove their saved rules. Tap an installed app’s name to review its Android permissions.");
        savedNote.setTextSize(12);
        savedNote.setPadding(0, 0, 0, dp(12));
        controls.addView(savedNote);
        controls.addView(hairline());
        appsList = new ListView(this);
        appsList.setBackgroundColor(BG);
        appsList.setDivider(surface(LINE, LINE, 0));
        appsList.setDividerHeight(dp(1));
        appsList.setCacheColorHint(BG);
        appsList.setPadding(0, 0, 0, dp(16));
        appsList.setClipToPadding(false);
        appsList.setVerticalScrollBarEnabled(false);
        appsList.setItemsCanFocus(true);
        // Controls scroll with the list so large text, a keyboard or landscape
        // never leaves a fixed-height header consuming all space for app rows.
        appsList.addHeaderView(controls, null, false);
        appEmpty = paragraph(appsLoaded ? "No matching apps." : "Reading installed apps…");
        appEmpty.setGravity(Gravity.CENTER);
        appEmpty.setPadding(dp(20), dp(25), dp(20), dp(25));
        appsList.addFooterView(appEmpty, null, false);
        appAdapter = new AppAdapter();
        appsList.setAdapter(appAdapter);
        layout.addView(appsList, new LinearLayout.LayoutParams(-1, -1));
        refreshApps();
        layout.requestFocus();
        return layout;
    }

    private void loadApps() {
        if (inventoryLoading) {
            inventoryRefreshQueued = true;
            return;
        }
        inventoryLoading = true;
        inventoryRefreshQueued = false;
        worker.execute(() -> {
            final ArrayList<AppEntry> result = new ArrayList<>();
            final PackageManager manager = getPackageManager();
            String failure = null;
            try {
                List<PackageInfo> packages = manager.getInstalledPackages(PackageManager.GET_PERMISSIONS);
                for (PackageInfo info : packages) {
                    if (info.applicationInfo == null || info.packageName.equals(getPackageName())) continue;
                    if (manager.checkPermission(Manifest.permission.INTERNET, info.packageName)
                        != PackageManager.PERMISSION_GRANTED) continue;
                    ApplicationInfo application = info.applicationInfo;
                    String name = manager.getApplicationLabel(application).toString();
                    Drawable icon;
                    try { icon = manager.getApplicationIcon(application); }
                    catch (RuntimeException ex) { icon = null; }
                    result.add(new AppEntry(info.packageName, name, icon,
                        (application.flags & ApplicationInfo.FLAG_SYSTEM) != 0));
                }
                Collections.sort(result, new Comparator<AppEntry>() {
                    @Override public int compare(AppEntry left, AppEntry right) {
                        int labelOrder = left.name.compareToIgnoreCase(right.name);
                        return labelOrder == 0 ? left.packageName.compareTo(right.packageName) : labelOrder;
                    }
                });
            } catch (RuntimeException error) {
                failure = "Android did not provide the installed app list. " + safeError(error);
            }
            final String errorText = failure;
            handler.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                inventoryLoading = false;
                if (errorText == null) {
                    installedApps.clear();
                    installedApps.addAll(result);
                    appsLoaded = true;
                }
                inventoryError = errorText == null ? "" : errorText;
                refreshApps();
                if (errorText != null) showMessage("Unable to read apps", errorText);
                if (inventoryRefreshQueued && resumed) loadApps();
            });
        });
    }

    private void refreshApps() {
        visibleApps.clear();
        String search = appSearch.trim().toLowerCase(Locale.ROOT);
        Set<String> availablePackages = new HashSet<>();
        for (AppEntry app : installedApps) availablePackages.add(app.packageName);
        int unavailable = 0;
        if (appsLoaded) {
            List<String> savedPackages = new ArrayList<>(blocked);
            Collections.sort(savedPackages);
            for (String saved : savedPackages) {
                if (availablePackages.contains(saved)) continue;
                unavailable++;
                if (search.isEmpty() || saved.toLowerCase(Locale.ROOT).contains(search)
                    || "unavailable app".contains(search)) {
                    visibleApps.add(new AppEntry(saved, "Unavailable app", null, false, true));
                }
            }
        }
        for (AppEntry app : installedApps) {
            if (app.system && !showSystemApps) continue;
            if (!search.isEmpty() && !app.name.toLowerCase(Locale.ROOT).contains(search)
                && !app.packageName.toLowerCase(Locale.ROOT).contains(search)) continue;
            visibleApps.add(app);
        }
        if (appAdapter != null) appAdapter.notifyDataSetChanged();
        if (appSummary != null) {
            appSummary.setText(appsLoaded
                ? blocked.size() + " SELECTED  /  " + visibleApps.size() + " SHOWN"
                    + (unavailable > 0 ? "\n" + unavailable + " UNAVAILABLE" : "")
                : inventoryError.isEmpty() ? "READING INSTALLED APPS" : "APP LIST UNAVAILABLE");
        }
        if (appEmpty != null) {
            appEmpty.setVisibility(visibleApps.isEmpty() ? View.VISIBLE : View.GONE);
            appEmpty.setText(!appsLoaded ? (inventoryError.isEmpty() ? "Reading installed apps…"
                : "Android could not provide the app list. Reopen VGuard to try again.")
                : "No apps match this view.\nTry a different search or include system apps.");
        }
    }

    private void setAppBlocked(AppEntry app, boolean enabled) {
        Set<String> updated = new LinkedHashSet<>(blocked);
        if (enabled) updated.add(app.packageName);
        else updated.remove(app.packageName);
        blocked = updated;
        RuleStore.setBlocked(this, mode, updated);
        applyIfRunning();
        refreshApps();
        refreshStatus();
    }

    private final class AppAdapter extends BaseAdapter {
        @Override public int getCount() { return visibleApps.size(); }
        @Override public AppEntry getItem(int position) { return visibleApps.get(position); }
        @Override public long getItemId(int position) { return getItem(position).packageName.hashCode(); }
        @Override public View getView(int position, View convertView, ViewGroup parent) {
            final AppHolder holder;
            if (convertView == null) {
                LinearLayout entry = row();
                entry.setGravity(Gravity.CENTER_VERTICAL);
                entry.setMinimumHeight(dp(86));
                entry.setPadding(dp(1), dp(12), dp(1), dp(12));
                ImageView icon = new ImageView(MainActivity.this);
                icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
                icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                entry.addView(icon, new LinearLayout.LayoutParams(dp(36), dp(36)));
                LinearLayout names = column();
                names.setPadding(dp(12), 0, dp(10), 0);
                TextView name = label("", 14, TEXT, true);
                name.setMaxLines(2);
                name.setEllipsize(TextUtils.TruncateAt.END);
                TextView packageName = label("", 10, QUIET, false);
                packageName.setTypeface(Typeface.MONOSPACE);
                packageName.setMaxLines(2);
                packageName.setEllipsize(TextUtils.TruncateAt.MIDDLE);
                packageName.setPadding(0, dp(5), 0, 0);
                names.addView(name);
                names.addView(packageName);
                names.setMinimumHeight(dp(48));
                names.setGravity(Gravity.CENTER_VERTICAL);
                names.setBackground(ripple(Color.TRANSPARENT, Color.TRANSPARENT, 5));
                entry.addView(names, new LinearLayout.LayoutParams(0, -2, 1));
                Switch control = makeSwitch();
                control.setText("Block");
                control.setTextSize(11);
                control.setTextColor(MUTED);
                control.setSwitchPadding(dp(6));
                entry.addView(control, new LinearLayout.LayoutParams(-2, -2));
                holder = new AppHolder(icon, name, packageName, names, control);
                entry.setTag(holder);
                convertView = entry;
            } else holder = (AppHolder) convertView.getTag();
            final AppEntry app = getItem(position);
            holder.icon.setImageDrawable(app.icon);
            holder.name.setText(app.name);
            holder.name.setTextColor(app.unavailable ? AMBER : TEXT);
            holder.packageName.setText(app.packageName);
            holder.control.setOnCheckedChangeListener(null);
            holder.control.setChecked(blocked.contains(app.packageName));
            holder.control.setContentDescription(app.unavailable
                ? "Keep saved blocking rule for " + app.packageName + ", app unavailable"
                : "Block internet for " + app.name);
            holder.control.setOnCheckedChangeListener((buttonView, checked) -> setAppBlocked(app, checked));
            holder.names.setContentDescription(app.unavailable
                ? "Saved rule for " + app.packageName + ". App unavailable. Turn Block off to remove this rule."
                : "Open Android permissions for " + app.name);
            holder.names.setOnClickListener(app.unavailable ? null : v -> openSettings(
                new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + app.packageName))));
            holder.names.setClickable(!app.unavailable);
            return convertView;
        }
    }

    private View buildActivity() {
        LinearLayout content = screenContent();
        addHeading(content, "LOCAL RECORD", "Connection activity",
            "Recent packet metadata for this app session. No message contents are recorded.");
        content.addView(gap(20));
        LinearLayout actions = row();
        exportButton = button("Export CSV", false);
        clearButton = button("Clear activity", false);
        exportButton.setOnClickListener(v -> beginExport());
        clearButton.setOnClickListener(v -> new AlertDialog.Builder(this)
            .setTitle("Clear local activity?")
            .setMessage("This clears the activity entries on this phone. Your app rules stay the same.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Clear", (dialog, which) -> {
                GuardService.clearEvents(this);
                renderedEventSignature = Long.MIN_VALUE;
                refreshEvents();
            }).show());
        LinearLayout.LayoutParams left = new LinearLayout.LayoutParams(0, -2, 1);
        left.rightMargin = dp(5);
        actions.addView(exportButton, left);
        LinearLayout.LayoutParams right = new LinearLayout.LayoutParams(0, -2, 1);
        right.leftMargin = dp(5);
        actions.addView(clearButton, right);
        content.addView(actions);
        activitySummary = micro("NO ENTRIES", QUIET);
        activitySummary.setPadding(0, dp(20), 0, dp(12));
        content.addView(activitySummary);
        activityItems = column();
        content.addView(activityItems);
        TextView note = paragraph("VGuard keeps the latest 200 entries in memory; Android ending the app process clears them. This build does not attribute packets to individual apps. A background connection alone does not show spyware or explain why an app connected.");
        note.setTextSize(12);
        note.setPadding(0, dp(18), 0, 0);
        content.addView(note);
        renderedEventSignature = Long.MIN_VALUE;
        refreshEvents();
        return scroll(content);
    }

    private void refreshEvents() {
        if (activityItems == null) return;
        List<PacketInfo> events = GuardService.events();
        long signature = events.size();
        if (!events.isEmpty()) {
            PacketInfo newest = events.get(0);
            signature = signature * 31 + newest.timestamp;
            signature = signature * 31 + textOr(newest.destination, "").hashCode();
        }
        if (signature == renderedEventSignature) return;
        renderedEventSignature = signature;
        activityItems.removeAllViews();
        exportButton.setEnabled(!events.isEmpty());
        clearButton.setEnabled(!events.isEmpty());
        exportButton.setAlpha(events.isEmpty() ? 0.45f : 1f);
        clearButton.setAlpha(events.isEmpty() ? 0.45f : 1f);
        int shown = Math.min(events.size(), 100);
        activitySummary.setText(events.isEmpty() ? "NO ENTRIES THIS APP SESSION" : "LATEST " + shown + " OF " + events.size() + " SESSION ENTRIES");
        if (events.isEmpty()) {
            LinearLayout empty = card();
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(22), dp(35), dp(22), dp(35));
            MarkView icon = new MarkView(this, 2);
            icon.tint = QUIET;
            empty.addView(icon, new LinearLayout.LayoutParams(dp(30), dp(30)));
            TextView title = label("No activity recorded", 18, TEXT, true);
            title.setGravity(Gravity.CENTER);
            title.setPadding(0, dp(17), 0, dp(7));
            empty.addView(title);
            TextView copy = paragraph("When blocking is active, discarded packets appear here.");
            copy.setGravity(Gravity.CENTER);
            empty.addView(copy);
            activityItems.addView(empty);
            return;
        }
        SimpleDateFormat time = new SimpleDateFormat("dd MMM · HH:mm:ss", Locale.getDefault());
        for (int i = 0; i < shown; i++) {
            PacketInfo event = events.get(i);
            LinearLayout item = card();
            item.setPadding(dp(15), dp(14), dp(15), dp(14));
            LinearLayout top = row();
            TextView name = label(textOr(event.appName, "App not identified"), 14, TEXT, true);
            name.setMaxLines(2);
            top.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
            TextView dropped = micro("DROPPED", ACCENT);
            dropped.setPadding(dp(10), dp(2), 0, 0);
            top.addView(dropped);
            item.addView(top);
            String endpoint = textOr(event.destination, "Destination unavailable");
            if (event.port > 0) endpoint += (endpoint.contains(":") ? "  port " : ":") + event.port;
            TextView address = label(endpoint, 12, MUTED, false);
            address.setTypeface(Typeface.MONOSPACE);
            address.setTextIsSelectable(true);
            address.setPadding(0, dp(7), 0, dp(8));
            item.addView(address);
            item.addView(micro(textOr(event.protocol, "UNKNOWN") + "  /  " + time.format(new Date(event.timestamp)), QUIET));
            activityItems.addView(item);
            if (i < shown - 1) activityItems.addView(gap(8));
        }
    }

    private View buildSettings() {
        LinearLayout content = screenContent();
        addHeading(content, "CONFIGURATION", "Control & scope",
            "Understand what the firewall controls and review Android’s own settings.");
        content.addView(gap(23));
        addInfoCard(content, "Android VPN connection",
            "Only one VPN can be active in this user profile. VGuard uses that slot to filter selected apps locally. Starting it can disconnect a separate VPN.",
            "Open VPN settings", () -> openSettings(new Intent(Settings.ACTION_VPN_SETTINGS)));
        content.addView(gap(12));
        addInfoCard(content, "App permissions",
            "Internet access is separate from camera, microphone, location and file permissions. Review each app’s permissions in Android. You can also tap an app name in VGuard’s Apps tab.",
            "Open Android app settings", () -> openSettings(new Intent(Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS)));
        content.addView(gap(12));
        addInfoCard(content, "Status notification",
            "Allow VGuard’s notification to keep its running status and Stop control available outside the app. Android controls whether the notification is shown.",
            "Notification settings", this::notificationSettings);
        content.addView(gap(12));
        addInfoCard(content, "GrapheneOS Network permission",
            "On GrapheneOS, an app’s Network permission can keep it offline without using the VPN slot. Change that permission in Android’s app settings. VGuard does not change another app’s permissions automatically.",
            null, null);
        content.addView(gap(12));
        addInfoCard(content, "How this build behaves",
            "Selected apps’ network traffic is routed into VGuard and discarded. Other apps keep their normal connection. VGuard stops if Android revokes or stops its VPN.\n\nThis build does not support Android’s always-on VPN or “Block connections without VPN” setting. It does not replace a separate VPN’s privacy features.",
            null, null);
        content.addView(gap(12));
        addInfoCard(content, "Protection scope",
            "VGuard controls covered app internet traffic. It is not a spyware scanner and cannot control mobile-network signalling, Bluetooth devices or a separate tracker.\n\nA blocked app may keep information locally and send it after internet access is restored.",
            null, null);
        content.addView(gap(12));
        addInfoCard(content, "Your local data",
            "App selections are saved on this phone. The latest 200 activity entries are kept only in memory and disappear when Android ends the app process. No account or cloud service is required.\n\nActivity contains packet metadata without individual app attribution or message contents. Exporting creates a file at a location you choose.",
            null, null);
        content.addView(gap(22));
        addPreviewNotice(content);
        String version = "Preview";
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (PackageManager.NameNotFoundException ignored) { }
        TextView release = micro("VGUARD  /  " + version, QUIET);
        release.setPadding(0, dp(18), 0, 0);
        content.addView(release);
        return scroll(content);
    }

    private void addInfoCard(LinearLayout parent, String title, String copy, String action, Runnable task) {
        LinearLayout info = card();
        info.addView(label(title, 17, TEXT, true));
        TextView body = paragraph(copy);
        body.setPadding(0, dp(9), 0, 0);
        info.addView(body);
        if (action != null) {
            info.addView(gap(17));
            TextView button = button(action, false);
            button.setOnClickListener(v -> task.run());
            info.addView(button);
        }
        parent.addView(info);
    }

    private void addPreviewNotice(LinearLayout parent) {
        LinearLayout notice = column();
        notice.setPadding(dp(15), dp(13), dp(15), dp(14));
        notice.setBackground(surface(PANEL_ALT, LINE, 7));
        notice.addView(micro("DEVELOPMENT PREVIEW", AMBER));
        TextView copy = paragraph("Real-phone verification is still required. Confirm that selected apps cannot connect and other apps work before relying on these rules.");
        copy.setTextSize(12);
        copy.setPadding(0, dp(7), 0, 0);
        notice.addView(copy);
        parent.addView(notice);
    }

    private void refreshStatus() {
        GuardService.State state = GuardService.snapshot();
        String phase = textOr(state.phase, "OFF");
        boolean active = "ACTIVE".equals(phase);
        boolean starting = "STARTING".equals(phase);
        boolean error = "ERROR".equals(phase);
        int tint = active ? ACCENT : (error ? AMBER : QUIET);
        headerState.setText(phase);
        headerState.setTextColor(tint);
        headerDot.setBackground(surface(tint, tint, 20));
        if (phaseText != null) {
            phaseText.setText(phase);
            phaseText.setTextColor(tint);
            phaseDot.setBackground(surface(tint, tint, 20));
            phaseTitle.setText(active ? "Selected apps are blocked"
                : starting ? "Starting blocking…" : error ? "Blocking needs attention" : "Blocking is off");
            String detail;
            if (active) detail = titleCase(textOr(state.mode, mode))
                + " rules are active. Other apps keep their normal connection.";
            else if (starting) detail = "Waiting for Android to establish the local VPN interface.";
            else if (error) detail = textOr(state.error, "Android could not keep blocking active. Review your settings, then try again.");
            else detail = blocked.isEmpty() ? "Choose at least one app in the Apps tab, then start blocking."
                : blocked.size() + (blocked.size() == 1 ? " app selected. " : " apps selected. ")
                    + "Start blocking to apply your " + titleCase(mode) + " rules.";
            phaseDetail.setText(detail);
            countValue.setText(Integer.toString(active ? state.blockedCount : blocked.size()));
            countLabel.setText(active ? "BLOCKED APPS" : "SELECTED APPS");
            packetValue.setText(String.format(Locale.getDefault(), "%,d", state.droppedPackets));
            bytesValue.setText(Formatter.formatShortFileSize(this, state.droppedBytes) + " DISCARDED");
            sessionValue.setText(active && state.startedAt > 0
                ? elapsed(System.currentTimeMillis() - state.startedAt) : "NO ACTIVE SESSION");
            startButton.setText(active ? "Stop blocking" : starting ? "Starting…" : error ? "Retry blocking" : "Start blocking");
            startButton.setEnabled(!starting && !consentPending);
            startButton.setAlpha(starting || consentPending ? 0.6f : 1f);
            startButton.setBackground(ripple(active ? PANEL_ALT : ACCENT, active ? LINE : ACCENT, 7));
            startButton.setTextColor(active ? TEXT : INK);
            paintModeSelector(modeButtons);
        }
        if (tab == 2) refreshEvents();
    }

    private void toggleBlocking() {
        GuardService.State state = GuardService.snapshot();
        if ("ACTIVE".equals(state.phase) || "STARTING".equals(state.phase)) {
            sendServiceAction(GuardService.ACTION_STOP, false);
            return;
        }
        if (blocked.isEmpty()) {
            new AlertDialog.Builder(this)
                .setTitle("Choose an app first")
                .setMessage("Turn on Block for at least one app in this profile. VGuard will keep that app’s internet traffic offline while blocking is active.")
                .setNegativeButton("Close", null)
                .setPositiveButton("Choose apps", (dialog, which) -> showTab(1)).show();
            return;
        }
        final Intent consent;
        try { consent = VpnService.prepare(this); }
        catch (RuntimeException failure) {
            showMessage("VPN unavailable", safeError(failure));
            return;
        }
        if (consent == null) {
            sendServiceAction(GuardService.ACTION_START, true);
        } else {
            new AlertDialog.Builder(this)
                .setTitle("Use Android’s VPN connection?")
                .setMessage("VGuard filters selected apps locally using Android’s VPN connection. Starting it replaces any other VPN in this user profile. It does not send your traffic to a VPN server.\n\nAndroid will ask you to approve this connection next.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Continue", (dialog, which) -> {
                    try {
                        consentPending = true;
                        pendingStartMode = mode;
                        pendingStartRules = new LinkedHashSet<>(blocked);
                        startActivityForResult(consent, CONSENT_REQUEST);
                        refreshStatus();
                    } catch (ActivityNotFoundException failure) {
                        consentPending = false;
                        pendingStartMode = null;
                        pendingStartRules = null;
                        showMessage("VPN permission unavailable", "Android could not open its VPN permission screen.");
                    }
                }).show();
        }
    }

    private void applyIfRunning() {
        String phase = GuardService.snapshot().phase;
        if (!"ACTIVE".equals(phase) && !"STARTING".equals(phase)) return;
        if (blocked.isEmpty()) {
            sendServiceAction(GuardService.ACTION_STOP, false);
            Toast.makeText(this, "Blocking stopped: no apps selected in this profile.", Toast.LENGTH_LONG).show();
        } else sendServiceAction(GuardService.ACTION_APPLY, true);
    }

    private void sendServiceAction(String action, boolean foreground) {
        try {
            Intent intent = new Intent(this, GuardService.class);
            intent.setAction(action);
            intent.putExtra("mode", mode);
            if (foreground && Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
            else startService(intent);
            handler.postDelayed(this::refreshStatus, 150L);
        } catch (RuntimeException failure) {
            showMessage("Unable to change blocking", safeError(failure));
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == CONSENT_REQUEST) {
            consentPending = false;
            String requestedMode = pendingStartMode;
            Set<String> requestedRules = pendingStartRules;
            pendingStartMode = null;
            pendingStartRules = null;
            mode = RuleStore.getMode(this);
            blocked = new LinkedHashSet<>(RuleStore.getBlocked(this, mode));
            if (resultCode == RESULT_OK) {
                if (requestedMode == null || requestedRules == null
                    || !mode.equals(requestedMode) || !blocked.equals(requestedRules)) {
                    showMessage("Review your rules before starting",
                        "The selected profile or rules changed, or Android restarted VGuard while permission was open. Blocking was not started. Review the current rules, then tap Start again.");
                } else if (blocked.isEmpty()) {
                    Toast.makeText(this, "Choose at least one app before starting.", Toast.LENGTH_LONG).show();
                } else sendServiceAction(GuardService.ACTION_START, true);
            } else {
                Toast.makeText(this, "VPN permission was not granted. No blocking was started by this request.", Toast.LENGTH_LONG).show();
            }
            paintModeSelector(modeButtons);
            refreshApps();
            refreshStatus();
        } else if (requestCode == EXPORT_REQUEST) {
            List<PacketInfo> snapshot = pendingExport;
            pendingExport = null;
            exportPending = false;
            if (resultCode == RESULT_OK) {
                if (snapshot == null) {
                    showMessage("Export interrupted",
                        "Android restarted VGuard before the export finished. No activity was written to the selected file. Please export again.");
                } else if (data == null || data.getData() == null) {
                    showMessage("Export unavailable", "Android did not return a document to write. Please export again.");
                } else exportEvents(data.getData(), new ArrayList<>(snapshot));
            }
        }
    }

    private void beginExport() {
        List<PacketInfo> events = GuardService.events();
        if (events.isEmpty()) return;
        pendingExport = new ArrayList<>(events);
        exportPending = true;
        Intent export = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        export.addCategory(Intent.CATEGORY_OPENABLE);
        export.setType("text/csv");
        export.putExtra(Intent.EXTRA_TITLE, "VGuard-activity-"
            + new SimpleDateFormat("yyyyMMdd-HHmm", Locale.ROOT).format(new Date()) + ".csv");
        try { startActivityForResult(export, EXPORT_REQUEST); }
        catch (ActivityNotFoundException failure) {
            pendingExport = null;
            exportPending = false;
            showMessage("Export unavailable", "Android’s file picker is not available on this device.");
        }
    }

    private void exportEvents(final Uri uri, final List<PacketInfo> events) {
        worker.execute(() -> {
            String failure = null;
            try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new IllegalStateException("The chosen file could not be opened.");
                StringBuilder csv = new StringBuilder("timestamp_utc,app,destination,port,protocol\r\n");
                SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
                iso.setTimeZone(TimeZone.getTimeZone("UTC"));
                for (PacketInfo event : events) {
                    csv.append(csvCell(iso.format(new Date(event.timestamp)))).append(',')
                        .append(csvCell(event.appName)).append(',')
                        .append(csvCell(event.destination)).append(',')
                        .append(event.port > 0 ? Integer.toString(event.port) : "").append(',')
                        .append(csvCell(event.protocol)).append("\r\n");
                }
                output.write(csv.toString().getBytes(StandardCharsets.UTF_8));
            } catch (Exception error) { failure = safeError(error); }
            final String errorText = failure;
            handler.post(() -> {
                if (isDestroyed() || isFinishing()) return;
                if (errorText == null) Toast.makeText(this, "Activity exported.", Toast.LENGTH_LONG).show();
                else showMessage("Could not export activity", errorText);
            });
        });
    }

    private static String csvCell(String value) {
        String safe = value == null ? "" : value.replace("\r", " ").replace("\n", " ");
        if (!safe.isEmpty() && "=+-@\t".indexOf(safe.charAt(0)) >= 0) safe = "'" + safe;
        return "\"" + safe.replace("\"", "\"\"") + "\"";
    }

    private void openSettings(Intent intent) {
        try { startActivity(intent); }
        catch (ActivityNotFoundException failure) {
            showMessage("Settings unavailable", "This Android build does not expose that settings screen. Open Settings manually to continue.");
        }
    }

    private void notificationSettings() {
        // Opening the system page works after repeated permission denial too.
        Intent settings = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        settings.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        openSettings(settings);
    }

    private void showMessage(String title, String message) {
        if (isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this).setTitle(title).setMessage(message).setPositiveButton("OK", null).show();
    }

    private ScrollView scroll(LinearLayout content) {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipToPadding(false);
        scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        return scroll;
    }

    private LinearLayout screenContent() {
        LinearLayout content = column();
        content.setPadding(dp(22), dp(25), dp(22), dp(26));
        return content;
    }

    private void addHeading(LinearLayout parent, String eyebrow, String title, String copy) {
        parent.addView(micro(eyebrow, ACCENT));
        TextView heading = label(title, 27, TEXT, true);
        heading.setPadding(0, dp(12), 0, dp(8));
        parent.addView(heading);
        parent.addView(paragraph(copy));
    }

    private LinearLayout card() {
        LinearLayout card = column();
        card.setPadding(dp(19), dp(19), dp(19), dp(19));
        card.setBackground(surface(PANEL, LINE, 10));
        return card;
    }

    private LinearLayout column() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        return view;
    }

    private LinearLayout row() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        return view;
    }

    private TextView label(String text, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setTypeface(Typeface.create("sans-serif", bold ? Typeface.BOLD : Typeface.NORMAL));
        view.setIncludeFontPadding(false);
        view.setLineSpacing(dp(2), 1f);
        return view;
    }

    private TextView micro(String text, int color) {
        TextView view = label(text, 10, color, false);
        view.setTypeface(Typeface.MONOSPACE);
        view.setLetterSpacing(0.07f);
        return view;
    }

    private TextView paragraph(String text) {
        TextView view = label(text, 14, MUTED, false);
        view.setLineSpacing(dp(5), 1f);
        return view;
    }

    private TextView number(String text) {
        TextView view = label(text, 29, TEXT, false);
        view.setTypeface(Typeface.create("sans-serif-light", Typeface.NORMAL));
        view.setPadding(0, 0, 0, dp(7));
        return view;
    }

    private TextView button(String title, boolean primary) {
        TextView button = label(title, 14, primary ? INK : TEXT, true);
        button.setGravity(Gravity.CENTER);
        button.setMinimumHeight(dp(52));
        button.setPadding(dp(14), dp(13), dp(14), dp(13));
        button.setFocusable(true);
        button.setClickable(true);
        button.setBackground(ripple(primary ? ACCENT : PANEL_ALT, primary ? ACCENT : LINE, 7));
        return button;
    }

    private Switch makeSwitch() {
        Switch control = new Switch(this);
        control.setMinimumHeight(dp(48));
        control.setMinimumWidth(dp(48));
        control.setThumbTintList(new ColorStateList(
            new int[][] {new int[] {android.R.attr.state_checked}, new int[] {}},
            new int[] {ACCENT, MUTED}));
        control.setTrackTintList(new ColorStateList(
            new int[][] {new int[] {android.R.attr.state_checked}, new int[] {}},
            new int[] {Color.rgb(67, 84, 59), LINE}));
        return control;
    }

    private View gap(int height) {
        View gap = new View(this);
        gap.setLayoutParams(new LinearLayout.LayoutParams(1, dp(height)));
        return gap;
    }

    private View hairline() {
        View line = new View(this);
        line.setBackgroundColor(LINE);
        line.setLayoutParams(new LinearLayout.LayoutParams(-1, Math.max(1, dp(1))));
        return line;
    }

    private View dot(int color, int size) {
        View dot = new View(this);
        dot.setBackground(surface(color, color, size));
        return dot;
    }

    private GradientDrawable surface(int fill, int border, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radius));
        drawable.setStroke(dp(1), border);
        return drawable;
    }

    private Drawable ripple(int fill, int border, int radius) {
        return new RippleDrawable(ColorStateList.valueOf(Color.argb(28, 185, 200, 177)),
            surface(fill, border, radius), surface(Color.WHITE, Color.WHITE, radius));
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private static String textOr(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    private static String titleCase(String input) {
        return input.isEmpty() ? input : input.substring(0, 1).toUpperCase(Locale.ROOT) + input.substring(1);
    }

    private static String safeError(Throwable error) {
        return textOr(error.getMessage(), error.getClass().getSimpleName());
    }

    private static String elapsed(long millis) {
        long seconds = Math.max(0, millis / 1000);
        return String.format(Locale.ROOT, "%02d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60);
    }

    private static final class AppEntry {
        final String packageName;
        final String name;
        final Drawable icon;
        final boolean system;
        final boolean unavailable;
        AppEntry(String packageName, String name, Drawable icon, boolean system) {
            this(packageName, name, icon, system, false);
        }
        AppEntry(String packageName, String name, Drawable icon, boolean system, boolean unavailable) {
            this.packageName = packageName;
            this.name = name;
            this.icon = icon;
            this.system = system;
            this.unavailable = unavailable;
        }
    }

    private static final class RetainedUiState {
        final List<PacketInfo> pendingExport;
        final boolean exportPending;
        final boolean consentPending;
        final String pendingStartMode;
        final Set<String> pendingStartRules;
        RetainedUiState(List<PacketInfo> pendingExport, boolean exportPending, boolean consentPending,
                        String pendingStartMode, Set<String> pendingStartRules) {
            this.pendingExport = pendingExport;
            this.exportPending = exportPending;
            this.consentPending = consentPending;
            this.pendingStartMode = pendingStartMode;
            this.pendingStartRules = pendingStartRules == null ? null : new LinkedHashSet<>(pendingStartRules);
        }
    }

    private static final class AppHolder {
        final ImageView icon;
        final TextView name;
        final TextView packageName;
        final LinearLayout names;
        final Switch control;
        AppHolder(ImageView icon, TextView name, TextView packageName, LinearLayout names, Switch control) {
            this.icon = icon;
            this.name = name;
            this.packageName = packageName;
            this.names = names;
            this.control = control;
        }
    }

    /** Small original vector marks: shield, apps, activity, controls, and V + shield. */
    private final class MarkView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int kind;
        int tint = QUIET;
        MarkView(Context context, int kind) {
            super(context);
            this.kind = kind;
            setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            canvas.save();
            canvas.scale(getWidth() / 24f, getHeight() / 24f);
            paint.setColor(tint);
            paint.setStrokeWidth(kind == 4 ? 1.3f : 1.5f);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.SQUARE);
            paint.setStrokeJoin(Paint.Join.ROUND);
            if (kind == 0) {
                drawShield(canvas, 4, 2, 16, 20);
            } else if (kind == 1) {
                canvas.drawRoundRect(3, 3, 9, 9, 1, 1, paint);
                canvas.drawRoundRect(15, 3, 21, 9, 1, 1, paint);
                canvas.drawRoundRect(3, 15, 9, 21, 1, 1, paint);
                canvas.drawRoundRect(15, 15, 21, 21, 1, 1, paint);
            } else if (kind == 2) {
                canvas.drawLine(7, 5, 21, 5, paint);
                canvas.drawLine(7, 12, 21, 12, paint);
                canvas.drawLine(7, 19, 17, 19, paint);
                canvas.drawLine(3, 5, 3.1f, 5, paint);
                canvas.drawLine(3, 12, 3.1f, 12, paint);
                canvas.drawLine(3, 19, 3.1f, 19, paint);
            } else if (kind == 3) {
                canvas.drawLine(3, 6, 8, 6, paint);
                canvas.drawLine(12, 6, 21, 6, paint);
                canvas.drawCircle(10, 6, 2, paint);
                canvas.drawLine(3, 17, 13, 17, paint);
                canvas.drawLine(17, 17, 21, 17, paint);
                canvas.drawCircle(15, 17, 2, paint);
            } else {
                Path v = new Path();
                v.moveTo(1, 5);
                v.lineTo(6.3f, 19);
                v.lineTo(11.6f, 5);
                canvas.drawPath(v, paint);
                drawShield(canvas, 14, 5, 8, 14);
            }
            canvas.restore();
        }
        private void drawShield(Canvas canvas, float x, float y, float width, float height) {
            Path shield = new Path();
            shield.moveTo(x + width / 2, y);
            shield.lineTo(x + width, y + height * 0.17f);
            shield.lineTo(x + width, y + height * 0.51f);
            shield.cubicTo(x + width, y + height * 0.72f,
                x + width * 0.75f, y + height * 0.88f, x + width / 2, y + height);
            shield.cubicTo(x + width * 0.25f, y + height * 0.88f,
                x, y + height * 0.72f, x, y + height * 0.51f);
            shield.lineTo(x, y + height * 0.17f);
            shield.close();
            canvas.drawPath(shield, paint);
        }
    }
}
