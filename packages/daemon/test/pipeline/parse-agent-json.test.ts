import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  escapeControlCharsInJsonStrings,
  looksLikeJsonStringEnd,
  parseAgentResultJson,
  repairJsonStringContents,
  tryExtractTitleScriptObject,
} from '../../src/pipeline/parse-agent-json.ts';

describe('parseAgentResultJson', () => {
  test('accepts strict JSON', () => {
    const r = parseAgentResultJson('{"title":"t","script":"hello world"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(false);
      expect(r.value).toEqual({ title: 't', script: 'hello world' });
    }
  });

  test('repairs raw newlines inside string fields (writer draft failure mode)', () => {
    // Agent wrote multi-line prose without \\n escapes — Bun/JSON.parse would throw
    // "Unterminated string". This is the exact 7878ff84 failure class.
    const raw = `{
  "title": "5 mô hình",
  "script": "Đoạn một.

Đoạn hai với nhiều từ để đủ dài cho draft."
}
`;
    expect(() => JSON.parse(raw)).toThrow();
    const r = parseAgentResultJson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      const v = r.value as { title: string; script: string };
      expect(v.title).toBe('5 mô hình');
      expect(v.script).toContain('Đoạn một.');
      expect(v.script).toContain('Đoạn hai');
      expect(v.script).toContain('\n');
    }
  });

  test('repairs unescaped dialogue quotes inside script (Claude 7d626c50 failure mode)', () => {
    // Exact class: prose uses "..." without \\" and JSON.parse fails mid-string.
    const raw = `{
  "title": "LƯƠNG 25 TRIỆU VẪN KHÔNG CÓ TIỀN",
  "script": "Mỗi lần tăng lương, Minh thấy nhẹ người, kiểu cảm giác \\"cuối cùng cũng dễ thở hơn\\". Nhưng cái dễ thở đó chưa bao giờ kéo dài."
}
`.replace('\\"cuối cùng cũng dễ thở hơn\\"', '"cuối cùng cũng dễ thở hơn"');
    // After replace the inner quotes are raw unescaped:
    expect(raw).toContain('cảm giác "cuối cùng');
    expect(() => JSON.parse(raw)).toThrow();

    const r = parseAgentResultJson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      const v = r.value as { title: string; script: string };
      expect(v.title).toContain('LƯƠNG 25');
      expect(v.script).toContain('cuối cùng cũng dễ thở hơn');
      expect(v.script).toContain('kéo dài');
    }
  });

  test('repairs quote + comma inside prose without treating it as field end', () => {
    const raw =
      '{"title":"t","script":"He said "hi", then walked away with more words here."}';
    // Make inner quotes raw:
    const broken = raw.replace('"hi"', '"hi"');
    // Actually construct explicitly:
    const agent = '{"title":"t","script":"He said "hi", then walked away with more words here."}';
    expect(() => JSON.parse(agent)).toThrow();
    const r = parseAgentResultJson(agent);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = r.value as { script: string };
      expect(v.script).toContain('He said "hi", then walked');
    }
  });

  test('repairs real on-disk Claude orphan draft when present', () => {
    const path = join(
      import.meta.dir,
      '../../../../writer-room-data/workspaces/pipeline/'
        + '7d626c50-a84f-45d6-8a9f-63de4ba570c8/'
        + '1c24954b-a84f-4b10-ad67-ec030ba9730e/attempts/1/writer-draft/out/result.json',
    );
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      // Data dir not present in CI — skip.
      return;
    }
    expect(() => JSON.parse(raw)).toThrow();
    const r = parseAgentResultJson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = r.value as { title: string; script: string };
      expect(v.title).toContain('LƯƠNG 25');
      expect(v.script.split(/\s+/).length).toBeGreaterThan(500);
      expect(v.script).toContain('cuối cùng cũng dễ thở hơn');
    }
  });

  test('strips trailing NDJSON after object', () => {
    const raw =
      '{"title":"t","script":"a b c d e f g h i j k l m n o p"}\n'
      + '{"type":"usage","usage":{"input_tokens":1}}\n'
      + '{"type":"end","stopReason":"end_turn"}\n';
    const r = parseAgentResultJson(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as { title: string }).title).toBe('t');
    }
  });

  test('rejects empty / non-object garbage', () => {
    expect(parseAgentResultJson('').ok).toBe(false);
    expect(parseAgentResultJson('not json at all').ok).toBe(false);
  });
});

describe('looksLikeJsonStringEnd', () => {
  test('ends before next key after comma', () => {
    const s = '"foo", "script":';
    // quote after foo is index 4
    expect(looksLikeJsonStringEnd(s, 4)).toBe(true);
  });

  test('does not end when comma continues prose', () => {
    const s = '"hi", then more';
    expect(looksLikeJsonStringEnd(s, 3)).toBe(false);
  });
});

describe('repairJsonStringContents', () => {
  test('escapes prose quotes and keeps structure', () => {
    const raw = '{"title":"t","script":"feel "soft" now"}';
    const fixed = repairJsonStringContents(raw);
    expect(JSON.parse(fixed)).toEqual({ title: 't', script: 'feel "soft" now' });
  });
});

describe('escapeControlCharsInJsonStrings', () => {
  test('does not touch structural newlines outside strings', () => {
    const s = '{\n  "a": 1\n}';
    expect(JSON.parse(escapeControlCharsInJsonStrings(s))).toEqual({ a: 1 });
  });
});

describe('tryExtractTitleScriptObject', () => {
  test('salvages script with many raw quotes', () => {
    const raw = `{
  "title": "Hello",
  "script": "A "quoted" line and another "one" at the end."
}`;
    const pair = tryExtractTitleScriptObject(raw);
    expect(pair).not.toBeNull();
    expect(pair!.title).toBe('Hello');
    expect(pair!.script).toContain('"quoted"');
    expect(pair!.script).toContain('"one"');
  });
});
