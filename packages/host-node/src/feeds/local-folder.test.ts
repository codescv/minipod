import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanLocalFolder } from './local-folder';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function encodeSynchsafe32(n: number): Buffer {
  return Buffer.from([
    (n >> 21) & 0x7f,
    (n >> 14) & 0x7f,
    (n >> 7) & 0x7f,
    n & 0x7f,
  ]);
}

function makeId3v23TextFrame(id: string, text: string): Buffer {
  const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf8')]);
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function makeId3v23ChapFrame(elementId: string, startMs: number, endMs: number, title: string): Buffer {
  const subTit2 = makeId3v23TextFrame('TIT2', title);
  const elemBuf = Buffer.concat([Buffer.from(elementId, 'ascii'), Buffer.from([0x00])]);
  const times = Buffer.alloc(16);
  times.writeUInt32BE(startMs, 0);
  times.writeUInt32BE(endMs, 4);
  times.writeUInt32BE(0xffffffff, 8);
  times.writeUInt32BE(0xffffffff, 12);
  const payload = Buffer.concat([elemBuf, times, subTit2]);
  const header = Buffer.alloc(10);
  header.write('CHAP', 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function buildSyntheticId3Mp3(options: { title: string; artist: string; chapterTitle: string }): Buffer {
  const frames = Buffer.concat([
    makeId3v23TextFrame('TIT2', options.title),
    makeId3v23TextFrame('TPE1', options.artist),
    makeId3v23TextFrame('TLEN', '95000'),
    makeId3v23ChapFrame('chp0', 0, 30_000, options.chapterTitle),
  ]);
  const tagHeader = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([0x03, 0x00, 0x00]),
    encodeSynchsafe32(frames.length),
  ]);
  return Buffer.concat([tagHeader, frames, Buffer.alloc(64, 0xff)]);
}

describe('scanLocalFolder', () => {
  it('scans folder.jpg cover art, audio/video files, and ID3v2 tags + chapters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'minipod-local-folder-'));
    tempDirs.push(dir);

    writeFileSync(join(dir, 'folder.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    writeFileSync(join(dir, 'notes.txt'), 'ignored text file');
    writeFileSync(
      join(dir, '01-intro.mp3'),
      buildSyntheticId3Mp3({
        title: 'Chaptered Audiobook Part 1',
        artist: 'Jane Doe',
        chapterTitle: 'Opening Credits',
      }),
    );
    writeFileSync(join(dir, '02-bonus.mp4'), Buffer.alloc(128, 0x00));

    const result = scanLocalFolder(dir, { displayName: 'My Audiobooks' });

    expect(result.feedKey.startsWith('l_')).toBe(true);
    expect(result.localCoverSpec).toBe(join(dir, 'folder.jpg'));
    expect(result.parsed.title).toBe('My Audiobooks');
    expect(result.parsed.author).toBe('Jane Doe');
    expect(result.parsed.imageUrl).toContain(`/api/feeds/${encodeURIComponent(result.feedKey)}/cover`);
    expect(result.parsed.episodes).toHaveLength(2);

    const mp3Ep = result.parsed.episodes.find((e) => e.identity === '01-intro.mp3');
    expect(mp3Ep).toBeDefined();
    expect(mp3Ep?.title).toBe('Chaptered Audiobook Part 1');
    expect(mp3Ep?.durationMs).toBe(95_000);
    expect(mp3Ep?.mediaType).toBe('AUDIO');
    expect(mp3Ep?.chapters).toEqual([
      {
        startMs: 0,
        title: 'Opening Credits',
        source: 'ID3',
      },
    ]);

    const mp4Ep = result.parsed.episodes.find((e) => e.identity === '02-bonus.mp4');
    expect(mp4Ep?.title).toBe('02-bonus');
    expect(mp4Ep?.mediaType).toBe('VIDEO');
  });
});
