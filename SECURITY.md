# Security and responsible reporting

This is experimental evaluation software with no independent security audit.

Do not post exploitable vulnerabilities or real secrets in public GitHub Issues. Use the beta website's `/security` private form. The form accepts non-sensitive reproduction text and does not collect contact details; no guaranteed response time or emergency monitoring is offered.

## Threat and capability boundaries

- VGuard filters selected Android app network traffic through a local VPN interface. It is not a microphone/camera controller, spyware scanner or external-tracker jammer. Blocking can stop with the VPN/process. Live Android routing, lifecycle and battery behaviour remain unverified.
- VVault encrypts text with a shared passphrase. It uses Web Crypto AES-256-GCM with a 128-bit tag, random 96-bit IV, random 128-bit salt and PBKDF2-HMAC-SHA256 with 600,000 iterations. Version and algorithm metadata are fixed and checked. A lost passphrase cannot be recovered. There is no sender authentication or forward secrecy.
- A compromised device, browser extension, malicious online code update, weak passphrase, screen capture or clipboard exposure can defeat the intended protections. JavaScript cannot guarantee secure memory erasure.
- VRelay checks structure only. It does not establish authenticity, deliver a message, hide metadata or decrypt content. Use a separate channel for the passphrase.
- The optional website feedback endpoint stores product, category, OS, text, timestamp and a hashed network abuse-control key. It exposes no public read API. Infrastructure access and logs remain within hosting's responsibility.

Only test systems and devices you control or have explicit permission to assess. Keep tests bounded and use synthetic data. Do not access other people's records or disrupt services.
