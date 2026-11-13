# Ordinary app entry after email sign-in

The email access gate restores a saved invitation fragment, or `#_` when no
invitation was supplied. The explicit empty marker prevents a previous URL
fragment from being inherited across redirects. Keep that gate behavior.

VKey, Private and Call previously treated the marker as an invitation. VKey
and Call displayed an invalid-link error on an ordinary sign-in; Private
preloaded an unusable invitation. Their client initializers now consume exactly
`#_` with `history.replaceState` and leave the normal welcome state. All other
fragments follow the existing validation path. No connection, microphone or
sound starts merely because a link is loaded.

`server/app-access/patch-chat-invitations.mjs` pins the exact live source hashes
reviewed on 13 November 2026 and rejects any unexpected baseline. The retained
client fixtures are verbatim portions/assets of those deployed Vellivex
Workers. The two Call fixtures are portions of the generated template literal;
the tests decode its escaped backslashes before running the client code.

Deployment scope is limited to:

- VKey: replace `app-access/chat-overrides.mjs`, retaining its existing
  `/public-session.mjs` response byte-for-byte and adding the `/app.js` response.
- Private: replace `app-access/chat-overrides.mjs`, retaining the same session
  response and adding `/live/ui/live-ui.mjs`.
- Call accounts Worker: replace the one reviewed initializer anchor in
  `accounts-core.mjs`; keep all other module bytes unchanged.

Keep the current main module, every other module, binding, flag, runtime option,
Durable Object export and domain mapping. Recheck active version and source
hashes immediately before upload; stop on drift. Use the existing version as the
rollback target. This is an overlay update, not a generic site rebuild or APK
release. In particular, the retained production VGuard 0.1.4 download must not be
replaced by the repository's 0.1.3 source-build artifact.

The regressions execute the reviewed UI and invitation parsers with controlled
DOM/transport fixtures: empty entry, exact marker, malformed non-marker links,
valid text/audio invitations, explicit Join behavior, and unchanged microphone
and sound defaults. They do not establish real-device or cross-network delivery.
The separate direct chat transport still has no configured relay fallback.
