package app.vguard.firewall;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Arrays;

/** Metadata from one IP packet actually read and discarded by the local VPN. */
public final class PacketInfo {
    public final long timestamp;
    public final String destination;
    public final int port;
    public final String protocol;
    public final String appName;

    private PacketInfo(String destination, int port, String protocol) {
        this.timestamp = System.currentTimeMillis();
        this.destination = destination;
        this.port = port;
        this.protocol = protocol;
        // A VPN packet does not reliably identify its originating package. Never guess.
        this.appName = "Selected app";
    }

    /**
     * Parses only IP and transport header metadata. Returns null for an invalid or
     * truncated IP header. Never looks up hostnames or copies a packet payload.
     * A port of -1 means the transport port cannot be read reliably.
     */
    public static PacketInfo parse(byte[] packet, int length) {
        if (packet == null || length <= 0 || length > packet.length) return null;
        int version = unsigned(packet[0]) >>> 4;
        if (version == 4) return parseIpv4(packet, length);
        if (version == 6) return parseIpv6(packet, length);
        return null;
    }

    private static PacketInfo parseIpv4(byte[] packet, int length) {
        if (length < 20) return null;
        int headerLength = (unsigned(packet[0]) & 15) * 4;
        int end = word(packet, 2);
        if (headerLength < 20 || headerLength > length || end < headerLength || end > length) {
            return null;
        }
        int protocolNumber = unsigned(packet[9]);
        int fragment = word(packet, 6);
        boolean initialFragment = (fragment & 0x1fff) == 0;
        boolean moreFragments = (fragment & 0x2000) != 0;
        String destination = unsigned(packet[16]) + "." + unsigned(packet[17]) + "."
                + unsigned(packet[18]) + "." + unsigned(packet[19]);
        int port = initialFragment
                ? destinationPort(packet, headerLength, end, protocolNumber, moreFragments) : -1;
        return new PacketInfo(destination, port, protocolName(protocolNumber));
    }

    private static PacketInfo parseIpv6(byte[] packet, int length) {
        if (length < 40) return null;
        int payloadLength = word(packet, 4);
        int end = 40 + payloadLength;
        if (end > length) return null;
        // Jumbo payload options are deliberately unsupported; the VPN MTU is 1500.
        if (payloadLength == 0 && length > 40) return null;

        String destination;
        try {
            destination = InetAddress.getByAddress(Arrays.copyOfRange(packet, 24, 40))
                    .getHostAddress();
        } catch (UnknownHostException impossible) {
            return null;
        }
        int next = unsigned(packet[6]);
        int offset = 40;
        boolean initialFragment = true;
        boolean moreFragments = false;
        int extensions = 0;

        while (next == 0 || next == 43 || next == 60 || next == 44 || next == 51) {
            // Bound both processing time and offset arithmetic for malformed input.
            if (++extensions > 16 || offset + 2 > end) return null;
            int following = unsigned(packet[offset]);
            int extensionLength;
            if (next == 44) {
                extensionLength = 8;
                if (offset + extensionLength > end) return null;
                int fragment = word(packet, offset + 2);
                initialFragment = (fragment & 0xfff8) == 0;
                moreFragments = (fragment & 1) != 0;
            } else if (next == 51) {
                extensionLength = (unsigned(packet[offset + 1]) + 2) * 4;
            } else {
                extensionLength = (unsigned(packet[offset + 1]) + 1) * 8;
            }
            if (extensionLength < 8 || offset + extensionLength > end) return null;
            next = following;
            offset += extensionLength;
            // Later fragments may start in the middle of any remaining header.
            if (!initialFragment) break;
        }
        int port = initialFragment
                ? destinationPort(packet, offset, end, next, moreFragments) : -1;
        return new PacketInfo(destination, port, protocolName(next));
    }

    private static int destinationPort(byte[] packet, int offset, int end,
                                       int protocol, boolean moreFragments) {
        if (protocol == 6) {
            if (offset + 20 > end) return -1;
            int tcpHeaderLength = (unsigned(packet[offset + 12]) >>> 4) * 4;
            if (tcpHeaderLength < 20 || offset + tcpHeaderLength > end) return -1;
            return word(packet, offset + 2);
        }
        if (protocol == 17) {
            if (offset + 8 > end) return -1;
            int udpLength = word(packet, offset + 4);
            if (udpLength < 8 || (!moreFragments && udpLength > end - offset)) return -1;
            return word(packet, offset + 2);
        }
        return -1;
    }

    private static String protocolName(int protocol) {
        switch (protocol) {
            case 1: return "ICMP";
            case 6: return "TCP";
            case 17: return "UDP";
            case 50: return "ESP";
            case 58: return "ICMPv6";
            case 59: return "No next header";
            default: return "IP " + protocol;
        }
    }

    private static int unsigned(byte value) { return value & 0xff; }
    private static int word(byte[] data, int offset) {
        return (unsigned(data[offset]) << 8) | unsigned(data[offset + 1]);
    }
}
