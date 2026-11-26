-- Install after schema.sql. Photos share the parent article's optimistic revision.
CREATE TABLE IF NOT EXISTS blog_photos (
  slug TEXT PRIMARY KEY NOT NULL REFERENCES blog_posts(slug) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  alt_text TEXT NOT NULL CHECK (length(alt_text) BETWEEN 1 AND 300 AND length(trim(alt_text, char(9,10,13,32))) > 0),
  caption TEXT NOT NULL DEFAULT '' CHECK (length(caption) <= 500),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 1572864),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  data BLOB NOT NULL CHECK (length(data) = byte_length)
) STRICT;

CREATE TRIGGER IF NOT EXISTS blog_photo_insert_revision AFTER INSERT ON blog_photos
BEGIN
  UPDATE blog_posts SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE slug = NEW.slug;
END;

CREATE TRIGGER IF NOT EXISTS blog_photo_update_revision AFTER UPDATE ON blog_photos
BEGIN
  SELECT CASE WHEN NEW.slug != OLD.slug THEN RAISE(ABORT, 'Photo slug is immutable') END;
  UPDATE blog_posts SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE slug = NEW.slug;
END;

CREATE TRIGGER IF NOT EXISTS blog_photo_delete_revision AFTER DELETE ON blog_photos
BEGIN
  UPDATE blog_posts SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE slug = OLD.slug;
END;
