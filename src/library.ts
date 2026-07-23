import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunState, SeoArtifact, WriterDraftArtifact } from './domain.ts';
import { APP_DATA_ROOT, type RunStore } from './store.ts';
import { sha256 } from './supervisor.ts';

export interface ArticleSummary {
  id: string;
  runId: string;
  title: string;
  status: 'active' | 'archived';
  acceptedRound: number;
  acceptedBy: 'target' | 'human';
  finalScore: number | null;
  seoVerdict: string | null;
  createdAt: string;
  updatedAt: string;
  excerpt: string;
}

export interface ArticleVersion {
  id: string;
  articleId: string;
  versionNo: number;
  runId: string;
  acceptedRound: number;
  markdown: string;
  markdownSha256: string;
  draftArtifactRelpath: string;
  seoArtifactRelpath: string;
  createdAt: string;
}

function searchText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, (char) => char === 'đ' ? 'd' : 'D');
}

function ftsQuery(value: string): string {
  return searchText(value).split(/\s+/).map((token) => token.replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean).slice(0, 12).map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
}

export class ArticleLibrary {
  readonly path: string;
  private db: Database | null = null;
  private fts = true;

  constructor(path = process.env.WRITER_ROOM_LIBRARY_PATH || join(APP_DATA_ROOT, 'library.sqlite')) {
    this.path = path;
  }

