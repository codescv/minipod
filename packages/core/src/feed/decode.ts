const asciiPreviewDecoder = new TextDecoder('iso-8859-1');

const CHARSET_ALIASES: Readonly<Record<string, string>> = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'iso-8859-1': 'iso-8859-1',
  iso88591: 'iso-8859-1',
  latin1: 'iso-8859-1',
  'latin-1': 'iso-8859-1',
  'windows-1252': 'windows-1252',
  cp1252: 'windows-1252',
  gb2312: 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  shift_jis: 'shift_jis',
  'shift-jis': 'shift_jis',
  sjis: 'shift_jis',
  'us-ascii': 'utf-8',
  ascii: 'utf-8',
};

function normalizeCharsetLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!cleaned) return undefined;
  return CHARSET_ALIASES[cleaned] ?? cleaned;
}

function extractHttpCharset(contentType?: string): string | undefined {
  if (!contentType) return undefined;
  const match = /charset\s*=\s*("[^"]+"|'[^']+'|[^\s;]+)/i.exec(contentType);
  return match ? normalizeCharsetLabel(match[1]) : undefined;
}

function extractXmlDeclarationEncoding(bytes: Uint8Array): string | undefined {
  const head = asciiPreviewDecoder.decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const declMatch = /^\s*<\?xml\b([^?]*)\?>/i.exec(head);
  if (!declMatch) return undefined;
  const encMatch = /\bencoding\s*=\s*["']([^"']+)["']/i.exec(declMatch[1]!);
  return encMatch ? normalizeCharsetLabel(encMatch[1]) : undefined;
}

/**
 * Port of Apache Commons `XmlStreamReader` encoding sniffing used by AntennaPod:
 * 1. Byte-Order Mark (UTF-8, UTF-16BE, UTF-16LE)
 * 2. XML declaration `<?xml encoding="..." ?>`
 * 3. HTTP `Content-Type` `charset=...`
 * 4. Default `utf-8`
 */
export function decodeFeedBytes(bytes: Uint8Array, contentTypeHeader?: string): string {
  if (bytes.length === 0) return '';

  // 1. BOM check
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }

  // 2. XML prolog -> HTTP charset -> UTF-8
  const encoding =
    extractXmlDeclarationEncoding(bytes) ?? extractHttpCharset(contentTypeHeader) ?? 'utf-8';

  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
