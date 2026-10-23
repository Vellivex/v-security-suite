package app.vguard.qa;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.IBinder;
import android.os.SystemClock;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Independent test app/UID. Never included in the VGuard APK. */
public final class Probe extends Instrumentation {
    private Bundle arguments;
    @Override public void onCreate(Bundle args) { arguments = args == null ? new Bundle() : args; start(); }

    @Override public void onStart() {
        Bundle summary = new Bundle();
        String mode = arguments.getString("mode", "http");
        String host = arguments.getString("host", "10.0.2.2");
        String url = arguments.getString("url", "http://10.0.2.2:18789/check");
        long started = SystemClock.elapsedRealtime();
        if ("service_access".equals(mode)) {
            serviceAccess(summary);
            summary.putString("test_package", getTargetContext().getPackageName());
            summary.putString("mode", mode);
            finish(0, summary);
            return;
        }
        Socket persistent = null;
        try {
            int attempts = integer("attempts", 1, 1, 120);
            int timeout = integer("timeout_ms", 3500, 250, 30000);
            int interval = integer("interval_ms", 1000, 0, 10000);
            int port = integer("port", "udp".equals(mode) ? 18791 : 18790, 1, 65535);
            if (!"http".equals(mode) && !"tcp".equals(mode) && !"tcp_persist".equals(mode)
                    && !"udp".equals(mode) && !"resolve".equals(mode)
                    && !"underlying_http".equals(mode)) throw new IllegalArgumentException("mode");
            int connected = 0, failed = 0, unexpected = 0;
            BufferedReader persistentReader = null;
            for (int attempt = 1; attempt <= attempts; attempt++) {
                Bundle result = new Bundle();
                long at = SystemClock.elapsedRealtime();
                try {
                    if ("http".equals(mode)) http(url, timeout, result);
                    else if ("underlying_http".equals(mode)) underlyingHttp(url, timeout, result);
                    else if ("udp".equals(mode)) udp(host, port, timeout, result);
                    else if ("resolve".equals(mode)) {
                        InetAddress[] addresses = InetAddress.getAllByName(host);
                        StringBuilder text = new StringBuilder();
                        for (InetAddress address : addresses) {
                            if (text.length() > 0) text.append(',');
                            text.append(address.getHostAddress());
                        }
                        result.putString("addresses", text.toString());
                        result.putString("outcome", addresses.length > 0 ? "CONNECTED" : "UNEXPECTED_RESPONSE");
                    } else if ("tcp_persist".equals(mode)) {
                        // Establish once. Never reconnect after loss: tests a pre-existing socket.
                        if (attempt == 1) { persistent = connect(host, port, timeout); persistentReader = reader(persistent); }
                        if (persistent == null) throw new IllegalStateException("Initial connection failed");
                        exchange(persistent, persistentReader, result);
                    } else {
                        try (Socket socket = connect(host, port, timeout)) { exchange(socket, reader(socket), result); }
                    }
                } catch (Exception failure) {
                    result.putString("outcome", "NO_CONNECTION");
                    result.putString("failure", failure.getClass().getSimpleName());
                }
                String outcome = result.getString("outcome", "PROBE_ERROR");
                if ("CONNECTED".equals(outcome)) connected++;
                else if ("NO_CONNECTION".equals(outcome)) failed++;
                else unexpected++;
                result.putInt("attempt", attempt);
                result.putString("mode", mode);
                result.putString("test_package", getTargetContext().getPackageName());
                result.putLong("elapsed_ms", SystemClock.elapsedRealtime() - at);
                result.putLong("since_start_ms", SystemClock.elapsedRealtime() - started);
                if (attempts > 1) sendStatus(0, result); else summary.putAll(result);
                if (attempt < attempts) SystemClock.sleep(interval);
            }
            if (attempts > 1) summary.putString("outcome", "SERIES_COMPLETE");
            summary.putInt("attempts", attempts);
            summary.putInt("connected", connected);
            summary.putInt("no_connection", failed);
            summary.putInt("unexpected", unexpected);
        } catch (Exception failure) {
            summary.putString("outcome", "PROBE_ERROR");
            summary.putString("failure", failure.getClass().getSimpleName());
        } finally {
            if (persistent != null) try { persistent.close(); } catch (Exception ignored) { }
        }
        summary.putLong("elapsed_ms", SystemClock.elapsedRealtime() - started);
        summary.putString("test_package", getTargetContext().getPackageName());
        summary.putString("mode", mode);
        summary.putString("destination", "http".equals(mode) || "underlying_http".equals(mode) ? url : host);
        finish(0, summary);
    }

    private int integer(String key, int fallback, int min, int max) {
        int value = Integer.parseInt(arguments.getString(key, Integer.toString(fallback)));
        if (value < min || value > max) throw new IllegalArgumentException(key);
        return value;
    }

