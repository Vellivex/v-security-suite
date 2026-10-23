package app.vguard.firewall;

import java.net.InetAddress;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Random;
import java.util.Set;

/** Dependency-free JVM checks for untrusted packet boundaries and rule safety. */
public final class CoreTests {
    private static int checks;

    public static void main(String[] args) throws Exception {
        ipv4HeadersAndFragments();
        ipv6HeadersAndFragments();
        truncationAndHostileInputs();
        ruleSafety();
        System.out.println("PASS: " + checks + " packet-parser and rule-safety assertions.");
        System.out.println("These JVM checks do not prove Android VPN routing; device tests are separate.");
    }

    private static void ipv4HeadersAndFragments() {
        byte[] udp = ipv4(28, 20, 17);
        putWord(udp, 22, 53);
        putWord(udp, 24, 8);
        PacketInfo info = PacketInfo.parse(udp, udp.length);
        check(info != null, "IPv4 UDP parsed");
        check("203.0.113.9".equals(info.destination), "IPv4 destination is numeric and exact");
        check(info.port == 53 && "UDP".equals(info.protocol), "UDP destination port, not source port");
        check("Selected app".equals(info.appName), "No invented package attribution");
        check(info.timestamp > 0, "Real event timestamp");

        byte[] tcpOptions = ipv4(44, 24, 6);
        putWord(tcpOptions, 24, 32000);
        putWord(tcpOptions, 26, 443);
        tcpOptions[36] = 0x50;
        info = PacketInfo.parse(tcpOptions, tcpOptions.length);
        check(info != null && info.port == 443, "IPv4 options shift TCP header correctly");
        check("TCP".equals(info.protocol), "TCP protocol");

        putWord(tcpOptions, 6, 1);
        info = PacketInfo.parse(tcpOptions, tcpOptions.length);
        check(info != null && info.port == -1, "Later IPv4 fragments never invent a port");

        putWord(udp, 6, 0x2000);
        putWord(udp, 24, 64);
        info = PacketInfo.parse(udp, udp.length);
        check(info != null && info.port == 53, "Initial fragmented UDP retains valid header metadata");
        putWord(udp, 6, 0);
        info = PacketInfo.parse(udp, udp.length);
        check(info != null && info.port == -1, "Malformed unfragmented UDP length yields unknown port");

        byte[] badTcp = ipv4(40, 20, 6);
        putWord(badTcp, 22, 443);
        badTcp[32] = 0;
        info = PacketInfo.parse(badTcp, badTcp.length);
        check(info != null && info.port == -1, "Invalid TCP data offset does not produce a port");
        byte[] shortTcp = ipv4(24, 20, 6);
        putWord(shortTcp, 22, 443);
        info = PacketInfo.parse(shortTcp, shortTcp.length);
        check(info != null && info.port == -1, "Incomplete TCP header has no claimed port");

        byte[] icmp = ipv4(28, 20, 1);
        info = PacketInfo.parse(icmp, icmp.length);
        check(info != null && "ICMP".equals(info.protocol) && info.port == -1, "ICMP has no transport port");
    }

    private static void ipv6HeadersAndFragments() throws Exception {
        byte[] udp = ipv6(8, 17);
        putWord(udp, 40, 12345);
        putWord(udp, 42, 65535);
        putWord(udp, 44, 8);
        PacketInfo info = PacketInfo.parse(udp, udp.length);
        String expected = InetAddress.getByName("2001:db8::1234").getHostAddress();
        check(info != null && expected.equals(info.destination), "IPv6 destination is exact");
        check(info.port == 65535 && "UDP".equals(info.protocol), "Unsigned 16-bit destination port");

        byte[] hop = ipv6(16, 0);
        hop[40] = 17;
        hop[41] = 0;
        putWord(hop, 50, 5353);
        putWord(hop, 52, 8);
        info = PacketInfo.parse(hop, hop.length);
        check(info != null && info.port == 5353, "IPv6 hop-by-hop extension skips safely");
        hop[41] = (byte) 255;
        check(PacketInfo.parse(hop, hop.length) == null, "Oversized IPv6 extension is rejected");

        byte[] fragment = ipv6(28, 44);
        fragment[40] = 6;
        putWord(fragment, 42, 8);
        putWord(fragment, 50, 443);
        fragment[60] = 0x50;
        info = PacketInfo.parse(fragment, fragment.length);
        check(info != null && info.port == -1, "Later IPv6 fragments never invent a port");
        putWord(fragment, 42, 1);
        info = PacketInfo.parse(fragment, fragment.length);
        check(info != null && info.port == 443, "First IPv6 fragment can expose a complete TCP header");

        byte[] authentication = ipv6(20, 51);
        authentication[40] = 17;
        authentication[41] = 1; // (1 + 2) * 4 = 12-byte AH.
        putWord(authentication, 54, 53);
        putWord(authentication, 56, 8);
        info = PacketInfo.parse(authentication, authentication.length);
        check(info != null && info.port == 53, "IPv6 AH length uses 32-bit words");

        byte[] encrypted = ipv6(8, 50);
        putWord(encrypted, 42, 443);
        info = PacketInfo.parse(encrypted, encrypted.length);
        check(info != null && "ESP".equals(info.protocol) && info.port == -1,
                "Encrypted transport bytes are not mistaken for ports");
        byte[] noNext = ipv6(0, 59);
        info = PacketInfo.parse(noNext, noNext.length);
        check(info != null && info.port == -1, "Empty IPv6 with no next header is supported");

        byte[] excessiveExtensions = ipv6(17 * 8, 0);
        for (int i = 0; i < 17; i++) {
            excessiveExtensions[40 + i * 8] = 0;
            excessiveExtensions[41 + i * 8] = 0;
        }
        check(PacketInfo.parse(excessiveExtensions, excessiveExtensions.length) == null,
                "Extension-chain work is bounded");
    }

