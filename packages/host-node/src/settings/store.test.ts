import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/sqlite';
import { SettingsStore } from './store';

describe('SettingsStore schemaVersion 2 migration (b1d6d66b)', () => {
  it('forces deleteDownloadWhenPlayed on for legacy schemaVersion 1 rows but honors explicit writes at schemaVersion 2', () => {
    const db = openDatabase(':memory:');
    const store = new SettingsStore(db, ':memory:', 'Desk');

    expect(store.get()).toMatchObject({ schemaVersion: 2, deleteDownloadWhenPlayed: true });

    // Legacy row persisted before the toggle was removed (v0.1.14)
    db.prepare(
      `INSERT INTO settings (key, json) VALUES ('app', ?)
       ON CONFLICT(key) DO UPDATE SET json = excluded.json`,
    ).run(JSON.stringify({ schemaVersion: 1, deleteDownloadWhenPlayed: false, playbackSpeed: 1.5 }));
    expect(store.get()).toMatchObject({
      schemaVersion: 2,
      deleteDownloadWhenPlayed: true,
      playbackSpeed: 1.5,
    });

    // An unrelated update persists the migrated value at schemaVersion 2
    store.update({ playbackSpeed: 1.0 });
    const row = db.prepare("SELECT json FROM settings WHERE key = 'app'").get() as { json: string };
    expect(JSON.parse(row.json)).toMatchObject({ schemaVersion: 2, deleteDownloadWhenPlayed: true });

    // An explicit opt-out at the current schema is respected (even if the patch carries a stale schemaVersion)
    const updated = store.update({ deleteDownloadWhenPlayed: false, schemaVersion: 1 });
    expect(updated).toMatchObject({ schemaVersion: 2, deleteDownloadWhenPlayed: false });
    expect(store.get()).toMatchObject({ schemaVersion: 2, deleteDownloadWhenPlayed: false });
  });
});
