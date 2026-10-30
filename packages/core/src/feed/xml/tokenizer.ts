export const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';

export interface XmlAttribute {
  readonly rawName: string;
  readonly prefix: string;
  readonly localName: string;
  readonly uri: string;
  readonly value: string;
}

export type XmlEvent =
  | {
      readonly type: 'startElement';
      readonly rawName: string;
      readonly prefix: string;
      readonly localName: string;
      readonly uri: string;
      readonly attributes: readonly XmlAttribute[];
    }
  | {
      readonly type: 'endElement';
      readonly rawName: string;
      readonly prefix: string;
      readonly localName: string;
      readonly uri: string;
    }
  | {
      readonly type: 'text';
      readonly text: string;
      readonly cdata: boolean;
    };

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  hellip: '\u2026',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  euro: '\u20AC',
  pound: '\u00A3',
  yen: '\u00A5',
  bull: '\u2022',
  middot: '\u00B7',
};

/**
 * Tolerant XML/HTML entity decoder. Unknown or unescaped `&` sequences are preserved verbatim.
 */
export function decodeXmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,15});/g, (full, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return full;
        }
      }
      return full;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return full;
        }
      }
      return full;
    }
    const mapped = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return mapped ?? full;
  });
}

/**
 * Escapes text for XML 1.0 element/attribute serialization.
 */
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Lightweight equivalent of Android's `HtmlCompat.fromHtml(..., FROM_HTML_MODE_COMPACT).toString()`
 * for sanitizing titles and channel descriptions without `DOMParser`.
 */
export function stripHtmlCompact(input: string): string {
  if (!input) return '';
  const withBreaks = input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(withBreaks)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitQName(rawName: string): { prefix: string; localName: string } {
  const colonIdx = rawName.indexOf(':');
  if (colonIdx < 0) return { prefix: '', localName: rawName };
  return {
    prefix: rawName.slice(0, colonIdx),
    localName: rawName.slice(colonIdx + 1),
  };
}

interface RawParsedAttr {
  readonly rawName: string;
  readonly value: string;
}

function parseTagAttributes(attrSlice: string): RawParsedAttr[] {
  const attrs: RawParsedAttr[] = [];
  let i = 0;
  const len = attrSlice.length;

  while (i < len) {
    // Skip whitespace and stray `/`
    while (i < len && /[\s/]/.test(attrSlice[i]!)) i++;
    if (i >= len) break;

    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(attrSlice[i]!)) i++;
    const rawName = attrSlice.slice(nameStart, i);
    if (!rawName) {
      i++;
      continue;
    }

    while (i < len && /\s/.test(attrSlice[i]!)) i++;
    if (i >= len || attrSlice[i] !== '=') {
      attrs.push({ rawName, value: '' });
      continue;
    }
    i++; // skip '='
    while (i < len && /\s/.test(attrSlice[i]!)) i++;

    let rawValue = '';
    if (i < len && (attrSlice[i] === '"' || attrSlice[i] === "'")) {
      const quote = attrSlice[i]!;
      i++;
      const valStart = i;
      const closeIdx = attrSlice.indexOf(quote, i);
      if (closeIdx < 0) {
        rawValue = attrSlice.slice(valStart);
        i = len;
      } else {
        rawValue = attrSlice.slice(valStart, closeIdx);
        i = closeIdx + 1;
      }
    } else {
      const valStart = i;
      while (i < len && !/[\s/>]/.test(attrSlice[i]!)) i++;
      rawValue = attrSlice.slice(valStart, i);
    }

    attrs.push({ rawName, value: decodeXmlEntities(rawValue) });
  }
  return attrs;
}

