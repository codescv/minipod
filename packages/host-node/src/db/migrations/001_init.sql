CREATE TABLE feeds (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_key          TEXT    NOT NULL UNIQUE,
  kind              TEXT    NOT NULL CHECK (kind IN ('RSS','LOCAL')),
  subscribed        INTEGER NOT NULL DEFAULT 0,
  url               TEXT    NOT NULL,
  moved_to          TEXT,
  title             TEXT,
  author            TEXT,
  description       TEXT,
  link              TEXT,
  image_url         TEXT,
  language          TEXT,
  funding_url       TEXT,
  local_cover_path  TEXT,
  has_credentials   INTEGER NOT NULL DEFAULT 0,
  etag              TEXT,
  last_modified     TEXT,
  next_page_url     TEXT,
  last_refreshed_at INTEGER,
  last_episode_at   INTEGER,
  added_at          INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  sync_dirty        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE episodes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id           INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  episode_key       TEXT    NOT NULL UNIQUE,
  identity          TEXT    NOT NULL,
  is_stub           INTEGER NOT NULL DEFAULT 0,
  title             TEXT    NOT NULL,
  description       TEXT,
  link              TEXT,
  image_url         TEXT,
  pub_date          INTEGER,
  duration_ms       INTEGER,
  enclosure_url     TEXT,
  enclosure_mime    TEXT,
  enclosure_size    INTEGER,
  media_type        TEXT    NOT NULL DEFAULT 'UNKNOWN' CHECK (media_type IN ('AUDIO','VIDEO','UNKNOWN')),
  chapters_url      TEXT,
  chapters_type     TEXT,
  transcript_url    TEXT,
  transcript_type   TEXT,
  download_path     TEXT,
  download_state    TEXT    NOT NULL DEFAULT 'NONE' CHECK (download_state IN ('NONE','QUEUED','RUNNING','DONE','FAILED')),
  chapters_merged   INTEGER NOT NULL DEFAULT 0,
  local_mtime_ms    INTEGER
);
CREATE INDEX idx_episodes_feed_pub ON episodes(feed_id, pub_date DESC, id DESC);

CREATE TABLE progress (
  episode_key       TEXT    PRIMARY KEY,
  feed_key          TEXT    NOT NULL,
  identity          TEXT,
  position_ms       INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  state             TEXT    NOT NULL CHECK (state IN ('NEW','IN_PROGRESS','PLAYED')),
  played_at         INTEGER,
  updated_at        INTEGER NOT NULL,
  device_id         TEXT    NOT NULL,
  sync_dirty        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_progress_feed ON progress(feed_key);

CREATE TABLE queue (
  episode_key       TEXT    PRIMARY KEY,
  feed_key          TEXT    NOT NULL,
  pos               TEXT    NOT NULL,
  added_at          INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  removed           INTEGER NOT NULL DEFAULT 0,
  device_id         TEXT    NOT NULL,
  stub_json         TEXT,
  sync_dirty        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_queue_order ON queue(removed, pos);

CREATE TABLE chapters (
  episode_id          INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  start_ms            INTEGER NOT NULL,
  title               TEXT,
  link                TEXT,
  image_url           TEXT,
  embedded_image_json TEXT,
  source              TEXT    NOT NULL CHECK (source IN ('PI_JSON','PSC','ID3','VORBIS','MP4')),
  is_feed_psc         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (episode_id, is_feed_psc, start_ms)
);

CREATE TABLE sync_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  provider            TEXT,
  provider_config     TEXT,
  device_id           TEXT    NOT NULL,
  device_name         TEXT    NOT NULL,
  remote_etag         TEXT,
  remote_file_id      TEXT,
  remote_rev          INTEGER NOT NULL DEFAULT 0,
  floor_subscriptions INTEGER NOT NULL DEFAULT 0,
  floor_queue         INTEGER NOT NULL DEFAULT 0,
  floor_progress      INTEGER NOT NULL DEFAULT 0,
  hlc_last            INTEGER NOT NULL DEFAULT 0,
  last_pull_at        INTEGER,
  last_push_at        INTEGER,
  last_error_json     TEXT,
  backoff_until       INTEGER
);

CREATE TABLE settings (
  key  TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
