-- Additive indexes for existing app-access databases. No rows or permissions change.
-- Apply after database service and quota recover; do not retry during quota exhaustion.
CREATE INDEX IF NOT EXISTS va_email_state_expiry ON va_email_state(expires_at);
CREATE INDEX IF NOT EXISTS va_handoff_parent ON va_handoffs(sso_hash);
