import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpResponse } from '../types';
import {
  ChapterLoader,
  ChapterMerger,
  mergeAllChapterSources,
  mergeChapters,
  parseId3Chapters,
  parseMediaMetadata,
  parseMp4Chapters,
  parsePodcastIndexChapters,
  parsePscChapters,
  parseVorbisChapters,
  sniffMediaFormat,
} from './index';

const encoder = new TextEncoder();

function concat(...arrays: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function u64be(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, false);
  return b;
}

function synchsafe(n: number): Uint8Array {
  return new Uint8Array([
    (n >>> 21) & 0x7f,
    (n >>> 14) & 0x7f,
    (n >>> 7) & 0x7f,
    n & 0x7f,
  ]);
}

function id3v23Frame(id: string, payload: Uint8Array): Uint8Array {
  return concat(encoder.encode(id), u32be(payload.length), new Uint8Array([0, 0]), payload);
}

function mp4Box(type: string, ...children: readonly Uint8Array[]): Uint8Array {
  const body = concat(...children);
  return concat(u32be(8 + body.length), encoder.encode(type), body);
}

describe('chapters/sniff, id3, vorbis, mp4, psc, pi-json, merger & loader', () => {
  it('sniffs ID3, OGG, FLAC, MP4, and UNKNOWN magic headers', () => {
    expect(sniffMediaFormat(encoder.encode('ID3\x03\x00\x00\x00\x00\x00\x00'))).toBe('ID3');
    expect(sniffMediaFormat(encoder.encode('OggS\x00\x02'))).toBe('OGG');
    expect(sniffMediaFormat(encoder.encode('fLaC\x00\x00'))).toBe('FLAC');
    expect(sniffMediaFormat(concat(u32be(20), encoder.encode('ftypM4A ')))).toBe('MP4');
    expect(sniffMediaFormat(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe('UNKNOWN');
  });

  it('parses ID3v2.3 CHAP + CTOC + TIT2 + WXXX + APIC byte-slice offsets & metadata', () => {
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0x33, 0xff, 0xd9]);

    const buildChap = (
      elemId: string,
      startMs: number,
      title: string,
      url?: string,
      apicBytes?: Uint8Array,
    ): Uint8Array => {
      const subframes: Uint8Array[] = [
        // TIT2 UTF-8 (encoding 3)
        id3v23Frame('TIT2', concat(new Uint8Array([3]), encoder.encode(title))),
      ];
      if (url) {
        // WXXX: encoding 0 + empty null-terminated description + ISO URL
        subframes.push(id3v23Frame('WXXX', concat(new Uint8Array([0, 0]), encoder.encode(url))));
      }
      if (apicBytes) {
        // APIC: encoding 0 + "image/jpeg\0" + picType 3 (cover) + "\0" + raw bytes
        subframes.push(
          id3v23Frame(
            'APIC',
            concat(
              new Uint8Array([0]),
              encoder.encode('image/jpeg\0'),
              new Uint8Array([3, 0]),
              apicBytes,
            ),
          ),
        );
      }
      const header = concat(
        encoder.encode(`${elemId}\0`),
        u32be(startMs),
        u32be(startMs + 60_000),
        u32be(0xffffffff),
        u32be(0xffffffff),
      );
      return id3v23Frame('CHAP', concat(header, ...subframes));
    };

    const tit2Main = id3v23Frame('TIT2', concat(new Uint8Array([3]), encoder.encode('My Local Episode')));
    const tpe1Main = id3v23Frame('TPE1', concat(new Uint8Array([3]), encoder.encode('Host Speaker')));
    // CTOC top-level (flags = 0x03) selecting only ch1 and ch2 (ignoring bonus hidden chX)
    const ctoc = id3v23Frame(
      'CTOC',
      concat(
        encoder.encode('toc1\0'),
        new Uint8Array([0x03, 2]),
        encoder.encode('ch2\0ch1\0'),
      ),
    );
    const chap2 = buildChap('ch2', 120_000, 'Deep Dive', 'https://example.com/deep', fakeJpeg);
    const chap1 = buildChap('ch1', 0, 'Welcome');
    const chapIgnored = buildChap('ch_hidden', 300_000, 'Not in top-level CTOC');

    const frames = concat(tit2Main, tpe1Main, ctoc, chap2, chap1, chapIgnored);
    const id3Tag = concat(
      encoder.encode('ID3'),
      new Uint8Array([3, 0, 0]),
      synchsafe(frames.length),
      frames,
    );

    const chapters = parseId3Chapters(id3Tag, 0);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toEqual({
      startMs: 0,
      title: 'Welcome',
      source: 'ID3',
    });
    expect(chapters[1]?.startMs).toBe(120_000);
    expect(chapters[1]?.title).toBe('Deep Dive');
    expect(chapters[1]?.link).toBe('https://example.com/deep');
    expect(chapters[1]?.embeddedImage?.mime).toBe('image/jpeg');

    // Verify embeddedImage byte slice points to the exact JPEG bytes inside the file!
    const slice = chapters[1]!.embeddedImage!;
    expect(id3Tag.slice(slice.offset, slice.offset + slice.length)).toEqual(fakeJpeg);

    const meta = parseMediaMetadata(id3Tag);
    expect(meta.format).toBe('ID3');
    expect(meta.title).toBe('My Local Episode');
    expect(meta.artist).toBe('Host Speaker');
  });

  it('parses Ogg Opus & native FLAC Vorbis comments including 3-digit IDs >= 100 and float ms', () => {
    const comments = [
      'TITLE=Opus Episode',
      'CHAPTER001=00:00:00.000',
      'CHAPTER001NAME=Opening',
      'CHAPTER002=00:00:12.850',
      'CHAPTER002NAME=Sub-second Precision',
      'CHAPTER002URL=https://example.org/ch2',
      'CHAPTER105=01:00:00.250',
      'CHAPTER105NAME=Hundred-and-Fifth Chapter',
    ];
    const vendor = encoder.encode('MiniPodTest');
    const commentPayload = concat(
      u32le(vendor.length),
      vendor,
      u32le(comments.length),
      ...comments.map((c) => {
        const b = encoder.encode(c);
        return concat(u32le(b.length), b);
      }),
    );

    // Wrap inside an Ogg page containing an `OpusTags` packet
    const opusPacket = concat(encoder.encode('OpusTags'), commentPayload);
    const segments: number[] = [];
    let rem = opusPacket.length;
    while (rem >= 255) {
      segments.push(255);
      rem -= 255;
    }
    segments.push(rem);
    const oggPage = concat(
      encoder.encode('OggS'),
      new Uint8Array([0, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      new Uint8Array([segments.length, ...segments]),
      opusPacket,
    );

    const oggChapters = parseVorbisChapters(oggPage);
    expect(oggChapters).toEqual([
      { startMs: 0, title: 'Opening', source: 'VORBIS' },
      {
        startMs: 12_850,
        title: 'Sub-second Precision',
        link: 'https://example.org/ch2',
        source: 'VORBIS',
      },
      { startMs: 3_600_250, title: 'Hundred-and-Fifth Chapter', source: 'VORBIS' },
    ]);

    // Also verify native FLAC block type 4 (VORBIS_COMMENT, last-metadata-block flag 0x84)
    const len24 = new Uint8Array([
      (commentPayload.length >>> 16) & 0xff,
      (commentPayload.length >>> 8) & 0xff,
      commentPayload.length & 0xff,
    ]);
    const flacBytes = concat(encoder.encode('fLaC'), new Uint8Array([0x84]), len24, commentPayload);
    expect(parseVorbisChapters(flacBytes)).toEqual(oggChapters);
  });

  it('parses MP4 moov.udta.chpl Nero chapters and mvhd duration', () => {
    const title1 = encoder.encode('Chapter One');
    const title2 = encoder.encode('Chapter Two');
    // Nero chpl v1: version(1)=1 + flags(3)=0 + reserved(4)=0 + count(1)=2 + entries(start_100ns u64be + len u8 + utf8)
    const chplPayload = concat(
      new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 2]),
      u64be(0n),
      new Uint8Array([title1.length]),
      title1,
      u64be(45_500n * 10_000n), // 45,500 ms in 100ns units
      new Uint8Array([title2.length]),
      title2,
    );

    // mvhd v0: version/flags(4) + creation(4) + mod(4) + timescale(4)=1000 + duration(4)=90000
    const mvhdPayload = concat(
      new Uint8Array(12),
      u32be(1000),
      u32be(90_000),
      new Uint8Array(16),
    );

    const mp4 = concat(
      mp4Box('ftyp', encoder.encode('M4A \x00\x00\x00\x00')),
      mp4Box('moov', mp4Box('mvhd', mvhdPayload), mp4Box('udta', mp4Box('chpl', chplPayload))),
    );

    expect(parseMp4Chapters(mp4)).toEqual([
      { startMs: 0, title: 'Chapter One', source: 'MP4' },
      { startMs: 45_500, title: 'Chapter Two', source: 'MP4' },
    ]);
    expect(parseMediaMetadata(mp4).durationMs).toBe(90_000);
  });

  it('parses PSC and PodcastIndex JSON chapters and merges via AntennaPod 1000ms alignment & quality score rules', () => {
    const psc = parsePscChapters(
      `<psc:chapters xmlns:psc="http://podlove.org/simple-chapters">
        <psc:chapter start="00:00:00" title="Feed Intro" href="/intro" />
        <psc:chapter start="00:05:00" title="Feed Topic" />
      </psc:chapters>`,
      'https://show.example.com/rss',
    );
    expect(psc[0]?.link).toBe('https://show.example.com/intro');

    const piJson = parsePodcastIndexChapters(
      JSON.stringify({
        version: '1.2.0',
        chapters: [
          { startTime: 0.4, title: '', img: 'https://show.example.com/ch1.png' },
          { startTime: 300.75, title: 'Rich Topic', url: 'https://show.example.com/topic' },
          { startTime: 999, title: 'Hidden', toc: false },
        ],
      }),
    );
    expect(piJson).toHaveLength(2);
    expect(piJson[1]?.startMs).toBe(300_750);

    // Equal count, |start2 - start1| <= 1000ms -> positional merge filling missing title/link/image!
    const merged = mergeAllChapterSources({ feed: psc, external: piJson });
    expect(merged).toEqual([
      {
        startMs: 400,
        title: 'Feed Intro',
        link: 'https://show.example.com/intro',
        imageUrl: 'https://show.example.com/ch1.png',
        source: 'PI_JSON',
      },
      {
        startMs: 300_750,
        title: 'Rich Topic',
        link: 'https://show.example.com/topic',
        source: 'PI_JSON',
      },
    ]);

    // Misaligned (> 1000ms difference) with equal count -> higher quality score wins
    const rich = [
      { startMs: 0, title: 'A', link: 'https://x', imageUrl: 'https://img', source: 'PSC' as const },
      { startMs: 10_000, title: 'B', link: 'https://y', source: 'PSC' as const },
    ];
    const sparse = [
      { startMs: 0, title: 'A2', source: 'ID3' as const },
      { startMs: 25_000, title: '', source: 'ID3' as const },
    ];
    expect(ChapterMerger.merge(rich, sparse)).toEqual(mergeChapters(rich, sparse));
    expect(mergeChapters(rich, sparse)).toEqual(rich);

    // Blank titles get enumerated ("Chapter 2")
    const enumerated = ChapterMerger.enumerateMissingTitles(sparse);
    expect(enumerated[1]?.title).toBe('Chapter 2');
  });

  it('ChapterLoader merges feed PSC, Range-probed embedded chapters, and external JSON chapters', async () => {
    const http: HttpClient = async (req): Promise<HttpResponse> => {
      if (req.url === 'https://cdn.example.com/ep.json') {
        const text = JSON.stringify({
          chapters: [{ startTime: 0, img: 'https://cdn.example.com/cover0.jpg' }],
        });
        return {
          status: 200,
          headers: {},
          finalUrl: req.url,
          chain: [],
          bytes: async () => encoder.encode(text),
          text: async () => text,
        };
      }
      // Enclosure 206 Partial Content with ID3v2.3 chapter
      const chapSub = id3v23Frame('TIT2', concat(new Uint8Array([3]), encoder.encode('Embedded Title')));
      const chap = id3v23Frame(
        'CHAP',
        concat(
          encoder.encode('c0\0'),
          u32be(200),
          u32be(10_000),
          u32be(0xffffffff),
          u32be(0xffffffff),
          chapSub,
        ),
      );
      const id3 = concat(encoder.encode('ID3'), new Uint8Array([3, 0, 0]), synchsafe(chap.length), chap);
      return {
        status: 206,
        headers: { 'content-range': `bytes 0-${id3.length - 1}/5000000` },
        finalUrl: req.url,
        chain: [],
        bytes: async () => id3,
        text: async () => '',
      };
    };

    const loaded = await ChapterLoader.load(
      {
        enclosureUrl: 'https://cdn.example.com/ep.mp3',
        chaptersUrl: 'https://cdn.example.com/ep.json',
        downloadState: 'NONE',
      },
      {
        http,
        feedChapters: [{ startMs: 0, link: 'https://show.example.com/notes', source: 'PSC' }],
      },
    );

    expect(loaded).toEqual([
      {
        startMs: 0,
        title: 'Embedded Title',
        link: 'https://show.example.com/notes',
        imageUrl: 'https://cdn.example.com/cover0.jpg',
        source: 'PI_JSON',
      },
    ]);
  });
});
