import { describe, it, expect, vi } from 'vitest';
import {
  encodeFrame, parseExporterMessage, FrameDecoder,
} from '../../src/exporter/protocol.ts';

describe('encodeFrame', () => {
  it('newline-terminates a single JSON frame', () => {
    const frame = encodeFrame({ type: 'FileRemoved', relPath: 'a/b.jsonl' });
    expect(frame).toBe('{"type":"FileRemoved","relPath":"a/b.jsonl"}\n');
  });
});

describe('FrameDecoder', () => {
  it('splits multiple frames delivered in one chunk', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push('{"type":"FileRemoved","relPath":"a"}\n{"type":"FileRemoved","relPath":"b"}\n');
    expect(frames).toEqual([
      { type: 'FileRemoved', relPath: 'a' },
      { type: 'FileRemoved', relPath: 'b' },
    ]);
  });

  it('buffers a frame split across chunks', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push('{"type":"FileRemoved",')).toEqual([]);
    expect(decoder.push('"relPath":"a"}\n')).toEqual([
      { type: 'FileRemoved', relPath: 'a' },
    ]);
  });

  it('skips a malformed line without throwing and keeps decoding', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push('not json\n{"type":"FileRemoved","relPath":"a"}\n');
    expect(frames).toEqual([{ type: 'FileRemoved', relPath: 'a' }]);
  });

  it('does not log the malformed line content, since it may be sensitive transcript data', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const decoder = new FrameDecoder();
      decoder.push('not json but contains a SECRET_API_KEY=abc123\n');
      const logged = warnSpy.mock.calls.map(call => call.join(' ')).join(' ');
      expect(logged).not.toContain('SECRET_API_KEY');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ignores blank lines', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push('\n\n')).toEqual([]);
  });
});

describe('parseExporterMessage', () => {
  it('accepts a well-formed FileList', () => {
    const msg = parseExporterMessage({
      type: 'FileList',
      files: [{ relPath: 'p/s.jsonl', size: 10, mtimeUnixMs: 123 }],
    });
    expect(msg?.type).toBe('FileList');
  });

  it('rejects an unknown type', () => {
    expect(parseExporterMessage({ type: 'Bogus' })).toBeNull();
  });

  it('rejects a FileList whose files field is not an array', () => {
    expect(parseExporterMessage({ type: 'FileList', files: 'nope' })).toBeNull();
  });

  it('rejects AppendLines missing fromLine', () => {
    expect(
      parseExporterMessage({ type: 'AppendLines', relPath: 'a', lines: [] }),
    ).toBeNull();
  });

  it('rejects a non-object', () => {
    expect(parseExporterMessage('nope')).toBeNull();
    expect(parseExporterMessage(null)).toBeNull();
  });
});
