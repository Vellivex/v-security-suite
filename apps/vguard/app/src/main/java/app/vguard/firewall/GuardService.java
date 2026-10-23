package app.vguard.firewall;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.VpnService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructPollfd;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * An explicit, selective-block local VPN. Only the selected packages are routed
 * into its TUN interface. Every packet read there is discarded. Other packages
 * retain normal system networking. There is no forwarding or external server.
 */
public final class GuardService extends VpnService {
    public static final String ACTION_START = "app.vguard.firewall.START";
    public static final String ACTION_APPLY = "app.vguard.firewall.APPLY";
    public static final String ACTION_STOP = "app.vguard.firewall.STOP";
    public static final String EXTRA_MODE = "mode";

    private static final String CHANNEL_ID = "vguard_blocking";
    private static final int NOTIFICATION_ID = 41;
    private static final int EVENT_LIMIT = 200;
    private static final Object LOCK = new Object();
    private static final Deque<PacketInfo> HISTORY = new ArrayDeque<PacketInfo>();
    private static long ownerSequence;
    private static long currentOwner;
    private static long tokenSequence;
    private static long currentToken;
    private static String phase = "OFF";
    private static String mode = RuleStore.MODE_NORMAL;
    private static String error = "";
    private static int blockedCount;
    private static long droppedPackets;
    private static long droppedBytes;
    private static long startedAt;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private long ownerId;
    private volatile Session activeSession;
    private boolean foreground;
    private boolean packageReceiverRegistered;
    private final BroadcastReceiver packageChanges = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            Session running = activeSession;
            if (running == null || running.cancelled || running.closed.get()
                    || intent == null || intent.getData() == null) return;
            String currentPhase = snapshot().phase;
            if (!"ACTIVE".equals(currentPhase) && !"STARTING".equals(currentPhase)) return;
            if (Intent.ACTION_PACKAGE_REMOVED.equals(intent.getAction())
                    && intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return;
            String changedPackage = intent.getData().getSchemeSpecificPart();
            // Use the active mode's saved selection: an app absent at activation
            // may have just been installed again with a different Android UID.
            boolean relevant = RuleStore.getBlocked(GuardService.this, running.mode).contains(changedPackage);
            int changedUid = intent.getIntExtra(Intent.EXTRA_UID, -1);
            // Android VPN rules act on UIDs. A newly installed, unselected sibling
            // can share a selected UID, so package names alone are insufficient.
            if (running.uids.contains(Integer.valueOf(changedUid))) relevant = true;
            if (!relevant && changedUid < 0 && changedPackage != null) {
                try {
                    int resolvedUid = getPackageManager().getApplicationInfo(changedPackage, 0).uid;
                    relevant = running.uids.contains(Integer.valueOf(resolvedUid));
                } catch (PackageManager.NameNotFoundException removedPackage) {
                    // Removed selected package names were handled above.
                }
            }
            if (relevant) configure(running.mode);
        }
    };

    public static final class State {
        public final String phase;
        public final int blockedCount;
        public final long droppedPackets;
        public final long droppedBytes;
        public final long startedAt;
        public final String error;
        public final String mode;

        private State(String phase, int blockedCount, long droppedPackets,
                      long droppedBytes, long startedAt, String error, String mode) {
            this.phase = phase;
            this.blockedCount = blockedCount;
            this.droppedPackets = droppedPackets;
            this.droppedBytes = droppedBytes;
            this.startedAt = startedAt;
            this.error = error;
            this.mode = mode;
        }
    }

    public static State snapshot() {
        synchronized (LOCK) {
            return new State(phase, blockedCount, droppedPackets, droppedBytes,
                    startedAt, error, mode);
        }
    }

    /** Newest first; metadata is kept only in this app process, never on disk. */
    public static List<PacketInfo> events() {
        synchronized (LOCK) {
            return Collections.unmodifiableList(new ArrayList<PacketInfo>(HISTORY));
        }
    }

    /** Clears history, without altering rules, a running session, or its counters. */
    public static void clearEvents(Context unusedContext) {
        synchronized (LOCK) { HISTORY.clear(); }
    }

    @Override public void onCreate() {
        super.onCreate();
        synchronized (LOCK) {
            ownerId = ++ownerSequence;
            currentOwner = ownerId;
            currentToken = 0;
            mode = RuleStore.getMode(this);
            if ("ACTIVE".equals(phase) || "STARTING".equals(phase)) {
                phase = "OFF";
                blockedCount = 0;
                startedAt = 0;
            }
        }
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                "VGuard blocking", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shows when selected apps are blocked and provides a Stop button.");
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
        IntentFilter packages = new IntentFilter();
        packages.addAction(Intent.ACTION_PACKAGE_REMOVED);
        packages.addAction(Intent.ACTION_PACKAGE_ADDED);
        packages.addAction(Intent.ACTION_PACKAGE_REPLACED);
        packages.addDataScheme("package");
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(packageChanges, packages, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(packageChanges, packages);
        }
        packageReceiverRegistered = true;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            shutdown("OFF", "");
        } else if (ACTION_START.equals(action)) {
            configure(requestedMode(intent));
        } else if (ACTION_APPLY.equals(action)) {
            // Editing a rule set must not silently activate a stopped firewall.
            if (activeSession != null) configure(requestedMode(intent));
            else stopSelf();
        } else if (activeSession == null) {
            // No boot start, null-intent restart, or implicit activation.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private String requestedMode(Intent intent) {
        String requested = intent.getStringExtra(EXTRA_MODE);
        return RuleStore.normalizeMode(requested == null ? RuleStore.getMode(this) : requested);
    }

    private void configure(String requestedMode) {
        RuleStore.setMode(this, requestedMode);
        synchronized (LOCK) {
            if (currentOwner != ownerId) return;
            phase = "STARTING";
            error = "";
            mode = requestedMode;
        }
        try {
            showForeground("Starting selected-app blocking…");
            Set<String> requested = RuleStore.canonicalPackages(
                    RuleStore.getBlocked(this, requestedMode), getPackageName());
            if (requested.isEmpty()) {
                shutdown("ERROR", "Choose at least one app to block. VGuard is off.");
                return;
            }
            if (VpnService.prepare(this) != null) {
                shutdown("ERROR", "VPN permission is needed. Tap Start and approve Android's request.");
                return;
            }

            Builder builder = new Builder()
                    .setSession("VGuard selected-app blocking")
                    .setConfigureIntent(openAppIntent())
                    .setMtu(1500)
                    .addAddress("192.0.2.1", 32)
                    .addAddress("fd76:6775:6172:6400::1", 128)
                    .addRoute("0.0.0.0", 0)
                    .addRoute("::", 0)
                    // These addresses are inside the drop-only VPN routes, not
                    // external DNS services. Selected apps' DNS is discarded too.
                    .addDnsServer("192.0.2.53")
                    .addDnsServer("fd76:6775:6172:6400::53")
                    .setBlocking(false);

            TreeSet<String> installed = new TreeSet<String>();
            TreeSet<Integer> verifiedUids = new TreeSet<Integer>();
            PackageManager manager = getPackageManager();
            for (String packageName : requested) {
                if (getPackageName().equals(packageName)) continue;
                try {
                    ApplicationInfo application = manager.getApplicationInfo(packageName, 0);
                    String[] sameIdentity = manager.getPackagesForUid(application.uid);
                    if (sameIdentity != null) {
                        for (String sibling : sameIdentity) {
                            if (getPackageName().equals(sibling) || !requested.contains(sibling)) {
                                shutdown("ERROR", "Cannot block " + packageName + " separately: it shares "
                                        + "Android's network identity with another app. Remove it from this rule set. VGuard is off.");
                                return;
                            }
                        }
                    }
                    // Android calls this an 'allowed' list: these are the only
                    // apps allowed INTO our VPN, where their packets are dropped.
                    builder.addAllowedApplication(packageName);
                    installed.add(packageName);
                    verifiedUids.add(Integer.valueOf(application.uid));
                } catch (PackageManager.NameNotFoundException removedApp) {
                    // Uninstalled packages cannot be routed. Count only real entries.
                }
            }
            // SECURITY INVARIANT: an empty allowed list means ALL apps in Android.
            // Never call establish() unless at least one real non-self app was added.
            if (installed.isEmpty()) {
                shutdown("ERROR", "None of the selected apps are available. Choose an installed app. VGuard is off.");
                return;
            }

            // Establish the replacement first. Do not create a routing gap by
            // closing a working interface before Android has accepted the new one.
            ParcelFileDescriptor descriptor = builder.establish();
            if (descriptor == null) {
                shutdown("ERROR", "Android did not grant the VPN connection. VGuard is off; tap Start to retry.");
                return;
            }
            final Session replacement;
            synchronized (LOCK) {
                long token = ++tokenSequence;
                replacement = new Session(descriptor, token, requestedMode, installed.size(), verifiedUids);
                currentToken = token;
                phase = "STARTING";
                mode = requestedMode;
                error = "";
                blockedCount = installed.size();
                droppedPackets = 0;
                droppedBytes = 0;
                startedAt = 0;
            }
            Session previous = activeSession;
            activeSession = replacement;
            if (previous != null) previous.cancel();
            replacement.reader = new Thread(new Runnable() {
                @Override public void run() { readAndDiscard(replacement); }
            }, "VGuard-packet-sink");
            replacement.reader.setDaemon(true);
            replacement.reader.start();
        } catch (SecurityException denied) {
            shutdown("ERROR", "Android denied the VPN or foreground-service permission. VGuard is off.");
        } catch (RuntimeException failed) {
            shutdown("ERROR", "The local VPN could not start. Check your VPN settings and try again. VGuard is off.");
        }
    }

    private void readAndDiscard(final Session session) {
        String failure = null;
        try {
            synchronized (LOCK) {
                if (!isCurrent(session)) return;
                // ACTIVE is published only by the running worker, with a real TUN.
                phase = "ACTIVE";
                startedAt = System.currentTimeMillis();
            }
            mainHandler.post(new Runnable() {
                @Override public void run() {
                    if (activeSession == session && !session.cancelled
                            && "ACTIVE".equals(snapshot().phase)) {
                        try {
                            showForeground("Blocking " + session.count + " selected "
                                    + (session.count == 1 ? "app" : "apps") + " · "
                                    + (RuleStore.MODE_JOURNEY.equals(session.mode) ? "Journey" : "Normal"));
                        } catch (RuntimeException notificationFailed) {
                            shutdown("ERROR", "Android could not keep the foreground service running. VGuard is off.");
                        }
                    }
                }
            });
            byte[] packet = new byte[65575];
            StructPollfd poll = new StructPollfd();
            poll.fd = session.descriptor.getFileDescriptor();
            poll.events = (short) OsConstants.POLLIN;
            StructPollfd[] polls = new StructPollfd[] { poll };
            while (!session.cancelled) {
                int ready;
                try {
                    // A bounded wait plus a nonblocking FD makes stop/reconfigure
                    // cancellation safe even if no more packets ever arrive.
                    ready = Os.poll(polls, 1000);
                } catch (ErrnoException interrupted) {
                    if (interrupted.errno == OsConstants.EINTR) continue;
                    throw interrupted;
                }
                if (session.cancelled) break;
                if (ready == 0) continue;
                if ((poll.revents & (OsConstants.POLLERR | OsConstants.POLLHUP | OsConstants.POLLNVAL)) != 0) {
                    throw new IOException("VPN interface closed");
                }
                if ((poll.revents & OsConstants.POLLIN) == 0) continue;
                while (!session.cancelled) {
                    int count;
                    try {
                        count = Os.read(poll.fd, packet, 0, packet.length);
                    } catch (ErrnoException unavailable) {
                        if (unavailable.errno == OsConstants.EAGAIN) break;
                        if (unavailable.errno == OsConstants.EINTR) continue;
                        throw unavailable;
                    }
                    if (count <= 0) throw new IOException("VPN reader ended");
                    PacketInfo metadata = PacketInfo.parse(packet, count);
                    synchronized (LOCK) {
                        if (!isCurrent(session)) break;
                        droppedPackets++;
                        droppedBytes += count;
                        if (metadata != null) {
                            HISTORY.addFirst(metadata);
                            while (HISTORY.size() > EVENT_LIMIT) HISTORY.removeLast();
                        }
                    }
                    // No write, forwarding socket, payload log, or allow event.
                }
            }
        } catch (Exception unexpected) {
            if (!session.cancelled) {
                failure = "The local VPN reader stopped. VGuard is off; tap Start to resume blocking.";
            }
        } finally {
            session.close();
            if (!session.cancelled) {
                final String explanation = failure == null
                        ? "The local VPN stopped. VGuard is off; tap Start to resume blocking." : failure;
                synchronized (LOCK) {
                    if (currentOwner == ownerId && currentToken == session.token) {
                        phase = "ERROR";
                        error = explanation;
                        blockedCount = 0;
                        startedAt = 0;
                    }
                }
                mainHandler.post(new Runnable() {
                    @Override public void run() {
                        if (activeSession == session) shutdown("ERROR", explanation);
                    }
                });
            }
        }
    }

    // Call only under LOCK. A retired worker can never count or log a new session.
    private boolean isCurrent(Session session) {
        return !session.cancelled && currentOwner == ownerId
                && currentToken == session.token && activeSession == session;
    }

    private void shutdown(String nextPhase, String explanation) {
        synchronized (LOCK) {
            if (currentOwner == ownerId) {
                currentToken = 0;
                phase = nextPhase;
                error = explanation;
                blockedCount = 0;
                startedAt = 0;
            }
        }
        Session previous = activeSession;
        activeSession = null;
        if (previous != null) previous.cancel();
        removeForeground();
        stopSelf();
    }

    @Override public void onRevoke() {
        // Android may invoke onRevoke outside the main thread.
        final Session revoked = activeSession;
        final String explanation = "VPN access ended. VGuard is off. Tap Start to request access again.";
        synchronized (LOCK) {
            if (currentOwner == ownerId && (revoked == null || currentToken == revoked.token)) {
                currentToken = 0;
                phase = "ERROR";
                error = explanation;
                blockedCount = 0;
                startedAt = 0;
            }
        }
        if (revoked != null) revoked.cancel();
        mainHandler.post(new Runnable() {
            @Override public void run() {
                if (activeSession == revoked) shutdown("ERROR", explanation);
            }
        });
    }

    @Override public void onDestroy() {
        if (packageReceiverRegistered) {
            packageReceiverRegistered = false;
            unregisterReceiver(packageChanges);
        }
        synchronized (LOCK) {
            if (currentOwner == ownerId) {
                currentToken = 0;
                if ("ACTIVE".equals(phase) || "STARTING".equals(phase)) {
                    phase = "OFF";
                    error = "VGuard stopped. Start it again to resume blocking.";
                }
                blockedCount = 0;
                startedAt = 0;
            }
        }
        Session previous = activeSession;
        activeSession = null;
        if (previous != null) previous.cancel();
        removeForeground();
        super.onDestroy();
    }

    private PendingIntent openAppIntent() {
        Intent open = new Intent().setClassName(this, "app.vguard.firewall.MainActivity")
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void showForeground(String text) {
        Intent stop = new Intent(this, GuardService.class).setAction(ACTION_STOP);
        PendingIntent stopAction = PendingIntent.getService(this, 1, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle("VGuard")
                .setContentText(text)
                .setContentIntent(openAppIntent())
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopAction)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        foreground = true;
    }

    private void removeForeground() {
        if (foreground) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foreground = false;
        }
    }

    private static final class Session {
        final ParcelFileDescriptor descriptor;
        final long token;
        final String mode;
        final int count;
        final Set<Integer> uids;
        final AtomicBoolean closed = new AtomicBoolean(false);
        volatile boolean cancelled;
        volatile Thread reader;

        Session(ParcelFileDescriptor descriptor, long token, String mode, int count, Set<Integer> uids) {
            this.descriptor = descriptor;
            this.token = token;
            this.mode = mode;
            this.count = count;
            this.uids = Collections.unmodifiableSet(new TreeSet<Integer>(uids));
        }

        void cancel() {
            cancelled = true;
            close();
            Thread running = reader;
            if (running != null) running.interrupt();
        }

        void close() {
            if (closed.compareAndSet(false, true)) {
                try { descriptor.close(); } catch (IOException ignored) { }
            }
        }
    }
}
