/* Chapter metadata extraction.
 *
 * A single .m4b or .mp3 usually carries its own chapter marks. Reading them lets
 * one file become one audiobook with a real chapter list, instead of a single
 * opaque block of audio. Three sources are supported, in order of how common
 * they are in the wild:
 *
 *   1. MP4 "chpl" (Nero style) - a flat list in moov/udta
 *   2. MP4 QuickTime chapter track - a text track referenced by the audio track
 *   3. ID3v2 "CHAP" frames - what mp3 audiobooks use
 *
 * Everything is read with ranged slices, never by pulling the whole file into
 * memory, because these files run to hundreds of megabytes.
 */

const ChapterMeta = (() => {

  function str4(dv, o) {
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  }

  async function readRange(file, offset, length) {
    const end = Math.min(file.size, offset + length);
    if (offset >= end) return new DataView(new ArrayBuffer(0));
    return new DataView(await file.slice(offset, end).arrayBuffer());
  }

  // ---------- MP4 box walking ----------

  function boxes(dv, start, end) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const type = str4(dv, o + 4);
      let header = 8;
      if (size === 1) {
        if (o + 16 > end) break;
        size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12);
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header || o + size > end) break;
      out.push({ type, body: o + header, bodyEnd: o + size });
      o += size;
    }
    return out;
  }

  function findBox(dv, start, end, type) {
    return boxes(dv, start, end).find((b) => b.type === type) || null;
  }

  function findPath(dv, start, end, path) {
    let cur = { body: start, bodyEnd: end };
    for (const type of path) {
      const next = findBox(dv, cur.body, cur.bodyEnd, type);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  // Locate a top-level box without reading the file into memory.
  async function findTopLevel(file, type) {
    let o = 0;
    while (o + 8 <= file.size) {
      const dv = await readRange(file, o, 16);
      if (dv.byteLength < 8) break;
      let size = dv.getUint32(0);
      const t = str4(dv, 4);
      let header = 8;
      if (size === 1) {
        if (dv.byteLength < 16) break;
        size = dv.getUint32(8) * 4294967296 + dv.getUint32(12);
        header = 16;
      } else if (size === 0) {
        size = file.size - o;
      }
      if (size < header) break;
      if (t === type) return { offset: o, size, header };
      o += size;
    }
    return null;
  }

  // ---------- 1. Nero chpl ----------

  function parseChpl(dv, box) {
    let o = box.body;
    if (o + 5 > box.bodyEnd) return [];
    const version = dv.getUint8(o);
    o += 4; // version + flags
    if (version) o += 4;
    if (o >= box.bodyEnd) return [];
    const count = dv.getUint8(o); o += 1;

    const out = [];
    for (let i = 0; i < count && o + 9 <= box.bodyEnd; i++) {
      const start = (dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4)) / 1e7; // 100ns units
      o += 8;
      const len = dv.getUint8(o); o += 1;
      if (o + len > box.bodyEnd) break;
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset + o, len);
      out.push({ name: decodeText(bytes), start });
      o += len;
    }
    return out;
  }

  function decodeText(bytes) {
    try {
      if (bytes.length >= 2 && ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF))) {
        const le = bytes[0] === 0xFF;
        return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(2)).replace(/\0+$/, '');
      }
      return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '');
    } catch (e) {
      return '';
    }
  }

  // ---------- 2. QuickTime chapter text track ----------

  function fullBoxEntries(dv, box, entrySize, fields) {
    // Skips version+flags, reads a 4-byte count, then `fields` per entry.
    let o = box.body + 4;
    if (o + 4 > box.bodyEnd) return [];
    const count = dv.getUint32(o); o += 4;
    const out = [];
    for (let i = 0; i < count && o + entrySize <= box.bodyEnd; i++) {
      const row = {};
      fields.forEach((f, idx) => { row[f] = dv.getUint32(o + idx * 4); });
      out.push(row);
      o += entrySize;
    }
    return out;
  }

  function trackInfo(dv, trak) {
    const tkhd = findBox(dv, trak.body, trak.bodyEnd, 'tkhd');
    let trackId = 0;
    if (tkhd) {
      const version = dv.getUint8(tkhd.body);
      trackId = dv.getUint32(tkhd.body + (version === 1 ? 4 + 8 + 8 : 4 + 4 + 4));
    }

    const mdia = findBox(dv, trak.body, trak.bodyEnd, 'mdia');
    let timescale = 0, handler = '';
    if (mdia) {
      const mdhd = findBox(dv, mdia.body, mdia.bodyEnd, 'mdhd');
      if (mdhd) {
        const version = dv.getUint8(mdhd.body);
        timescale = dv.getUint32(mdhd.body + (version === 1 ? 4 + 8 + 8 : 4 + 4 + 4));
      }
      const hdlr = findBox(dv, mdia.body, mdia.bodyEnd, 'hdlr');
      if (hdlr) handler = str4(dv, hdlr.body + 8);
    }

    // Chapter reference: tref/chap lists the chapter track's id.
    const chapRefs = [];
    const tref = findBox(dv, trak.body, trak.bodyEnd, 'tref');
    if (tref) {
      const chap = findBox(dv, tref.body, tref.bodyEnd, 'chap');
      if (chap) {
        for (let o = chap.body; o + 4 <= chap.bodyEnd; o += 4) chapRefs.push(dv.getUint32(o));
      }
    }

    return { trackId, timescale, handler, chapRefs, mdia };
  }

  function sampleTable(dv, mdia) {
    const stbl = findPath(dv, mdia.body, mdia.bodyEnd, ['minf', 'stbl']);
    if (!stbl) return null;

    const sttsBox = findBox(dv, stbl.body, stbl.bodyEnd, 'stts');
    const stszBox = findBox(dv, stbl.body, stbl.bodyEnd, 'stsz');
    const stscBox = findBox(dv, stbl.body, stbl.bodyEnd, 'stsc');
    const stcoBox = findBox(dv, stbl.body, stbl.bodyEnd, 'stco');
    const co64Box = findBox(dv, stbl.body, stbl.bodyEnd, 'co64');
    if (!sttsBox || !stszBox || !stscBox || (!stcoBox && !co64Box)) return null;

    const stts = fullBoxEntries(dv, sttsBox, 8, ['count', 'delta']);
    const stsc = fullBoxEntries(dv, stscBox, 12, ['firstChunk', 'samplesPerChunk', 'descIndex']);

    // stsz has an extra uniform-size field ahead of the count.
    let o = stszBox.body + 4;
    const uniform = dv.getUint32(o); o += 4;
    const sampleCount = dv.getUint32(o); o += 4;
    const sizes = [];
    for (let i = 0; i < sampleCount; i++) {
      if (uniform) sizes.push(uniform);
      else { if (o + 4 > stszBox.bodyEnd) break; sizes.push(dv.getUint32(o)); o += 4; }
    }

    const chunkOffsets = [];
    if (stcoBox) {
      let p = stcoBox.body + 4;
      const n = dv.getUint32(p); p += 4;
      for (let i = 0; i < n && p + 4 <= stcoBox.bodyEnd; i++) { chunkOffsets.push(dv.getUint32(p)); p += 4; }
    } else {
      let p = co64Box.body + 4;
      const n = dv.getUint32(p); p += 4;
      for (let i = 0; i < n && p + 8 <= co64Box.bodyEnd; i++) {
        chunkOffsets.push(dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4));
        p += 8;
      }
    }

    // Walk chunks, handing out samples according to stsc.
    const samples = [];
    let si = 0;
    for (let c = 0; c < chunkOffsets.length && si < sizes.length; c++) {
      let spc = 1;
      for (let e = stsc.length - 1; e >= 0; e--) {
        if (stsc[e].firstChunk <= c + 1) { spc = stsc[e].samplesPerChunk; break; }
      }
      let off = chunkOffsets[c];
      for (let s = 0; s < spc && si < sizes.length; s++) {
        samples.push({ offset: off, size: sizes[si] });
        off += sizes[si];
        si++;
      }
    }

    const durations = [];
    for (const e of stts) for (let i = 0; i < e.count; i++) durations.push(e.delta);

    return { samples, durations };
  }

  async function parseQtChapters(file, dv, moovBody, moovEnd) {
    const traks = boxes(dv, moovBody, moovEnd).filter((b) => b.type === 'trak');
    if (!traks.length) return [];

    const infos = traks.map((t) => trackInfo(dv, t));
    const audio = infos.find((i) => i.handler === 'soun' && i.chapRefs.length);
    if (!audio) return [];

    const chapTrack = infos.find((i) => audio.chapRefs.includes(i.trackId) && i.mdia);
    if (!chapTrack || !chapTrack.timescale) return [];

    const table = sampleTable(dv, chapTrack.mdia);
    if (!table || !table.samples.length) return [];

    const out = [];
    let elapsed = 0;
    for (let i = 0; i < table.samples.length; i++) {
      const { offset, size } = table.samples[i];
      const start = elapsed / chapTrack.timescale;
      elapsed += table.durations[i] || 0;
      if (size < 2 || size > 4096) { out.push({ name: '', start }); continue; }
      const sdv = await readRange(file, offset, size);
      if (sdv.byteLength < 2) { out.push({ name: '', start }); continue; }
      const len = Math.min(sdv.getUint16(0), sdv.byteLength - 2);
      const bytes = new Uint8Array(sdv.buffer, sdv.byteOffset + 2, len);
      out.push({ name: decodeText(bytes), start });
    }
    return out;
  }

  // ---------- 3. ID3v2 CHAP ----------

  function syncsafe(dv, o) {
    return (dv.getUint8(o) << 21) | (dv.getUint8(o + 1) << 14) | (dv.getUint8(o + 2) << 7) | dv.getUint8(o + 3);
  }

  function readId3Text(bytes) {
    if (!bytes.length) return '';
    const enc = bytes[0];
    const body = bytes.subarray(1);
    try {
      if (enc === 1) return new TextDecoder('utf-16').decode(body).replace(/\0+$/, '');
      if (enc === 2) return new TextDecoder('utf-16be').decode(body).replace(/\0+$/, '');
      if (enc === 3) return new TextDecoder('utf-8').decode(body).replace(/\0+$/, '');
      return new TextDecoder('iso-8859-1').decode(body).replace(/\0+$/, '');
    } catch (e) {
      return '';
    }
  }

  function parseId3Frames(dv, start, end, major, collect) {
    let o = start;
    while (o + 10 <= end) {
      const id = str4(dv, o);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = major >= 4 ? syncsafe(dv, o + 4) : dv.getUint32(o + 4);
      o += 10;
      if (size <= 0 || o + size > end) break;
      collect(id, o, o + size);
      o += size;
    }
  }

  async function parseId3Chapters(file) {
    const head = await readRange(file, 0, 10);
    if (head.byteLength < 10) return [];
    if (String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2)) !== 'ID3') return [];
    const major = head.getUint8(3);
    const tagSize = syncsafe(head, 6);
    if (tagSize <= 0 || tagSize > 40 * 1024 * 1024) return [];

    const dv = await readRange(file, 10, tagSize);
    const out = [];

    parseId3Frames(dv, 0, dv.byteLength, major, (id, s, e) => {
      if (id !== 'CHAP') return;
      // elementID, then start/end ms, start/end byte offsets, then subframes
      let o = s;
      while (o < e && dv.getUint8(o) !== 0) o++;
      o++; // null terminator
      if (o + 16 > e) return;
      const startMs = dv.getUint32(o);
      const endMs = dv.getUint32(o + 4);
      o += 16;

      let name = '';
      parseId3Frames(dv, o, e, major, (sid, ss, se) => {
        if (sid === 'TIT2' && !name) {
          name = readId3Text(new Uint8Array(dv.buffer, dv.byteOffset + ss, se - ss));
        }
      });

      out.push({
        name,
        start: startMs / 1000,
        end: endMs && endMs !== 0xFFFFFFFF ? endMs / 1000 : undefined,
      });
    });

    return out;
  }

  // ---------- public ----------

  /** Returns [{ name, start }] sorted by start, or [] if the file has no chapters. */
  async function extract(file) {
    try {
      const id3 = await parseId3Chapters(file);
      if (id3.length > 1) return tidy(id3);
    } catch (e) { /* fall through */ }

    try {
      const moov = await findTopLevel(file, 'moov');
      if (moov && moov.size < 128 * 1024 * 1024) {
        const dv = await readRange(file, moov.offset, moov.size);
        const body = moov.header;
        const end = dv.byteLength;

        const udta = findBox(dv, body, end, 'udta');
        if (udta) {
          const chpl = findBox(dv, udta.body, udta.bodyEnd, 'chpl');
          if (chpl) {
            const list = parseChpl(dv, chpl);
            if (list.length > 1) return tidy(list);
          }
        }

        const qt = await parseQtChapters(file, dv, body, end);
        if (qt.length > 1) return tidy(qt);
      }
    } catch (e) { /* fall through */ }

    return [];
  }

  function tidy(list) {
    const cleaned = list
      .filter((c) => isFinite(c.start) && c.start >= 0)
      .sort((a, b) => a.start - b.start);
    // Drop duplicate start points, which some taggers emit.
    const out = [];
    for (const c of cleaned) {
      if (out.length && Math.abs(out[out.length - 1].start - c.start) < 0.05) continue;
      out.push(c);
    }
    return out;
  }

  return { extract };
})();
