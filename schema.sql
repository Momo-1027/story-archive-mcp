PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  window_label TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT,
  category TEXT NOT NULL DEFAULT '其他',
  source_note TEXT,
  raw_content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paragraphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  paragraph_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(story_id, paragraph_no)
);

CREATE TABLE IF NOT EXISTS story_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  slot_no INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(story_id, slot_no)
);

CREATE TABLE IF NOT EXISTS content_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  block_no INTEGER NOT NULL,
  block_type TEXT NOT NULL,
  paragraph_id INTEGER REFERENCES paragraphs(id) ON DELETE CASCADE,
  image_id INTEGER REFERENCES story_images(id) ON DELETE CASCADE,
  caption TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(story_id, block_no)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS story_tags (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_by INTEGER REFERENCES actors(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(story_id, tag_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paragraph_id INTEGER NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  reply_to INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES actors(id) ON DELETE SET NULL,
  story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
  paragraph_id INTEGER REFERENCES paragraphs(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Full-text indexes are derived cache, not source-of-truth data.
-- Recreate them on startup so a damaged legacy FTS index can never block archive writes.
DROP TABLE IF EXISTS paragraph_fts;
DROP TABLE IF EXISTS story_fts;

CREATE VIRTUAL TABLE paragraph_fts USING fts5(
  content,
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE story_fts USING fts5(
  title,
  summary,
  tokenize='unicode61'
);

INSERT INTO paragraph_fts(rowid, content)
SELECT id, content FROM paragraphs;

INSERT INTO story_fts(rowid, title, summary)
SELECT id, title, COALESCE(summary, '') FROM stories;
