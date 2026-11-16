# Architecture and trust boundaries

## Android client

- The Compose app provides email-code onboarding, a conversation list, direct invitations by Matrix ID, contact sharing and one-to-one text conversations. A contact QR encodes an ID for exchange. Short Authentication String (SAS) comparison is the separate verification step. Compare the complete challenge with the intended person through a separate trusted channel before confirming.
- The Matrix Rust SDK for Android (`org.matrix.rustcomponents:sdk-android:26.11.05`) provides Matrix sessions, sync, room encryption, decryption and device verification. The app constrains its messaging flow to an encrypted direct conversation with an account on the configured service. The send guard requires an encrypted, joined conversation and a verified contact. The client configures the SDK to share keys only with trusted devices and require cross-signed sender devices for decryption. Server acknowledgment indicates that Matrix accepted an event. Delivery to a recipient and reading are separate states.
- The client stores Matrix session material in Android’s `noBackupFilesDir`. The session record uses AES-GCM with an Android Keystore key. A randomly generated key for the SDK’s encrypted store is retained in that record. The manifest disables app backup and the activity requests Android’s secure window flag. Check the platform behavior on real devices, including accessibility and recent-apps behavior. A recipient or someone controlling a device can still see what that device decrypts.
- Logout clears the local session and encryption keys. It also attempts to revoke the device session on the server. The app reports when it cannot confirm revocation. The server, another Matrix device and the other person may retain their own copies. Reinstall, key loss or a fresh sign-in can make prior encrypted history unreadable. This alpha has no recovery or history transfer. Verification of a new device or changed identity must be tested explicitly.

## Synapse and email sign-in

The Synapse module accepts a request for an email code and checks the code against a bounded, expiring challenge before issuing a short-lived Matrix login token. The Android app exchanges that token for a normal Matrix device session. The code verifies access to an email inbox. Account access and verification of the intended conversation partner are separate steps.

The challenge store uses keyed digests for email, source address and code checks. The email delivery path sees the recipient address and one-time code. The Matrix account ID is derived from a separate keyed value and has no address embedded. Rate limits and expiration reduce abuse. Mailbox compromise, an untrusted homeserver or a device compromise remain outside the protection offered by these controls.

The development fixture starts one local Synapse process with loopback HTTP and an optional authenticated synthetic mailbox endpoint. It enables the client API for a standalone test server. The development mailbox accepts only `@example.test` recipients and stores short-lived codes in its private spool. The release build requires an HTTPS service address. Debug loopback HTTP is for the fixture. Running a public HTTPS service, enabling federation and adding managed email delivery each require an explicit deployment review.

## Metadata and operational limits

- The homeserver can see Matrix identities, room membership, device activity, connection addresses, event timing and ciphertext sizes. Delivery providers can see email metadata. This app does not upload the phone address book or require a phone number.
- Matrix encryption aims to keep message bodies readable by participants’ devices. Its protection depends on correct SDK and server behavior, the peer identity check, devices and key handling. Local checks cover specific test cases. Independent review and device testing remain release gates.
- The alpha syncs while the app is active. It does not register push tokens or provide a locked-screen delivery commitment. The server can hold an encrypted event for sync when a client reconnects. Device sleep, battery policy, network loss and process eviction require physical testing.
- The alpha scope covers direct text. It excludes groups, attachments, calls, public federation, subscriptions and recovery. Use fictional input while evaluating it.
