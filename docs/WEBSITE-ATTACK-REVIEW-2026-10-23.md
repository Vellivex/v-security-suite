# Vellivex website attack review — 23 October 2026

Scope: the Vellivex website Worker, public routes, asset isolation and private feedback endpoint. Source release 0.3.6; phone application versions unchanged. Internal synthetic source/local tests, not an independent penetration test or hosting-account audit.

## Reproduced defects and fixes

- Duplicate top-level JSON report members, including escaped spellings of a member, were accepted because JSON.parse selected the final value. The endpoint now rejects duplicates before persistence. This was an input-ambiguity defect; no SQL execution, private-report disclosure or authentication bypass was demonstrated.
- A report containing an unpaired Unicode surrogate was accepted for storage, where encoding can replace it instead of preserving the submitted text. The endpoint now rejects ill-formed message strings before storage. Both regressions failed with HTTP 201 before the fixes and now return HTTP 400 without a stored row.
- Additional hardening: unexpected report fields, including attempted administrative, timestamp, rate-key and prototype-shaped fields, are rejected rather than silently ignored. Existing clients submit only the documented fields.

## Website verification

The full suite has 117 passing Node tests. Website-specific checks use the actual SQLite schema and bound statements, with a local in-memory database:

- 500 concurrent synthetic submissions yield exactly 10 accepted and 490 rate-limited responses for one network; no production traffic burst was sent.
- SQL/script-shaped report text is stored literally, cannot execute SQL and is not returned by public API reads. GET, HEAD, OPTIONS and DELETE cannot list/read feedback.
- Foreign, opaque, absent and suffix-confusion origins fail before database access; no permissive CORS header is emitted.
- Duplicate identifiers cannot overwrite reports or falsely confirm a changed report; concurrent identical retries create exactly one row. Hourly quota remains effective across midnight.
- Chunked oversized bodies, invalid UTF-8, unsupported MIME, malformed UUIDs and malformed report fields are refused.
- Private-file and report-read probes, encoded traversal paths and script-shaped query strings return fixed pages without reflecting the submitted marker. The Worker has no filesystem path resolver or public report listing.
- Error/API responses retain CSP frame protection, DENY framing, nosniff and no-store. Tool networking/camera restrictions and offline cache integrity remain covered by the existing suite.
- Legitimate escaped JSON-like text, four-byte Unicode, accents and multiline reports persist unchanged; identical retries remain idempotent.

`npm run build`, `npm run validate` and `git diff --check` verify the assembled module, actual routes, isolation headers, offline manifest digests and embedded download checksums.

## Live checks and limits

Six low-volume direct HTTP probes to the custom domain (home, security page, feedback read, .env, .git/config and a report-list path) received HTTP 403, error code 1010, from this environment. These responses do not prove that the origin itself returned its intended responses/headers; no successful live API write or production load test was performed. A separate normal-browser check on the custom domain displayed the expected method-denied JSON for GET /api/feedback and the fixed 404 page for /.env and /.git/config. This verifies visible responses only, not raw status codes or headers. Native deployment success is separate evidence from the blocked direct HTTP probes.

No production feedback records were read, altered or deleted. This pass does not audit registrar/hosting account credentials, MFA, provider infrastructure, TLS configuration outside the Worker, or resistance to distributed denial of service. Application-level per-network limits do not guarantee a global spam or cost limit against many separate networks. There is no claim of an impregnable website.


## Follow-up: stalled upload handling (source 0.3.7)

Reproduced before fix: a feedback body that never finishes leaves the handler pending, with no application-level read deadline. Periodic chunks also keep it pending indefinitely at this layer. Two synthetic regressions verified that no response had been produced after advancing a controlled clock beyond ten seconds.

The bounded reader now has one ten-second deadline for the entire body, shared across all reads rather than renewed for each chunk. It cancels incomplete reads without awaiting a possibly stuck cancellation and releases the reader lock. An expired upload returns HTTP 408 with the existing isolation/no-store headers and a message instructing the visitor to retain and retry their report. The timer is cleared when the body finishes or fails. The 12,000-byte limit remains in force. Both formerly failing tests pass, including a stalled cancellation promise and trickled chunks.

Complete suite: 119 passing Node tests; build and assembled artifact validation run separately. Timing regressions use a controlled local clock and synthetic streams, not a production slow-request attack. Hosting-level timeouts and distributed denial-of-service protection are separate and are not established by this change. App versions are unchanged.
