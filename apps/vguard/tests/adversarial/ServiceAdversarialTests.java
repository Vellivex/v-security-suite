package app.vguard.firewall;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.system.OsConstants;
import testsupport.FakeAndroid;

import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/** Executes the unmodified production engine against controlled Android boundaries. */
public final class ServiceAdversarialTests {
    private static final String A = "example.selected.one";
    private static final String B = "example.selected.two";
    private static final String C = "example.unselected.other";
    private static GuardService service;
    private static int scenarios, failures, assertions;
    private static String filter = "";

    public static void main(String[] args) throws Exception {
        if (args.length > 0) filter = args[0];

        run("shared UID sibling installed after activation", () -> {
            for (boolean includesUid : new boolean[] {true, false}) {
                cleanup(); fresh(35); install(A, 12001); select("normal", A); start("normal");
                FakeAndroid.Tun original = FakeAndroid.latest();
                install(C, 12001);
                if (includesUid) FakeAndroid.broadcast(Intent.ACTION_PACKAGE_ADDED, C, 12001, false);
                else FakeAndroid.broadcastWithoutUid(Intent.ACTION_PACKAGE_ADDED, C);
                FakeAndroid.drainMain();
                check(!original.routesPackage(C), "unselected sibling inherited active UID route: phase="
                        + GuardService.snapshot().phase + ", uid=12001, eventHasUid=" + includesUid);
                check("ERROR".equals(GuardService.snapshot().phase), "shared UID scope change requires explicit error");
                check(original.closed && FakeAndroid.establishCalls == 1, "unsafe replacement never established");
            }
        });

        run("no implicit activation or apply while off", () -> {
            fresh(35); install(A, 12001); select("normal", A);
            check(service.onStartCommand(null, 0, 1) == 2, "null restart is not sticky");
            action(GuardService.ACTION_APPLY, "normal");
            FakeAndroid.broadcast(Intent.ACTION_PACKAGE_ADDED, A, 12001, false);
            check(FakeAndroid.establishCalls == 0 && "OFF".equals(GuardService.snapshot().phase), "no implicit VPN");
        });

        run("empty self-only missing and race-removed selections never establish", () -> {
            fresh(35); select("normal"); action(GuardService.ACTION_START, "normal");
            check(FakeAndroid.establishCalls == 0, "empty list cannot establish all-app VPN");
            select("normal", "app.vguard.firewall"); action(GuardService.ACTION_START, "normal");
            check(FakeAndroid.establishCalls == 0, "self-only list cannot establish");
            select("normal", A); action(GuardService.ACTION_START, "normal");
            check(FakeAndroid.establishCalls == 0, "missing-only list cannot establish");
            install(A, 12001); FakeAndroid.packages.disappearOnBuilderAdd = A;
            action(GuardService.ACTION_START, "normal");
            check(FakeAndroid.establishCalls == 0, "package disappearing during validation cannot establish");
            check("ERROR".equals(GuardService.snapshot().phase), "invalid selections report error");
        });

        run("partial missing selection and dual-family drop configuration", () -> {
            fresh(35); install(A, 12001); install(C, 12003); select("normal", A, B); start("normal");
            FakeAndroid.Tun tun = FakeAndroid.latest();
            check(tun.allowed.equals(set(A)), "only validated selected packages enter VPN");
            check(tun.routes.contains("0.0.0.0/0") && tun.routes.contains("::/0"), "IPv4 and IPv6 default routes");
            check(tun.dns.size() == 2 && tun.dns.contains("192.0.2.53"), "DNS is explicitly directed into drop tunnel");
            check(!tun.blocking && tun.mtu == 1500, "bounded-wait nonblocking sink");
            check(!tun.routesPackage(C) && !tun.routesPackage("app.vguard.firewall"), "unselected and own UID excluded");
            check(GuardService.snapshot().blockedCount == 1, "count reflects installed selected apps");
            check(GuardService.snapshot().droppedPackets == 0 && GuardService.events().isEmpty(), "no simulated activity");
        });

        run("initial shared UID subset rejected but complete group allowed", () -> {
            fresh(35); install(A, 12001); install(B, 12001); select("normal", A);
            action(GuardService.ACTION_START, "normal");
            check(FakeAndroid.establishCalls == 0 && "ERROR".equals(GuardService.snapshot().phase), "partial shared UID rejected");
            select("normal", A, B); start("normal");
            check(FakeAndroid.latest().allowed.equals(set(A, B)), "complete explicit shared group accepted");
            check(GuardService.snapshot().blockedCount == 2, "count reports selected packages, not unique UIDs");
        });

        run("consent foreground and establish failures remain off", () -> {
            fresh(35); install(A, 12001); select("normal", A); FakeAndroid.consent = false;
            action(GuardService.ACTION_START, "normal");
            check(FakeAndroid.establishCalls == 0 && "ERROR".equals(GuardService.snapshot().phase), "missing consent cannot establish");
            FakeAndroid.consent = true; FakeAndroid.failForeground = true;
            action(GuardService.ACTION_START, "normal");
            check(FakeAndroid.establishCalls == 0 && !service.frameworkForeground, "foreground failure cannot establish");
            for (String outcome : Arrays.asList("null", "security", "runtime")) {
                FakeAndroid.establishOutcomes.add(outcome); action(GuardService.ACTION_START, "normal");
                check("ERROR".equals(GuardService.snapshot().phase) && GuardService.snapshot().blockedCount == 0,
                        "establish " + outcome + " reports blocking off");
                check(!service.frameworkForeground, "failure removes ongoing status notification");
            }
        });

        run("API29 API33 API35 service and receiver branches", () -> {
            for (int api : new int[] {29, 33, 35}) {
                cleanup(); fresh(api); install(A, 12001); select("normal", A); start("normal");
                int expected = api >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
                check(service.foregroundType == expected, "foreground type API " + api);
                check(FakeAndroid.receivers.get(0).flags == (api >= 33 ? Context.RECEIVER_NOT_EXPORTED : 0), "receiver flags API " + api);
                check(service.notification.ongoing, "ongoing notification API " + api);
                check(GuardService.ACTION_STOP.equals(service.notification.stopAction.intent.getAction()), "notification has real Stop action");
            }
        });

        run("real packet accounting bounded history and metadata privacy", () -> {
            fresh(35); install(A, 12001); select("normal", A); start("normal");
            FakeAndroid.Tun tun = FakeAndroid.latest();
            byte[] malformed = new byte[] {0x10, 2, 3}; tun.enqueue(malformed);
            byte[] six = ipv6(444); tun.enqueue(six);
            for (int i = 0; i < 250; i++) tun.enqueue(ipv4(10000 + i, "PRIVATE_MESSAGE_SENTINEL"));
            await(() -> GuardService.snapshot().droppedPackets == 252, "packet accounting");
            long expected = malformed.length + six.length + 250L * ipv4(10000, "PRIVATE_MESSAGE_SENTINEL").length;
            check(GuardService.snapshot().droppedBytes == expected, "bytes equal actual read data, including unparseable packet");
            List<PacketInfo> history = GuardService.events();
            check(history.size() == 200 && history.get(0).port == 10249 && history.get(199).port == 10050, "latest 200 real metadata entries only");
            for (PacketInfo item : history) {
                for (Field field : PacketInfo.class.getDeclaredFields()) {
                    field.setAccessible(true); Object value = field.get(item);
                    check(!(value instanceof byte[]), "packet object has no retained payload buffer");
                    check(!(value instanceof String) || !((String) value).contains("PRIVATE_MESSAGE_SENTINEL"), "payload does not enter metadata");
                }
            }
            boolean immutable = false; try { history.clear(); } catch (UnsupportedOperationException expectedError) { immutable = true; }
            check(immutable, "public history snapshot is immutable");
            GuardService.clearEvents(service);
            check(GuardService.events().isEmpty() && history.size() == 200, "clear replaces history without mutating previous snapshot");
            check(GuardService.snapshot().droppedPackets == 252 && "ACTIVE".equals(GuardService.snapshot().phase), "clear does not restart or disable protection");
        });

        run("packet stream EOF read error and poll HUP shut down truthfully", () -> {
            for (int fault = 0; fault < 3; fault++) {
                cleanup(); fresh(35); install(A, 12001); select("normal", A); start("normal");
                FakeAndroid.Tun tun = FakeAndroid.latest();
                if (fault == 0) tun.signalZeroRead();
                else if (fault == 1) tun.faultRead(OsConstants.EIO);
                else tun.faultPoll(OsConstants.POLLHUP);
                await(() -> "ERROR".equals(GuardService.snapshot().phase), "reader failure status");
                await(() -> !FakeAndroid.mainQueue.isEmpty(), "reader failure cleanup callback");
                FakeAndroid.drainMain();
                check(tun.closed && GuardService.snapshot().blockedCount == 0 && !service.frameworkForeground, "stream failure closes TUN and notification");
                check(GuardService.snapshot().droppedPackets == 0, "failed reads never count as packets");
            }
        });

        run("transient interrupted read remains active", () -> {
            fresh(35); install(A, 12001); select("normal", A); start("normal");
            FakeAndroid.Tun tun = FakeAndroid.latest(); tun.faultRead(OsConstants.EINTR); tun.enqueue(ipv4(53, ""));
            await(() -> GuardService.snapshot().droppedPackets == 1, "interrupted read retry");
            check("ACTIVE".equals(GuardService.snapshot().phase), "EINTR does not masquerade as permanent failure");
        });

        run("foreground update failure stops active tunnel", () -> {
            fresh(35); install(A, 12001); select("normal", A); action(GuardService.ACTION_START, "normal");
            await(() -> "ACTIVE".equals(GuardService.snapshot().phase), "worker start");
            await(() -> !FakeAndroid.mainQueue.isEmpty(), "foreground update queued by worker");
            FakeAndroid.failForeground = true; FakeAndroid.drainMain();
            check("ERROR".equals(GuardService.snapshot().phase) && FakeAndroid.latest().closed, "notification update failure closes actual tunnel");
        });

        run("revoke immediate state invalidation and late callback isolation", () -> {
            fresh(35); install(A, 12001); select("normal", A); start("normal");
            FakeAndroid.Tun old = FakeAndroid.latest(); service.onRevoke();
            check("ERROR".equals(GuardService.snapshot().phase) && old.closed, "revoke invalidates status before queued callback runs");
            // Model a new, explicitly consented Start before the old callback executes.
            action(GuardService.ACTION_START, "normal"); await(() -> "ACTIVE".equals(GuardService.snapshot().phase), "explicit restart");
            FakeAndroid.drainMain();
            check("ACTIVE".equals(GuardService.snapshot().phase) && !FakeAndroid.latest().closed, "stale revoke callback cannot stop a newer session");
        });

        run("replacement ordering and retired-reader counter isolation", () -> {
            fresh(35); install(A, 12001); install(B, 12002); select("normal", A); select("journey", B); start("normal");
            FakeAndroid.Tun old = FakeAndroid.latest();
            old.readEntered = new CountDownLatch(1); old.releaseRead = new CountDownLatch(1);
            old.enqueue(ipv4(101, "OLD_PAYLOAD"));
            check(old.readEntered.await(2, TimeUnit.SECONDS), "old reader held at actual read boundary");
            action(GuardService.ACTION_APPLY, "journey"); await(() -> "ACTIVE".equals(GuardService.snapshot().phase) && "journey".equals(GuardService.snapshot().mode), "replacement activation");
            FakeAndroid.Tun replacement = FakeAndroid.latest();
            check(FakeAndroid.timeline.indexOf("establish:" + replacement.id) < FakeAndroid.timeline.indexOf("close:" + old.id), "new interface established before previous closes");
            old.releaseRead.countDown(); waitForReadersToRetire(old);
            check(GuardService.snapshot().droppedPackets == 0 && GuardService.events().isEmpty(), "late old packet cannot increment or log in replacement");
            replacement.enqueue(ipv4(202, "NEW_PAYLOAD")); await(() -> GuardService.snapshot().droppedPackets == 1, "new packet read");
            check(GuardService.events().get(0).port == 202 && "journey".equals(GuardService.snapshot().mode), "new session owns counters and logs");
            check(old.closeCalls == 1, "descriptor closes only once across cancellation/finally");
        });

        run("failed or empty reconfiguration is explicit off", () -> {
            fresh(35); install(A, 12001); select("normal", A); start("normal");
            FakeAndroid.Tun old = FakeAndroid.latest(); FakeAndroid.establishOutcomes.add("null");
            action(GuardService.ACTION_APPLY, "normal");
            check("ERROR".equals(GuardService.snapshot().phase) && old.closed, "failed replacement retires old rules and reports off");
            start("normal"); old = FakeAndroid.latest(); int before = FakeAndroid.establishCalls;
            select("normal"); action(GuardService.ACTION_APPLY, "normal");
            check("ERROR".equals(GuardService.snapshot().phase) && old.closed && FakeAndroid.establishCalls == before,
                    "empty replacement cannot become all-app VPN");
        });

        run("selected package final uninstall and partial removal", () -> {
            fresh(35); install(A, 12001); install(B, 12002); select("normal", A, B); start("normal");
            FakeAndroid.packages.remove(A); FakeAndroid.broadcast(Intent.ACTION_PACKAGE_REMOVED, A, 12001, false);
            await(() -> "ACTIVE".equals(GuardService.snapshot().phase) && GuardService.snapshot().blockedCount == 1, "partial removal reconfigure");
            check(FakeAndroid.latest().allowed.equals(set(B)), "removed package is not retained in route rules");
            FakeAndroid.Tun last = FakeAndroid.latest(); FakeAndroid.packages.remove(B);
            FakeAndroid.broadcast(Intent.ACTION_PACKAGE_REMOVED, B, 12002, false);
            check("ERROR".equals(GuardService.snapshot().phase) && last.closed && GuardService.snapshot().blockedCount == 0, "last removal cannot leave stale ACTIVE count");
        });

        run("package update UID change and absent selected app reinstall", () -> {
            fresh(35); install(A, 12001); select("normal", A, B); start("normal");
            int before = FakeAndroid.establishCalls; FakeAndroid.Tun initial = FakeAndroid.latest();
            FakeAndroid.broadcast(Intent.ACTION_PACKAGE_REMOVED, A, 12001, true);
            check(FakeAndroid.establishCalls == before && !initial.closed, "update removal does not stop a working session");
            install(A, 12555); FakeAndroid.broadcast(Intent.ACTION_PACKAGE_ADDED, A, 12555, true);
            await(() -> "ACTIVE".equals(GuardService.snapshot().phase), "updated app route");
            check(FakeAndroid.latest().routedUids.contains(Integer.valueOf(12555)) && !FakeAndroid.latest().routedUids.contains(Integer.valueOf(12001)), "replacement uses current UID");
            install(B, 12666); FakeAndroid.broadcast(Intent.ACTION_PACKAGE_ADDED, B, 12666, false);
            await(() -> "ACTIVE".equals(GuardService.snapshot().phase) && GuardService.snapshot().blockedCount == 2, "reinstalled saved selection");
            check(FakeAndroid.latest().routesPackage(B), "previously missing selected app enters VPN when installed");
        });

        run("unrelated and inactive-mode package events do not restart", () -> {
            fresh(35); install(A, 12001); select("normal", A); select("journey", B); start("normal");
            int before = FakeAndroid.establishCalls;
            install(B, 12002); FakeAndroid.broadcast(Intent.ACTION_PACKAGE_ADDED, B, 12002, false);
            install(C, 12003); FakeAndroid.broadcast(Intent.ACTION_PACKAGE_ADDED, C, 12003, false);
            check(FakeAndroid.establishCalls == before, "unrelated events do not reset active counters or tunnel");
            action(GuardService.ACTION_STOP, "normal");
            FakeAndroid.broadcast(Intent.ACTION_PACKAGE_REPLACED, A, 12001, false);
            check(FakeAndroid.establishCalls == before && "OFF".equals(GuardService.snapshot().phase), "package change cannot start stopped service");
            service.onDestroy(); service = null;
            check(FakeAndroid.receivers.isEmpty(), "receiver removed during destruction");
        });

        run("private rule storage separation corruption and defensive copies", () -> {
            fresh(35); Set<String> input = set(A); RuleStore.setBlocked(service, "normal", input); input.add(B);
            RuleStore.setBlocked(service, "journey", set(C));
            check(RuleStore.getBlocked(service, "normal").equals(set(A)), "stored rules do not alias caller collection");
            check(RuleStore.getBlocked(service, "journey").equals(set(C)), "modes have separate rule sets");
            FakeAndroid.Prefs prefs = FakeAndroid.preferences("vguard_rules_v1"); prefs.data.put("blocked_normal", Integer.valueOf(5));
            check(RuleStore.getBlocked(service, "normal").isEmpty(), "wrong-type rules fail empty rather than broad");
            prefs.data.put("mode", Integer.valueOf(5));
            check("normal".equals(RuleStore.getMode(service)), "wrong-type mode falls back safely");
            for (int access : FakeAndroid.preferenceModes) check(access == Context.MODE_PRIVATE, "preferences never requested world readable");
        });

        System.out.println("RESULT: " + scenarios + " scenarios, " + assertions + " assertions, " + failures + " failures.");
        System.out.println("SCOPE: production Java engine with controlled framework stubs; not proof of Android kernel routing, radio behaviour, or OEM lifecycle.");
        if (failures != 0) System.exit(1);
    }