    private void serviceAccess(Bundle result) {
        ServiceConnection callback = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder binder) { }
            @Override public void onServiceDisconnected(ComponentName name) { }
        };
        try {
            Intent intent = new Intent("android.net.VpnService");
            intent.setComponent(new ComponentName("app.vguard.firewall", "app.vguard.firewall.GuardService"));
            boolean bound = getTargetContext().bindService(intent, callback, Context.BIND_AUTO_CREATE);
            result.putString("outcome", bound ? "UNEXPECTED_SERVICE_ACCESS" : "BIND_REFUSED");
            if (bound) getTargetContext().unbindService(callback);
        } catch (SecurityException expected) {
            result.putString("outcome", "PERMISSION_DENIED");
        } catch (Exception failure) {
            result.putString("outcome", "PROBE_ERROR");
            result.putString("failure", failure.getClass().getSimpleName());
        }
    }

    private void http(String url, int timeout, Bundle result) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        httpConnection(connection, timeout, result);
    }

    private void underlyingHttp(String url, int timeout, Bundle result) throws Exception {
        ConnectivityManager manager = (ConnectivityManager) getTargetContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        int tried = 0;
        boolean success = false;
        boolean unexpected = false;
        StringBuilder details = new StringBuilder();
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities == null || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            if (tried >= 8) break;
            tried++;
            Bundle attempt = new Bundle();
            try {
                httpConnection((HttpURLConnection) network.openConnection(new URL(url)), timeout, attempt);
            } catch (Exception failure) {
                attempt.putString("outcome", "NO_CONNECTION");
                attempt.putString("failure", failure.getClass().getSimpleName());
            }
            String outcome = attempt.getString("outcome", "PROBE_ERROR");
            if ("CONNECTED".equals(outcome)) success = true;
            else if (!"NO_CONNECTION".equals(outcome)) unexpected = true;
            if (details.length() > 0) details.append(';');
            details.append(network.toString()).append(':').append(outcome).append(':')
                    .append(attempt.getString("failure", ""));
        }
        result.putInt("networks_tried", tried);
        result.putString("network_results", details.toString());
        result.putString("outcome", success ? "CONNECTED" : tried == 0 ? "NO_UNDERLYING_NETWORK"
                : unexpected ? "UNEXPECTED_RESPONSE" : "NO_CONNECTION");
    }

    private void httpConnection(HttpURLConnection connection, int timeout, Bundle result) throws Exception {
        try {
            connection.setConnectTimeout(timeout); connection.setReadTimeout(timeout);
            connection.setUseCaches(false); connection.setRequestProperty("Connection", "close");
            connection.setRequestProperty("X-VGuard-Probe", getTargetContext().getPackageName());
            int status = connection.getResponseCode();
            byte[] body = new byte[64]; int total = 0;
            try (InputStream stream = connection.getInputStream()) {
                int n;
                while (total < body.length && (n = stream.read(body, total, body.length - total)) != -1) total += n;
            }
            String text = new String(body, 0, total, StandardCharsets.UTF_8);
            result.putString("outcome", status == 200 && "VGUARD_QA_OK\n".equals(text) ? "CONNECTED" : "UNEXPECTED_RESPONSE");
            result.putInt("http_status", status);
        } finally { connection.disconnect(); }
    }

    private static Socket connect(String host, int port, int timeout) throws Exception {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(host, port), timeout); socket.setSoTimeout(timeout); return socket;
        } catch (Exception failure) { socket.close(); throw failure; }
    }

    private static BufferedReader reader(Socket socket) throws Exception {
        return new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
    }

    private void exchange(Socket socket, BufferedReader input, Bundle result) throws Exception {
        String token = getTargetContext().getPackageName() + ":" + UUID.randomUUID().toString();
        socket.getOutputStream().write((token + "\n").getBytes(StandardCharsets.US_ASCII));
        socket.getOutputStream().flush();
        String response = input.readLine();
        result.putString("outcome", ("VGUARD_QA_OK " + token).equals(response) ? "CONNECTED"
                : response == null ? "NO_CONNECTION" : "UNEXPECTED_RESPONSE");
    }

    private void udp(String host, int port, int timeout, Bundle result) throws Exception {
        String token = getTargetContext().getPackageName() + ":" + UUID.randomUUID().toString();
        byte[] request = token.getBytes(StandardCharsets.US_ASCII);
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.connect(InetAddress.getByName(host), port); socket.setSoTimeout(timeout);
            socket.send(new DatagramPacket(request, request.length));
            byte[] bytes = new byte[256]; DatagramPacket packet = new DatagramPacket(bytes, bytes.length);
            socket.receive(packet);
            String response = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.US_ASCII);
            result.putString("outcome", ("VGUARD_QA_OK " + token).equals(response) ? "CONNECTED" : "UNEXPECTED_RESPONSE");
        }
    }
}
