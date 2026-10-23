# Vellivex identity and domain — 23 October 2026

The owner selected Vellivex and purchased vellivex.com at IONOS. This replaces the provisional V Security umbrella brand. Product names remain VGuard, VVault and VRelay; their native package and update-signing identities are unchanged.

## Delivered

- Original geometric V mark with two outer wings and a separate inner facet; scalable transparent SVG wordmarks for light and dark backgrounds.
- Ink, ice and paper palette; redesigned header, hero, product presentation, favicon, browser-app identity and public brand-download page.
- Public source, notices, manifest and downloadable source archives updated. The repository URL remains stable.
- Both apex and www attached to the existing public Site. Required IONOS A, CNAME and verification TXT records saved; default parking removed and mail settings preserved.

## Observed evidence

The www hostname is active with active HTTPS and serves the Vellivex website. Chrome encrypted and decrypted a synthetic VVault message on that origin; the original plaintext and passphrase cleared after encryption. Offline installation completed with integrity checks. No network-disconnected phone test is claimed. The narrow layout and mobile menu were inspected in Chrome. The GitHub regression workflow passed for the rebrand.

At 16:39 UTC the root hostname vellivex.com still reports SSL pending_validation, without a returned error. The configured DNS values match those supplied by Sites. Use https://www.vellivex.com while root-certificate issuance finishes. IONOS also still requests contact-email confirmation from the owner. These states can change after this timestamp.

## Security status

This identity does not assert independent certification or a world's-most-secure ranking. The 0.1.2 Android candidate and 0.2.0 browser tools retain their experimental status and published device-testing and audit gates. See SECURITY-HARDENING-2026-10-23.md.