    private static void run(String name, Checked test) throws Exception {
        if (!name.contains(filter)) return;
        scenarios++;
        try { test.run(); System.out.println("PASS " + name); }
        catch (Throwable problem) { failures++; System.out.println("FAIL " + name + ": " + problem); }
        finally { cleanup(); }
    }

    private static void fresh(int api) {
        FakeAndroid.reset(); Build.VERSION.SDK_INT = api; service = new GuardService(); service.onCreate(); GuardService.clearEvents(service);
    }

    private static void cleanup() throws Exception {
        for (FakeAndroid.Tun tun : FakeAndroid.tuns) if (tun.releaseRead != null) tun.releaseRead.countDown();
        if (service != null) { action(GuardService.ACTION_STOP, "normal"); service.onDestroy(); service = null; }
        boolean workersRetired = true;
        for (Thread thread : Thread.getAllStackTraces().keySet()) if (thread.getName().equals("VGuard-packet-sink")) {
            thread.join(1500);
            workersRetired &= !thread.isAlive();
        }
        check(workersRetired, "cancelled VPN workers must retire within bounded poll interval");
        FakeAndroid.drainMain();
        check(FakeAndroid.emptyEstablishCalls == 0, "no scenario ever establishes an empty Android allowed list");
    }

    private static void install(String name, int uid) { FakeAndroid.packages.install(name, uid); }
    private static Set<String> set(String... names) { return new HashSet<String>(Arrays.asList(names)); }
    private static void select(String mode, String... names) { RuleStore.setBlocked(service, mode, set(names)); }
    private static void action(String action, String mode) {
        service.onStartCommand(new Intent().setAction(action).putExtra(GuardService.EXTRA_MODE, mode), 0, 1);
    }
    private static void start(String mode) throws Exception {
        action(GuardService.ACTION_START, mode);
        await(() -> "ACTIVE".equals(GuardService.snapshot().phase), "active " + mode);
        await(() -> !FakeAndroid.mainQueue.isEmpty(), "active notification callback");
        FakeAndroid.drainMain();
    }
    private static void await(BooleanSupplier condition, String label) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(1);
        check(condition.getAsBoolean(), "timed out: " + label + " (phase=" + GuardService.snapshot().phase + ")");
    }
    private static void waitForReadersToRetire(FakeAndroid.Tun tun) throws Exception {
        Thread reader = tun.readerThread;
        check(reader != null, "latched read identifies its actual worker");
        reader.join(2000);
        check(!reader.isAlive(), "retired worker completed before new-session counters are inspected");
    }
    private static byte[] ipv4(int port, String payload) throws Exception {
        byte[] body = payload.getBytes("UTF-8"), packet = new byte[28 + body.length];
        packet[0] = 0x45; word(packet, 2, packet.length); packet[9] = 17;
        packet[16] = (byte) 203; packet[18] = 113; packet[19] = 7;
        word(packet, 20, 32000); word(packet, 22, port); word(packet, 24, 8 + body.length);
        System.arraycopy(body, 0, packet, 28, body.length); return packet;
    }
    private static byte[] ipv6(int port) {
        byte[] packet = new byte[48]; packet[0] = 0x60; word(packet, 4, 8); packet[6] = 17;
        packet[24] = 0x20; packet[25] = 1; packet[26] = 0x0d; packet[27] = (byte) 0xb8; packet[39] = 1;
        word(packet, 42, port); word(packet, 44, 8); return packet;
    }
    private static void word(byte[] data, int offset, int value) { data[offset] = (byte) (value >>> 8); data[offset + 1] = (byte) value; }
    private static void check(boolean condition, String message) { assertions++; if (!condition) throw new AssertionError(message); }
    private interface Checked { void run() throws Exception; }
}
