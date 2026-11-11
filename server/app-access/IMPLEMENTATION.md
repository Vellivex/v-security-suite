# Vellivex shared app access

Owner request: email-only signup/sign-in with a verification code before entering all eleven public apps. One verified identity across origins. No paid activation. Existing strong account/payment authentication remains separate.

## Working contract

- Central origin: `https://call.vellivex.com`; public UI `/access`; public JSON `/api/app-access/*`.
- Additive `va_*` D1 tables in existing ACCOUNTS_DB. Use VELLIVEX_ACCOUNT_KEY with purpose-separated encryption/HMAC. Never insert email-only sessions into vx_users/vx_sessions.
- Central cookie: `__Host-vellivex_apps_sso`; per-origin app cookie: `__Host-vellivex_app_access`. Secure, HttpOnly, SameSite=Lax, Path=/; no Domain. Opaque tokens hashed at rest, 30-day maximum, revocation checked server-side.
- App Workers call central through service binding `APP_ACCESS` using internal hostname `app-access.internal`. Root will wire this binding to vellivex-accounts. On the accounts Worker use a local broker adapter, avoiding a self binding.
- Internal broker POST routes: `/__app_access/prepare`, `/__app_access/redeem`, `/__app_access/validate`. No public-origin routing for these endpoints. Strict bounded JSON; no CORS.
- prepare body: `{audience, returnPath, state, verifierHash}`. `audience` is an exact allowed https origin; returnPath is registry-allowlisted; state is random43char base64url; verifierHash is SHA256 base64url. Return `{flowId, authorizeUrl}` where authorizeUrl is central `/access?flow=<opaque>#_`.
- Edge `/__access/start?state=...&next=...` generates random verifier and sets `__Host-vellivex_flow_<first12state>` HttpOnly cookie for10min, then sends prepare. State and verifier are independently random. Callback `/__access/finish?code=...&state=...` reads verifier cookie and posts redeem body `{code,state,audience,verifier}`. Return `{sessionToken,expiresIn,returnPath,state}`; set app cookie and clear verifier cookie. One-use handoff60sec, audience/state/verifier bound; all redirect Locations end with explicit `#_` to prevent private fragment inheritance.
- validate body: `{audience,sessionToken}`. Return `{valid:true,scope:{id,epoch,session,appAccess:true},expiresAt}` or401; never return email. Scope is only for free app/Internet Call admission, never account/payment controls.
- Gate bootstrap is same-origin HTML. It stores the original invitation fragment only in sessionStorage under its random state, then navigates to start without the fragment. `/__access/return?state=...&next=...` restores fragment from that origin-local entry and removes it. Strict return-path allowlist; no invitation/key fragments in any server request, central URL or logs.
- Public auth endpoints: bootstrap, request-code, verify-code, continue, logout. Exact central Origin and browser-bound CSRF required on mutations. Eight-digit code,10min expiry,5 atomic attempts,60sec resend,3/email/hour,6/IP/hour, persisted sender budget. Replaced/failed/used challenges cannot verify. Account is created only after successful code verification. Optional unticked updates consent is distinct from access.
- Endpoint request/response UI contract is owned by core agent; communicate exact schema promptly to UI agent.
- Gate documents/direct entrypoints/downloads and new resource-creation API admission. Preserve capability-authorized cleanup and existing inbox/room operations when app login expires. Identity must not be forwarded into anonymous public chat actors.
- Existing local encrypted data remains on its origin. No clearing, upload, sync or per-email partitioning. Already downloaded open-source APKs and older installed offline releases cannot be retroactively gated; future online entry and verified offline installation are in scope.
- Public homepage, privacy, source/licence/help remain accessible. DocPhone excluded/private.

## Ownership

- Core agent: core.mjs, schema.sql, mail.mjs, core tests; API schemas and persistence.
- Edge agent: registry.mjs, gate.mjs, gate tests; protocol above.
- UI agent: ui.mjs and UI tests, coordinating public API schema with core.
- Call agent: call-scope adapter and exact current account/actor integration patches, with regression tests. Coordinate core validateScope API.
- Root: production snapshots, bindings, website/SW/client integration, release, source publication, continuity record.
- Security reviewer: independent review and negative tests; no production changes.