    private static void truncationAndHostileInputs() {
        check(PacketInfo.parse(null, 1) == null, "Null input rejected");
        check(PacketInfo.parse(new byte[0], 0) == null, "Empty input rejected");
        check(PacketInfo.parse(new byte[20], -1) == null, "Negative length rejected");
        check(PacketInfo.parse(new byte[20], 21) == null, "Oversized read length rejected");
        byte[] valid = ipv4(40, 20, 6);
        valid[32] = 0x50;
        putWord(valid, 22, 443);
        for (int length = 0; length < valid.length; length++) {
            check(PacketInfo.parse(valid, length) == null, "Truncated IPv4 packet rejected at " + length);
        }
        valid[0] = 0x44;
        check(PacketInfo.parse(valid, valid.length) == null, "Undersized IPv4 header rejected");
        valid[0] = 0x4f;
        check(PacketInfo.parse(valid, valid.length) == null, "IPv4 options beyond buffer rejected");
        valid[0] = 0x45;
        putWord(valid, 2, 10);
        check(PacketInfo.parse(valid, valid.length) == null, "IP length shorter than header rejected");

        byte[] six = ipv6(8, 17);
        putWord(six, 42, 53);
        putWord(six, 44, 8);
        for (int length = 0; length < six.length; length++) {
            check(PacketInfo.parse(six, length) == null, "Truncated IPv6 packet rejected at " + length);
        }
        putWord(six, 4, 0);
        check(PacketInfo.parse(six, six.length) == null, "Unsupported jumbo IPv6 packet rejected");

        Random random = new Random(0x564755415244L);
        for (int i = 0; i < 20000; i++) {
            byte[] arbitrary = new byte[random.nextInt(1600)];
            random.nextBytes(arbitrary);
            int length = random.nextInt(arbitrary.length + 3) - 1;
            PacketInfo parsed = PacketInfo.parse(arbitrary, length);
            check(parsed == null || (parsed.destination != null && parsed.protocol != null
                    && parsed.port >= -1 && parsed.port <= 65535),
                    "Arbitrary input has safe metadata or is rejected");
        }
    }

    private static void ruleSafety() {
        String self = "app.vguard.firewall";
        check(RuleStore.canonicalPackages(null, self).isEmpty(), "Missing rules block nothing");
        check(RuleStore.canonicalPackages(Collections.<String>emptySet(), self).isEmpty(),
                "Empty rules stay empty");
        check(RuleStore.canonicalPackages(Collections.singleton(self), self).isEmpty(),
                "Self-only selection cannot become a VPN allow list");
        Set<String> clean = RuleStore.canonicalPackages(Arrays.asList(self, "  com.example.one  ",
                "com.example.one", null, "", "..", "bad/name", "com.bad-name", "android",
                "com.example.two"), self);
        check(clean.size() == 3 && clean.contains("com.example.one") && clean.contains("android"),
                "Invalid names and duplicates removed, real names retained");
        check(!clean.contains(self), "Self excluded from mixed rules");
        boolean immutable = false;
        try { clean.add("com.unexpected.app"); }
        catch (UnsupportedOperationException expected) { immutable = true; }
        check(immutable, "Returned rule collection is immutable");
        HashSet<String> source = new HashSet<String>();
        source.add("com.example.original");
        clean = RuleStore.canonicalPackages(source, self);
        source.clear();
        check(clean.contains("com.example.original"), "Rules are a defensive snapshot");
        check(!RuleStore.isPackageName("com.example."), "Trailing package separator rejected");
        check(!RuleStore.isPackageName("com..example"), "Empty package component rejected");
        check(!RuleStore.isPackageName("com.1example"), "Digit-start package component rejected");
        check("normal".equals(RuleStore.normalizeMode(null)), "Missing mode defaults to normal");
        check("normal".equals(RuleStore.normalizeMode("unknown")), "Unknown mode cannot create another rules namespace");
        check("journey".equals(RuleStore.normalizeMode("journey")), "Journey mode retained");
    }

    private static byte[] ipv4(int total, int header, int protocol) {
        byte[] packet = new byte[total];
        packet[0] = (byte) (0x40 | (header / 4));
        putWord(packet, 2, total);
        packet[9] = (byte) protocol;
        packet[16] = (byte) 203;
        packet[17] = 0;
        packet[18] = 113;
        packet[19] = 9;
        return packet;
    }

    private static byte[] ipv6(int payloadLength, int protocol) {
        byte[] packet = new byte[40 + payloadLength];
        packet[0] = 0x60;
        putWord(packet, 4, payloadLength);
        packet[6] = (byte) protocol;
        packet[24] = 0x20;
        packet[25] = 0x01;
        packet[26] = 0x0d;
        packet[27] = (byte) 0xb8;
        packet[38] = 0x12;
        packet[39] = 0x34;
        return packet;
    }

    private static void putWord(byte[] data, int offset, int value) {
        data[offset] = (byte) (value >>> 8);
        data[offset + 1] = (byte) value;
    }

    private static void check(boolean condition, String message) {
        checks++;
        if (!condition) throw new AssertionError(message);
    }
}