function findTagEnd(xml: string, startAfterLt: number): number {
  let quote: string | null = null;
  for (let i = startAfterLt; i < xml.length; i++) {
    const ch = xml[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function skipDoctype(xml: string, startAtBang: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = startAtBang; i < xml.length; i++) {
    const ch = xml[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      if (depth > 0) depth--;
    } else if (ch === '>' && depth === 0) {
      return i + 1;
    }
  }
  return xml.length;
}

/**
 * Pure-TS tolerant streaming XML 1.0 + Namespaces tokenizer.
 * Maintains a lexical namespace scope stack, strips BOM, skips comments/PIs/DOCTYPE,
 * handles CDATA, self-closing elements, and unescaped `&` in messy real-world feeds.
 */
export function* tokenizeXml(rawXml: string): Generator<XmlEvent, void, undefined> {
  const xml = rawXml.charCodeAt(0) === 0xfeff ? rawXml.slice(1) : rawXml;
  const len = xml.length;

  const baseNs = new Map<string, string>([['xml', XML_NAMESPACE_URI]]);
  const nsStack: Map<string, string>[] = [baseNs];
  const openElements: { rawName: string; prefix: string; localName: string; uri: string }[] = [];

  let pos = 0;
  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) {
      const trailing = xml.slice(pos);
      if (trailing.length > 0) {
        yield { type: 'text', text: decodeXmlEntities(trailing), cdata: false };
      }
      break;
    }

    if (lt > pos) {
      const chunk = xml.slice(pos, lt);
      yield { type: 'text', text: decodeXmlEntities(chunk), cdata: false };
    }

    // Comment <!-- ... -->
    if (xml.startsWith('<!--', lt)) {
      const endComment = xml.indexOf('-->', lt + 4);
      pos = endComment < 0 ? len : endComment + 3;
      continue;
    }

    // CDATA <![CDATA[ ... ]]>
    if (xml.startsWith('<![CDATA[', lt)) {
      const endCdata = xml.indexOf(']]>', lt + 9);
      if (endCdata < 0) {
        yield { type: 'text', text: xml.slice(lt + 9), cdata: true };
        break;
      }
      yield { type: 'text', text: xml.slice(lt + 9, endCdata), cdata: true };
      pos = endCdata + 3;
      continue;
    }

    // Processing instruction <? ... ?>
    if (xml.startsWith('<?', lt)) {
      const endPi = xml.indexOf('?>', lt + 2);
      pos = endPi < 0 ? len : endPi + 2;
      continue;
    }

    // DOCTYPE or other declaration <! ... >
    if (xml.startsWith('<!', lt)) {
      pos = skipDoctype(xml, lt + 2);
      continue;
    }

    const gt = findTagEnd(xml, lt + 1);
    if (gt < 0) {
      // Unclosed `<` in unescaped text — emit literally and stop
      yield { type: 'text', text: decodeXmlEntities(xml.slice(lt)), cdata: false };
      break;
    }

    const inner = xml.slice(lt + 1, gt).trim();
    pos = gt + 1;

    if (!inner) continue;

    // Closing tag </name>
    if (inner.startsWith('/')) {
      const rawName = inner.slice(1).trim().split(/\s+/)[0] ?? '';
      if (!rawName) continue;
      const { prefix, localName } = splitQName(rawName);
      const currentNs = nsStack[nsStack.length - 1]!;
      const uri = prefix ? (currentNs.get(prefix) ?? '') : (currentNs.get('') ?? '');

      // Tolerantly unwind mismatched inner tags if present
      let matchIdx = -1;
      for (let k = openElements.length - 1; k >= 0; k--) {
        if (openElements[k]!.rawName === rawName || openElements[k]!.localName === localName) {
          matchIdx = k;
          break;
        }
      }
      if (matchIdx >= 0) {
        while (openElements.length > matchIdx) {
          const popped = openElements.pop()!;
          if (nsStack.length > 1) nsStack.pop();
          yield {
            type: 'endElement',
            rawName: popped.rawName,
            prefix: popped.prefix,
            localName: popped.localName,
            uri: popped.uri,
          };
        }
      } else {
        yield { type: 'endElement', rawName, prefix, localName, uri };
      }
      continue;
    }

    // Opening or self-closing tag
    // Check if trailing `/` outside quotes indicates self-closing
    let selfClosing = false;
    let body = inner;
    if (body.endsWith('/')) {
      selfClosing = true;
      body = body.slice(0, -1).trimEnd();
    }

    const nameMatch = /^([^\s/>]+)([\s\S]*)$/.exec(body);
    if (!nameMatch) continue;
    const rawName = nameMatch[1]!;
    const attrSlice = nameMatch[2] ?? '';

    const rawAttrs = parseTagAttributes(attrSlice);
    const parentNs = nsStack[nsStack.length - 1]!;
    const childNs = new Map<string, string>(parentNs);

    for (const a of rawAttrs) {
      if (a.rawName === 'xmlns') {
        childNs.set('', a.value.trim());
      } else if (a.rawName.startsWith('xmlns:')) {
        const nsPrefix = a.rawName.slice(6);
        if (nsPrefix) {
          childNs.set(nsPrefix, a.value.trim());
        }
      }
    }

    const { prefix, localName } = splitQName(rawName);
    const elementUri = prefix ? (childNs.get(prefix) ?? '') : (childNs.get('') ?? '');

    const resolvedAttrs: XmlAttribute[] = [];
    for (const a of rawAttrs) {
      if (a.rawName === 'xmlns' || a.rawName.startsWith('xmlns:')) {
        continue;
      }
      const attrParts = splitQName(a.rawName);
      // Per XML Namespaces spec, unprefixed attributes do NOT inherit the default namespace.
      const attrUri = attrParts.prefix ? (childNs.get(attrParts.prefix) ?? '') : '';
      resolvedAttrs.push({
        rawName: a.rawName,
        prefix: attrParts.prefix,
        localName: attrParts.localName,
        uri: attrUri,
        value: a.value,
      });
    }

    yield {
      type: 'startElement',
      rawName,
      prefix,
      localName,
      uri: elementUri,
      attributes: resolvedAttrs,
    };

    if (selfClosing) {
      yield {
        type: 'endElement',
        rawName,
        prefix,
        localName,
        uri: elementUri,
      };
    } else {
      nsStack.push(childNs);
      openElements.push({ rawName, prefix, localName, uri: elementUri });
    }
  }

  // Close any unclosed elements at EOF so truncated feeds still yield parsed items
  while (openElements.length > 0) {
    const popped = openElements.pop()!;
    if (nsStack.length > 1) nsStack.pop();
    yield {
      type: 'endElement',
      rawName: popped.rawName,
      prefix: popped.prefix,
      localName: popped.localName,
      uri: popped.uri,
    };
  }
}

export function getAttr(
  attrs: readonly XmlAttribute[],
  localName: string,
  uri?: string,
): string | undefined {
  for (const attr of attrs) {
    if (attr.localName === localName && (uri === undefined || attr.uri === uri)) {
      return attr.value;
    }
  }
  const lower = localName.toLowerCase();
  for (const attr of attrs) {
    if (attr.localName.toLowerCase() === lower && (uri === undefined || attr.uri === uri)) {
      return attr.value;
    }
  }
  return undefined;
}
