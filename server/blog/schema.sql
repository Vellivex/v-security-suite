-- Vellivex blog content. Run once against the dedicated blog database.
CREATE TABLE blog_reserved_slugs (slug TEXT PRIMARY KEY NOT NULL) STRICT;

INSERT INTO blog_reserved_slugs (slug) VALUES
  ('android-approximate-location-one-app-check'),
  ('android-firewall-test-checklist'),
  ('android-lock-screen-notification-preview-check'),
  ('development-log-key-and-offline-hardening'),
  ('development-log-next-validation-gates'),
  ('development-log-release-evidence'),
  ('grapheneos-privacy-phones-uk'),
  ('privacy-app-bug-report-without-private-message'),
  ('read-security-claims-before-testing'),
  ('repeat-beta-test-record-what-changed'),
  ('technical-cipher-qr-transport-boundaries'),
  ('technical-offline-integrity-and-response-policy'),
  ('technical-vvault-envelope-design'),
  ('test-local-message-encryption'),
  ('transfer-ciphertext-without-sharing-the-passphrase');

CREATE TABLE blog_posts (
  slug TEXT PRIMARY KEY NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 100 AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160 AND length(trim(title, char(9,10,13,32))) > 0),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 400 AND length(trim(summary, char(9,10,13,32))) > 0),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 60000 AND length(trim(body, char(9,10,13,32))) > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at TEXT CHECK (published_at IS NULL OR (
    length(published_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', published_at) IS published_at
  )),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (
    length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (status != 'published' OR published_at IS NOT NULL)
) STRICT;

CREATE INDEX blog_by_publication ON blog_posts(status, published_at DESC, slug);

CREATE TRIGGER blog_check_new BEFORE INSERT ON blog_posts
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM blog_reserved_slugs WHERE slug = NEW.slug)
    THEN RAISE(ABORT, 'Existing website article uses this slug') END;
  SELECT CASE WHEN NEW.revision != 1 THEN RAISE(ABORT, 'New article must start at revision 1') END;
END;

CREATE TRIGGER blog_check_update BEFORE UPDATE ON blog_posts
BEGIN
  SELECT CASE WHEN NEW.slug != OLD.slug THEN RAISE(ABORT, 'Article slug is immutable') END;
  SELECT CASE WHEN NEW.revision != OLD.revision + 1 THEN RAISE(ABORT, 'Article revision must advance by one') END;
  SELECT CASE WHEN OLD.published_at IS NOT NULL AND NEW.published_at IS NOT OLD.published_at
    THEN RAISE(ABORT, 'Keep the first publication timestamp') END;
END;
