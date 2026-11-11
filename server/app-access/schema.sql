-- Additive, low-privilege app access. Existing vx_* account tables are untouched.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS va_users (
  id TEXT PRIMARY KEY,
  email_index TEXT NOT NULL UNIQUE,
  email_cipher TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  updates_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (updates_opt_in IN (0,1)),
  updates_consent_at INTEGER,
  updates_consent_version TEXT
);
CREATE TABLE IF NOT EXISTS va_flows (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL,
  return_path TEXT NOT NULL,
  state TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  browser_hash TEXT,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS va_flows_expiry ON va_flows(expires_at);
-- A logout-only browser grant. It cannot be redeemed or used to verify email.
CREATE TABLE IF NOT EXISTS va_logout_flows (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  sso_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS va_logout_expiry ON va_logout_flows(expires_at);
CREATE TABLE IF NOT EXISTS va_email_state (
  email_index TEXT PRIMARY KEY,
  latest_challenge TEXT NOT NULL,
  last_requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS va_email_challenges (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  email_index TEXT NOT NULL,
  email_cipher TEXT NOT NULL,
  code_mac TEXT NOT NULL,
  updates_opt_in INTEGER NOT NULL CHECK (updates_opt_in IN (0,1)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1)),
  delivery TEXT NOT NULL CHECK (delivery IN ('pending','sent','failed')),
  claim_nonce TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS va_challenge_expiry ON va_email_challenges(expires_at);
CREATE TABLE IF NOT EXISTS va_sso_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES va_users(id),
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS va_sso_user ON va_sso_sessions(user_id);
CREATE INDEX IF NOT EXISTS va_sso_expiry ON va_sso_sessions(expires_at);
CREATE TABLE IF NOT EXISTS va_handoffs (
  code_hash TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  sso_hash TEXT NOT NULL REFERENCES va_sso_sessions(token_hash) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES va_users(id),
  epoch INTEGER NOT NULL,
  audience TEXT NOT NULL,
  return_path TEXT NOT NULL,
  state TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1)),
  claim_nonce TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS va_handoff_expiry ON va_handoffs(expires_at);
CREATE TABLE IF NOT EXISTS va_app_sessions (
  token_hash TEXT PRIMARY KEY,
  sso_hash TEXT NOT NULL REFERENCES va_sso_sessions(token_hash) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES va_users(id),
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  audience TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS va_app_parent ON va_app_sessions(sso_hash);
CREATE INDEX IF NOT EXISTS va_app_expiry ON va_app_sessions(expires_at);
CREATE TABLE IF NOT EXISTS va_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS va_limits_expiry ON va_limits(expires_at);
CREATE TABLE IF NOT EXISTS va_mail_budget (
  key TEXT PRIMARY KEY,
  sent INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