  init(): void {
    if (this.db) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','archived')),
        current_version_id TEXT NOT NULL,
        accepted_round INTEGER NOT NULL,
        accepted_by TEXT NOT NULL CHECK (accepted_by IN ('target','human')),
        final_score REAL,
        seo_verdict TEXT,
        source_run_relpath TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS article_versions (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
        version_no INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        accepted_round INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        markdown_sha256 TEXT NOT NULL,
        draft_artifact_relpath TEXT NOT NULL,
        seo_artifact_relpath TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(article_id, version_no),
        UNIQUE(run_id, accepted_round)
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at, checksum)
      VALUES (1, datetime('now'), 'writer-room-library-v1');
    `);
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(article_id UNINDEXED, title, markdown, tokenize='unicode61 remove_diacritics 2');`);
    } catch {
      this.fts = false;
    }
    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private database(): Database {
    this.init();
    return this.db!;
  }

  publish(state: RunState, draft: WriterDraftArtifact, seo: SeoArtifact): { articleId: string; versionId: string; markdownSha256: string } {
    if (state.stage !== 'complete' || !state.acceptedRound || !state.acceptedBy) throw new Error('only a complete accepted run can be published');
    const db = this.database();
    const markdownSha256 = sha256(draft.draftMarkdown);
    const existing = db.query(`SELECT a.id article_id, a.current_version_id version_id, v.markdown_sha256 hash
      FROM articles a JOIN article_versions v ON v.id=a.current_version_id WHERE a.run_id=?`).get(state.id) as { article_id: string; version_id: string; hash: string } | null;
    if (existing) {
      if (existing.hash !== markdownSha256) throw new Error(`library conflict for ${state.id}: accepted artifact hash changed`);
      return { articleId: existing.article_id, versionId: existing.version_id, markdownSha256 };
    }
    const articleId = `article-${sha256(state.id).slice(0, 20)}`;
    const versionId = `version-${sha256(`${state.id}:${state.acceptedRound}:${markdownSha256}`).slice(0, 20)}`;
    const now = new Date().toISOString();
    const score = state.scores.find((item) => item.round === state.acceptedRound)?.score ?? null;
    const publish = db.transaction(() => {
      db.query(`INSERT INTO articles(id,run_id,title,status,current_version_id,accepted_round,accepted_by,final_score,seo_verdict,source_run_relpath,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(articleId, state.id, state.config.title, 'active', versionId, state.acceptedRound!, state.acceptedBy!, score, seo.verdict, `runs/${state.id}`, now, now);
      db.query(`INSERT INTO article_versions(id,article_id,version_no,run_id,accepted_round,markdown,markdown_sha256,draft_artifact_relpath,seo_artifact_relpath,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(versionId, articleId, 1, state.id, state.acceptedRound!, draft.draftMarkdown, markdownSha256, `artifacts/draft-r${state.acceptedRound}.json`, 'artifacts/seo.json', now);
      if (this.fts) db.query('INSERT INTO article_fts(article_id,title,markdown) VALUES (?,?,?)').run(articleId, searchText(state.config.title), searchText(draft.draftMarkdown));
    });
    publish();
    return { articleId, versionId, markdownSha256 };
  }

  list(query = '', includeArchived = false): ArticleSummary[] {
    const db = this.database();
    const statusSql = includeArchived ? '' : `WHERE a.status='active'`;
    let rows: Array<Record<string, unknown>>;
    const match = ftsQuery(query);
    if (match && this.fts) {
      const condition = includeArchived ? 'WHERE article_fts MATCH ?' : `WHERE article_fts MATCH ? AND a.status='active'`;
      rows = db.query(`SELECT a.*, substr(v.markdown,1,240) excerpt FROM article_fts
        JOIN articles a ON a.id=article_fts.article_id JOIN article_versions v ON v.id=a.current_version_id
        ${condition} ORDER BY a.updated_at DESC LIMIT 200`).all(match) as Array<Record<string, unknown>>;
    } else {
      if (query) {
        rows = db.query(`SELECT a.*, substr(v.markdown,1,240) excerpt FROM articles a JOIN article_versions v ON v.id=a.current_version_id
          WHERE a.title LIKE ? ${includeArchived ? '' : `AND a.status='active'`} ORDER BY a.updated_at DESC LIMIT 200`).all(`%${query}%`) as Array<Record<string, unknown>>;
      } else {
        rows = db.query(`SELECT a.*, substr(v.markdown,1,240) excerpt FROM articles a JOIN article_versions v ON v.id=a.current_version_id
          ${statusSql} ORDER BY a.updated_at DESC LIMIT 200`).all() as Array<Record<string, unknown>>;
      }
    }
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id), title: String(row.title), status: row.status as 'active' | 'archived',
      acceptedRound: Number(row.accepted_round), acceptedBy: row.accepted_by as 'target' | 'human',
      finalScore: row.final_score === null ? null : Number(row.final_score), seoVerdict: row.seo_verdict === null ? null : String(row.seo_verdict),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), excerpt: String(row.excerpt ?? ''),
    }));
  }

  get(articleId: string): { article: ArticleSummary; versions: ArticleVersion[] } {
    const db = this.database();
    const article = this.list('', true).find((item) => item.id === articleId);
    if (!article) throw new Error(`article not found: ${articleId}`);
    const rows = db.query('SELECT * FROM article_versions WHERE article_id=? ORDER BY version_no DESC').all(articleId) as Array<Record<string, unknown>>;
    return {
      article,
      versions: rows.map((row) => ({
        id: String(row.id), articleId: String(row.article_id), versionNo: Number(row.version_no), runId: String(row.run_id),
        acceptedRound: Number(row.accepted_round), markdown: String(row.markdown), markdownSha256: String(row.markdown_sha256),
        draftArtifactRelpath: String(row.draft_artifact_relpath), seoArtifactRelpath: String(row.seo_artifact_relpath), createdAt: String(row.created_at),
      })),
    };
  }

  setArchived(articleId: string, archived: boolean): void {
    const db = this.database();
    const now = new Date().toISOString();
    const result = db.query(`UPDATE articles SET status=?, archived_at=?, updated_at=? WHERE id=?`).run(archived ? 'archived' : 'active', archived ? now : null, now, articleId);
    if (result.changes !== 1) throw new Error(`article not found: ${articleId}`);
  }

  exportArticle(articleId: string): { path: string; filename: string } {
    const value = this.get(articleId);
    const current = value.versions[0];
    if (!current) throw new Error(`article has no accepted version: ${articleId}`);
    const safeTitle = searchText(value.article.title).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'article';
    const filename = `${safeTitle}-v${current.versionNo}.md`;
    const directory = join(dirname(this.path), 'exports');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, filename);
    writeFileSync(path, current.markdown, { flag: 'w' });
    return { path, filename };
  }

  backup(): { path: string; filename: string } {
    const db = this.database();
    const directory = join(dirname(this.path), 'backups');
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `writer-room-library-${stamp}.sqlite`;
    const path = join(directory, filename);
    db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return { path, filename };
  }

  async reconcile(store: RunStore): Promise<number> {
    let count = 0;
    for (const state of await store.listStates()) {
      if (state.stage !== 'complete' || !state.acceptedRound) continue;
      const [draft, seo] = await Promise.all([
        store.readArtifact<WriterDraftArtifact>(state.id, `draft-r${state.acceptedRound}.json`),
        store.readArtifact<SeoArtifact>(state.id, 'seo.json'),
      ]);
      if (!draft || !seo) continue;
      const receipt = this.publish(state, draft, seo);
      const existing = await store.readArtifact<Record<string, unknown>>(state.id, 'library-published.json');
      if (existing) {
        if (existing.articleId !== receipt.articleId || existing.versionId !== receipt.versionId || existing.markdownSha256 !== receipt.markdownSha256) {
          throw new Error(`library receipt conflict for ${state.id}`);
        }
      } else {
        await store.writeArtifact(state.id, 'library-published.json', { ...receipt, schemaVersion: 1, publishedAt: new Date().toISOString() });
      }
      count += 1;
    }
    return count;
  }
}
