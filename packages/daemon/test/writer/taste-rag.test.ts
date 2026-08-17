import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  buildStructuredSituationQuery,
  excerptFromDecisionMarkdown,
  formatStructuredQuery,
  parseQmdQueryJson,
  parseQmdSearchText,
  qmdUriToStorePath,
  rankDecisionHits,
  retrieveTastePrecedents,
  structuredQueryFromDecision,
} from '../../src/writer/taste-rag.ts';
import { APP_ROOT } from '../../src/paths.ts';

describe('buildStructuredSituationQuery', () => {
  test('emits intent/lex/vec/hyde lines with no blank lines', () => {
    const q = buildStructuredSituationQuery({
      title: 'Người Giàu Âm Thầm Làm Gì Mỗi Sáng',
      brief: 'Viết script bám title',
    });
    const lines = q.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]!.startsWith('intent:')).toBe(true);
    expect(lines[1]!.startsWith('lex:')).toBe(true);
    expect(lines[1]).toContain('decision_case');
    expect(lines[2]!.startsWith('vec:')).toBe(true);
    expect(lines[3]!.startsWith('hyde:')).toBe(true);
    expect(lines.every((l) => l.trim().length > 0)).toBe(true);
  });
});

describe('structuredQueryFromDecision (LLM key path)', () => {
  test('uses LLM query fields when complete', () => {
    const q = structuredQueryFromDecision({
      decisionType: 'OPENING',
      situation: 'Contrast office vs side hustle first',
      query: {
        intent: 'Find editorial opening precedents not SME topic dumps',
        lex: 'hook_strategy contrast',
        vec: 'Young audience comparing salary job to small business models',
        hyde: 'A decision case opens with contrast then lists models with transfer limits',
      },
    });
    expect(q).toContain('intent: Find editorial opening');
    expect(q.toLowerCase()).toContain('decision_case');
    expect(q.toLowerCase()).toContain('opening');
    expect(q).toContain('lex:');
    expect(formatStructuredQuery({
      intent: 'a',
      lex: 'b',
      vec: 'c',
      hyde: 'd',
    }).split('\n')).toHaveLength(4);
  });
});

describe('parseQmdQueryJson', () => {
  test('parses JSON array even with progress noise', () => {
    const stdout = `Warning: embeddings pending
Structured search: 3 queries
[
  {
    "docid": "#abc",
    "score": 1,
    "file": "qmd://hieutv/decisions/foo/dc_1.md",
    "title": "Case A",
    "snippet": "memory_type: decision_case"
  },
  {
    "docid": "#def",
    "score": 0.5,
    "file": "qmd://hieutv/sources/bar.md",
    "title": "Source dump"
  }
]
`;
    const hits = parseQmdQueryJson(stdout);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.file).toContain('/decisions/');
    const ranked = rankDecisionHits(hits);
    expect(ranked[0]!.file).toContain('/decisions/');
  });
});

describe('parseQmdSearchText (legacy)', () => {
  test('extracts path, score, title from human blocks', () => {
    const stdout = `
qmd://hieutv/decisions/foo/dc_abc.md:7 #db6874
Title: Cho người nghe nhận ra mình
Score:  85%
`;
    const hits = parseQmdSearchText(stdout);
    expect(hits[0]!.path).toContain('qmd://hieutv/decisions/foo/dc_abc.md');
    expect(hits[0]!.score).toBeCloseTo(0.85);
  });
});

describe('qmdUriToStorePath', () => {
  test('maps collection URI under store root', () => {
    const p = qmdUriToStorePath(
      'qmd://hieutv/decisions/x/dc_1.md',
      '/tmp/store',
      'hieutv',
    );
    expect(p).toBe(join('/tmp/store', 'decisions/x/dc_1.md'));
  });
});

describe('excerptFromDecisionMarkdown', () => {
  test('pulls title + key sections from full file', () => {
    const md = `---
decision_type: hook_strategy
memory_type: decision_case
confidence: 0.9
---

# Mở bằng case study

## Editorial situation

Cần mở bài có neo.

## Observed choice

\`OBSERVED\`: Kể một case có số.

## Transfer conditions

Dùng khi audience trẻ.

## Source evidence

quote dài.
`;
    const e = excerptFromDecisionMarkdown(md);
    expect(e.title).toBe('Mở bằng case study');
    expect(e.decisionType).toBe('hook_strategy');
    expect(e.memoryType).toBe('decision_case');
    expect(e.excerpt).toContain('Editorial situation');
    expect(e.excerpt).toContain('Observed choice');
  });
});

describe('retrieveTastePrecedents filesystem path', () => {
  test('finds decision cases from local store without qmd', async () => {
    process.env.WRITER_TASTE_RAG_SKIP_QMD = '1';
    try {
      const storeRoot = join(APP_ROOT, 'hieutv-taste-rag', 'store');
      const result = await retrieveTastePrecedents(
        'mở bài hook case study số liệu tài chính',
        {
          limit: 3,
          storeRoot,
          collection: 'hieutv',
          title: 'Người trẻ quyết định khoản chi lớn',
        },
      );
      expect(result.mode).toBe('filesystem');
      expect(result.query).toContain('intent:');
      expect(Array.isArray(result.precedents)).toBe(true);
      if (result.precedents.length > 0) {
        expect(result.precedents[0]!.title).toBeTruthy();
        expect(result.precedents[0]!.source).toBe('filesystem');
        expect(result.precedents[0]!.excerpt.length).toBeGreaterThan(20);
      }
    } finally {
      delete process.env.WRITER_TASTE_RAG_SKIP_QMD;
    }
  });
});
