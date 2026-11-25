ALTER TABLE feeds ADD COLUMN device_id TEXT;
ALTER TABLE sync_state ADD COLUMN remote_devices_json TEXT;
ALTER TABLE sync_state ADD COLUMN last_remote_fingerprint TEXT;
ALTER TABLE sync_state ADD COLUMN pending_lineage_reset INTEGER NOT NULL DEFAULT 0;
