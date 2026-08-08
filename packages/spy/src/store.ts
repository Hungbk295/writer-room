import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { AppError } from './errors.ts';
import type {
  ArtifactRef,
  ChannelRecord,
  FrameSample,
  Operation,
  OperationKind,
  OperationStatus,
  SpyRun,
  TranscriptSegment,
  VideoSnapshot,
  VideoTranscript,
} from './schema.ts';

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  step TEXT NOT NULL DEFAULT 'queued',
  result_ref TEXT,
  error_code TEXT,
  error_message TEXT,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(owner_subject, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_operations_status_created
  ON operations(status, created_at);

CREATE TABLE IF NOT EXISTS spy_runs (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  kind TEXT NOT NULL CHECK(kind IN ('video', 'channel')),
  canonical_source TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL,
  scan_limit INTEGER,
  top_n INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_spy_runs_source
  ON spy_runs(source_identity, created_at);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subscriber_count INTEGER,
  video_count INTEGER,
  total_view_count INTEGER,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_snapshots (
  id TEXT PRIMARY KEY,
  spy_run_id TEXT NOT NULL REFERENCES spy_runs(id),
  source_video_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  channel_title TEXT NOT NULL DEFAULT '',
  rank INTEGER NOT NULL,
  view_count INTEGER NOT NULL,
  like_count INTEGER,
  comment_count INTEGER,
  duration_sec REAL NOT NULL,
  published_at TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  transcript_status TEXT NOT NULL,
  transcript_source TEXT,
  frame_status TEXT NOT NULL,
  thumbnail_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(spy_run_id, source_video_id)
);
CREATE INDEX IF NOT EXISTS idx_video_snapshots_run_rank
  ON video_snapshots(spy_run_id, rank);
CREATE INDEX IF NOT EXISTS idx_video_snapshots_source
  ON video_snapshots(source_video_id);

CREATE TABLE IF NOT EXISTS video_transcripts (
  id TEXT PRIMARY KEY,
  source_video_id TEXT NOT NULL,
  language TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  normalized_text TEXT,
  normalized_at TEXT,
  normalize_model TEXT,
  UNIQUE(source_video_id, language, source)
);
CREATE INDEX IF NOT EXISTS idx_video_transcripts_source
  ON video_transcripts(source_video_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  video_snapshot_id TEXT NOT NULL REFERENCES video_snapshots(id),
  video_transcript_id TEXT,
  segment_index INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL,
  UNIQUE(video_snapshot_id, segment_index)
);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_video
  ON transcript_segments(video_snapshot_id, segment_index);

CREATE TABLE IF NOT EXISTS frame_samples (
  id TEXT PRIMARY KEY,
  video_snapshot_id TEXT NOT NULL REFERENCES video_snapshots(id),
  frame_index INTEGER NOT NULL,
  timestamp_sec REAL NOT NULL,
  dhash TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  UNIQUE(video_snapshot_id, frame_index)
);
CREATE INDEX IF NOT EXISTS idx_frame_samples_video
  ON frame_samples(video_snapshot_id, frame_index);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  spy_run_id TEXT NOT NULL REFERENCES spy_runs(id),
  payload_json TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_scope
  ON metrics(scope, scope_id, computed_at);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  spy_run_id TEXT NOT NULL REFERENCES spy_runs(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  model TEXT,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_scope
  ON profiles(scope, scope_id, kind, computed_at);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  text,
  content='transcript_segments',
  content_rowid='rowid'
);
`;

const MIGRATION_1_TO_2 = `
CREATE TABLE IF NOT EXISTS video_transcripts (
  id TEXT PRIMARY KEY,
  source_video_id TEXT NOT NULL,
  language TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  normalized_text TEXT,
  normalized_at TEXT,
  normalize_model TEXT,
  UNIQUE(source_video_id, language, source)
);
CREATE INDEX IF NOT EXISTS idx_video_transcripts_source
  ON video_transcripts(source_video_id);
CREATE INDEX IF NOT EXISTS idx_video_snapshots_source
  ON video_snapshots(source_video_id);
`;

export type VideoListRow = VideoSnapshot;

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function operationFromRow(row: Row): Operation {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as OperationKind,
    ownerSubject: String(row['owner_subject']),
    status: String(row['status']) as OperationStatus,
    idempotencyKey: nullableString(row['idempotency_key']),
    progress: Number(row['progress']),
    total: Number(row['total']),
    step: String(row['step']),
    resultRef: nullableString(row['result_ref']),
    errorCode: nullableString(row['error_code']),
    errorMessage: nullableString(row['error_message']),
    createdAt: String(row['created_at']),
    startedAt: nullableString(row['started_at']),
    completedAt: nullableString(row['completed_at']),
  };
}

function spyRunFromRow(row: Row): SpyRun {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as SpyRun['kind'],
    canonicalSource: String(row['canonical_source']),
    sourceIdentity: String(row['source_identity']),
    config: parseJson<unknown>(row['config_json']),
    status: String(row['status']) as OperationStatus,
    scanLimit: row['scan_limit'] === null ? null : Number(row['scan_limit']),
    topN: row['top_n'] === null ? null : Number(row['top_n']),
    createdAt: String(row['created_at']),
    completedAt: nullableString(row['completed_at']),
  };
}

function videoSnapshotFromRow(row: Row): VideoSnapshot {
  return {
    id: String(row['id']),
    spyRunId: String(row['spy_run_id']),
    sourceVideoId: String(row['source_video_id']),
    canonicalUrl: String(row['canonical_url']),
    title: String(row['title']),
    channelTitle: String(row['channel_title'] ?? ''),
    rank: Number(row['rank']),
    viewCount: Number(row['view_count']),
    likeCount: row['like_count'] === null ? null : Number(row['like_count']),
    commentCount: row['comment_count'] === null ? null : Number(row['comment_count']),
    durationSec: Number(row['duration_sec']),
    publishedAt: nullableString(row['published_at']),
    tags: parseJson<string[]>(row['tags_json']),
    transcriptStatus: String(row['transcript_status']) as VideoSnapshot['transcriptStatus'],
    transcriptSource: nullableString(row['transcript_source']) as VideoSnapshot['transcriptSource'],
    frameStatus: String(row['frame_status']) as VideoSnapshot['frameStatus'],
    thumbnail: row['thumbnail_json'] ? parseJson<ArtifactRef>(row['thumbnail_json']) : null,
    createdAt: String(row['created_at']),
  };
}

function videoTranscriptFromRow(row: Row): VideoTranscript {
  return {
    id: String(row['id']),
    sourceVideoId: String(row['source_video_id']),
    language: String(row['language']),
    source: String(row['source']) as VideoTranscript['source'],
    contentHash: String(row['content_hash']),
    fetchedAt: String(row['fetched_at']),
    normalizedText: nullableString(row['normalized_text']),
    normalizedAt: nullableString(row['normalized_at']),
    normalizeModel: nullableString(row['normalize_model']),
  };
}

export class SpyStore {
  readonly databasePath: string;
  private readonly database: Database;

  constructor(path: string) {
    this.databasePath = resolve(path);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.database = new Database(this.databasePath);
    this.database.exec(SCHEMA_SQL);
    const row = this.database.prepare('SELECT version FROM schema_version LIMIT 1').get() as Row | undefined;
    if (!row) {
      this.database.prepare('INSERT INTO schema_version(version) VALUES (?)').run(SCHEMA_VERSION);
    } else {
      const version = Number(row['version']);
      if (version === 1) {
        this.database.exec(MIGRATION_1_TO_2);
        try {
          this.database.exec('ALTER TABLE transcript_segments ADD COLUMN video_transcript_id TEXT');
        } catch {
          // already present
        }
        this.database.prepare('UPDATE schema_version SET version=?').run(SCHEMA_VERSION);
      } else if (version !== SCHEMA_VERSION) {
        throw new AppError('internal', `Unsupported database schema ${String(row['version'])}`);
      }
    }
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  reconcileInterruptedOperations(): number {
    const rows = this.database.prepare(
      `SELECT id FROM operations WHERE status IN ('queued', 'running')`,
    ).all() as Row[];
    if (rows.length > 0) {
      const now = nowIso();
      this.database.prepare(
        `UPDATE operations
         SET status='interrupted', error_code='interrupted',
             error_message='daemon restarted', completed_at=?
         WHERE status IN ('queued', 'running')`,
      ).run(now);
      this.database.prepare(
        `UPDATE spy_runs SET status='interrupted', completed_at=?
         WHERE status IN ('queued', 'running')`,
      ).run(now);
    }
    return rows.length;
  }

  createOrGetOperation(input: {
    kind: OperationKind;
    ownerSubject: string;
    idempotencyKey: string;
    request: unknown;
  }): { operation: Operation; created: boolean } {
    const existing = this.database.prepare(
      `SELECT * FROM operations
       WHERE owner_subject=? AND kind=? AND idempotency_key=?`,
    ).get(input.ownerSubject, input.kind, input.idempotencyKey) as Row | undefined;
    if (existing) {
      const operation = operationFromRow(existing);
      if (!['failed', 'cancelled', 'interrupted'].includes(operation.status)) {
        return { operation, created: false };
      }
      // Stale row from a previous failed/cancelled attempt — free the idempotency
      // slot (keeping the row itself, since other tables may reference its id) so a
      // legitimate retry with the same key runs fresh instead of returning the old
      // failure forever. NULL never collides with the UNIQUE(owner,kind,key) index.
      this.database.prepare('UPDATE operations SET idempotency_key=NULL WHERE id=?').run(operation.id);
    }
    const createdAt = nowIso();
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO operations
       (id,kind,owner_subject,status,idempotency_key,request_json,created_at,step)
       VALUES (?,?,?,'queued',?,?,?,'queued')`,
    ).run(id, input.kind, input.ownerSubject, input.idempotencyKey, JSON.stringify(input.request), createdAt);
    return { operation: this.getOperation(id)!, created: true };
  }

  getOperation(id: string): Operation | null {
    const row = this.database.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row | undefined;
    return row ? operationFromRow(row) : null;
  }

  updateOperation(
    id: string,
    patch: Partial<Pick<Operation, 'status' | 'progress' | 'total' | 'step' | 'resultRef' | 'errorCode' | 'errorMessage'>>,
  ): Operation {
    const current = this.getOperation(id);
    if (!current) throw new AppError('not_found', 'Operation không tồn tại');
    const status = patch.status ?? current.status;
    const startedAt = status === 'running' && current.startedAt === null ? nowIso() : current.startedAt;
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
    const completedAt = terminal ? nowIso() : current.completedAt;
    this.database.prepare(
      `UPDATE operations SET status=?,progress=?,total=?,step=?,result_ref=?,
       error_code=?,error_message=?,started_at=?,completed_at=? WHERE id=?`,
    ).run(
      status,
      patch.progress ?? current.progress,
      patch.total ?? current.total,
      patch.step ?? current.step,
      patch.resultRef ?? current.resultRef,
      patch.errorCode ?? current.errorCode,
      patch.errorMessage ?? current.errorMessage,
      startedAt,
      completedAt,
      id,
    );
    return this.getOperation(id)!;
  }

  createSpyRun(input: {
    operationId: string;
    kind: SpyRun['kind'];
    canonicalSource: string;
    sourceIdentity: string;
    config: unknown;
    scanLimit?: number | null;
    topN?: number | null;
  }): SpyRun {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO spy_runs
       (id,operation_id,kind,canonical_source,source_identity,config_json,status,scan_limit,top_n,created_at)
       VALUES (?,?,?,?,?,?,'queued',?,?,?)`,
    ).run(
      id,
      input.operationId,
      input.kind,
      input.canonicalSource,
      input.sourceIdentity,
      JSON.stringify(input.config),
      input.scanLimit ?? null,
      input.topN ?? null,
      nowIso(),
    );
    return this.getSpyRun(id)!;
  }

  getSpyRun(id: string): SpyRun | null {
    const row = this.database.prepare('SELECT * FROM spy_runs WHERE id=?').get(id) as Row | undefined;
    return row ? spyRunFromRow(row) : null;
  }

  getSpyRunByOperation(operationId: string): SpyRun | null {
    const row = this.database.prepare('SELECT * FROM spy_runs WHERE operation_id=?').get(operationId) as Row | undefined;
    return row ? spyRunFromRow(row) : null;
  }

  listSpyRuns(kind?: SpyRun['kind'], limit = 100): SpyRun[] {
    const rows = kind
      ? this.database.prepare('SELECT * FROM spy_runs WHERE kind=? ORDER BY created_at DESC LIMIT ?').all(kind, limit) as Row[]
      : this.database.prepare('SELECT * FROM spy_runs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map(spyRunFromRow);
  }

  updateSpyRun(id: string, patch: { status?: OperationStatus }): SpyRun {
    const current = this.getSpyRun(id);
    if (!current) throw new AppError('not_found', 'Spy run không tồn tại');
    const status = patch.status ?? current.status;
    const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
    this.database.prepare(
      `UPDATE spy_runs SET status=?, completed_at=? WHERE id=?`,
    ).run(status, terminal ? nowIso() : current.completedAt, id);
    return this.getSpyRun(id)!;
  }

  upsertChannel(input: Omit<ChannelRecord, 'id'> & { id?: string }): ChannelRecord {
    const id = input.id ?? randomUUID();
    this.database.prepare(
      `INSERT INTO channels (id, channel_id, title, subscriber_count, video_count, total_view_count, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         title=excluded.title,
         subscriber_count=excluded.subscriber_count,
         video_count=excluded.video_count,
         total_view_count=excluded.total_view_count,
         fetched_at=excluded.fetched_at`,
    ).run(
      id,
      input.channelId,
      input.title,
      input.subscriberCount,
      input.videoCount,
      input.totalViewCount,
      input.fetchedAt,
    );
    return this.getChannel(input.channelId)!;
  }

  getChannel(channelId: string): ChannelRecord | null {
    const row = this.database.prepare('SELECT * FROM channels WHERE channel_id=?').get(channelId) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      channelId: String(row['channel_id']),
      title: String(row['title']),
      subscriberCount: row['subscriber_count'] === null ? null : Number(row['subscriber_count']),
      videoCount: row['video_count'] === null ? null : Number(row['video_count']),
      totalViewCount: row['total_view_count'] === null ? null : Number(row['total_view_count']),
      fetchedAt: String(row['fetched_at']),
    };
  }

  listChannels(limit = 100): ChannelRecord[] {
    const rows = this.database.prepare('SELECT * FROM channels ORDER BY fetched_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map((row) => ({
      id: String(row['id']),
      channelId: String(row['channel_id']),
      title: String(row['title']),
      subscriberCount: row['subscriber_count'] === null ? null : Number(row['subscriber_count']),
      videoCount: row['video_count'] === null ? null : Number(row['video_count']),
      totalViewCount: row['total_view_count'] === null ? null : Number(row['total_view_count']),
      fetchedAt: String(row['fetched_at']),
    }));
  }

  insertVideoSnapshot(snapshot: VideoSnapshot): void {
    this.database.prepare(
      `INSERT INTO video_snapshots
       (id,spy_run_id,source_video_id,canonical_url,title,channel_title,rank,
        view_count,like_count,comment_count,duration_sec,published_at,tags_json,
        transcript_status,transcript_source,frame_status,thumbnail_json,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshot.id,
      snapshot.spyRunId,
      snapshot.sourceVideoId,
      snapshot.canonicalUrl,
      snapshot.title,
      snapshot.channelTitle,
      snapshot.rank,
      snapshot.viewCount,
      snapshot.likeCount,
      snapshot.commentCount,
      snapshot.durationSec,
      snapshot.publishedAt,
      JSON.stringify(snapshot.tags),
      snapshot.transcriptStatus,
      snapshot.transcriptSource,
      snapshot.frameStatus,
      snapshot.thumbnail ? JSON.stringify(snapshot.thumbnail) : null,
      snapshot.createdAt,
    );
  }

  updateVideoSnapshot(
    id: string,
    patch: Partial<Pick<VideoSnapshot,
      'viewCount' | 'likeCount' | 'commentCount' | 'publishedAt' | 'tags'
      | 'transcriptStatus' | 'transcriptSource' | 'frameStatus' | 'thumbnail'
    >>,
  ): VideoSnapshot {
    const current = this.getVideoSnapshot(id);
    if (!current) throw new AppError('not_found', 'Video snapshot không tồn tại');
    this.database.prepare(
      `UPDATE video_snapshots SET
       view_count=?, like_count=?, comment_count=?, published_at=?, tags_json=?,
       transcript_status=?, transcript_source=?, frame_status=?, thumbnail_json=?
       WHERE id=?`,
    ).run(
      patch.viewCount ?? current.viewCount,
      patch.likeCount ?? current.likeCount,
      patch.commentCount ?? current.commentCount,
      patch.publishedAt ?? current.publishedAt,
      JSON.stringify(patch.tags ?? current.tags),
      patch.transcriptStatus ?? current.transcriptStatus,
      patch.transcriptSource ?? current.transcriptSource,
      patch.frameStatus ?? current.frameStatus,
      patch.thumbnail === undefined
        ? (current.thumbnail ? JSON.stringify(current.thumbnail) : null)
        : (patch.thumbnail ? JSON.stringify(patch.thumbnail) : null),
      id,
    );
    return this.getVideoSnapshot(id)!;
  }

  patchVideoDuration(id: string, durationSec: number): void {
    this.database.prepare('UPDATE video_snapshots SET duration_sec=? WHERE id=?').run(durationSec, id);
  }

  getVideoSnapshot(id: string): VideoSnapshot | null {
    const row = this.database.prepare('SELECT * FROM video_snapshots WHERE id=?').get(id) as Row | undefined;
    return row ? videoSnapshotFromRow(row) : null;
  }

  getVideoSnapshotBySourceId(spyRunId: string, sourceVideoId: string): VideoSnapshot | null {
    const row = this.database.prepare(
      'SELECT * FROM video_snapshots WHERE spy_run_id=? AND source_video_id=?',
    ).get(spyRunId, sourceVideoId) as Row | undefined;
    return row ? videoSnapshotFromRow(row) : null;
  }

  listVideoSnapshots(spyRunId: string): VideoSnapshot[] {
    const rows = this.database.prepare(
      'SELECT * FROM video_snapshots WHERE spy_run_id=? ORDER BY rank,id',
    ).all(spyRunId) as Row[];
    return rows.map(videoSnapshotFromRow);
  }

  /** Caller must already be inside a this.transaction() — not re-entrant on its own. */
  private insertTranscriptSegmentsInner(segments: readonly TranscriptSegment[]): void {
    const statement = this.database.prepare(
      `INSERT INTO transcript_segments
       (id,video_snapshot_id,video_transcript_id,segment_index,start_sec,end_sec,text,source,language,content_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const segment of segments) {
      statement.run(
        segment.id,
        segment.videoSnapshotId,
        segment.videoTranscriptId ?? null,
        segment.index,
        segment.startSec,
        segment.endSec,
        segment.text,
        segment.source,
        segment.language,
        segment.contentHash,
      );
      this.database.prepare(
        `INSERT INTO transcript_fts(rowid, text)
         SELECT rowid, text FROM transcript_segments WHERE id=?`,
      ).run(segment.id);
    }
  }

  insertTranscriptSegments(segments: readonly TranscriptSegment[]): void {
    this.transaction(() => this.insertTranscriptSegmentsInner(segments));
  }

  replaceTranscriptSegments(videoSnapshotId: string, segments: readonly TranscriptSegment[]): void {
    // Delete + insert in one transaction — a crash between two separate transactions
    // would otherwise leave transcript_status:'ok' pointing at zero segments.
    this.transaction(() => {
      const oldRows = this.database.prepare(
        'SELECT rowid FROM transcript_segments WHERE video_snapshot_id=?',
      ).all(videoSnapshotId) as Array<{ rowid: number }>;
      for (const row of oldRows) {
        this.database.prepare('INSERT INTO transcript_fts(transcript_fts, rowid) VALUES ("delete", ?)').run(row.rowid);
      }
      this.database.prepare('DELETE FROM transcript_segments WHERE video_snapshot_id=?').run(videoSnapshotId);
      this.insertTranscriptSegmentsInner(segments);
    });
  }

  listSnapshotsBySourceVideoId(sourceVideoId: string): VideoSnapshot[] {
    const rows = this.database.prepare(
      'SELECT * FROM video_snapshots WHERE source_video_id=? ORDER BY created_at DESC',
    ).all(sourceVideoId) as Row[];
    return rows.map(videoSnapshotFromRow);
  }

  upsertVideoTranscript(transcript: VideoTranscript): void {
    // Two keys can collide here: the primary key, because a refetch reuses the previous
    // row's id, and the natural key (video, language, source). A refetch that resolves to
    // a *different* track — say the manual `vi` subtitles instead of the auto `vi-orig`
    // ones — changes the natural key while keeping the id, so a single ON CONFLICT target
    // cannot absorb it and the insert fails on the primary key. Clearing both candidates
    // first also retires the row for the track we are moving away from.
    // transcript_segments.video_transcript_id carries no foreign key, so segments written
    // by the caller afterwards remain intact.
    this.database.transaction(() => {
      this.database.prepare(
        `DELETE FROM video_transcripts
         WHERE id = ? OR (source_video_id = ? AND language = ? AND source = ?)`,
      ).run(transcript.id, transcript.sourceVideoId, transcript.language, transcript.source);
      this.database.prepare(
        `INSERT INTO video_transcripts
         (id, source_video_id, language, source, content_hash, fetched_at, normalized_text, normalized_at, normalize_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        transcript.id,
        transcript.sourceVideoId,
        transcript.language,
        transcript.source,
        transcript.contentHash,
        transcript.fetchedAt,
        transcript.normalizedText,
        transcript.normalizedAt,
        transcript.normalizeModel,
      );
    })();
  }

  getVideoTranscript(sourceVideoId: string, prefer: 'manual' | 'any' = 'any'): VideoTranscript | null {
    const rows = this.database.prepare(
      `SELECT * FROM video_transcripts WHERE source_video_id=?
       ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END, fetched_at DESC`,
    ).all(sourceVideoId) as Row[];
    const row = prefer === 'manual'
      ? rows.find((r) => r['source'] === 'manual') ?? rows[0]
      : rows[0];
    if (!row) return null;
    return videoTranscriptFromRow(row);
  }

  saveNormalizedTranscript(videoTranscriptId: string, text: string, model: string): void {
    this.database.prepare(
      `UPDATE video_transcripts SET normalized_text=?, normalized_at=?, normalize_model=? WHERE id=?`,
    ).run(text, nowIso(), model, videoTranscriptId);
  }

  listTranscriptSegmentsBySourceVideoId(sourceVideoId: string): TranscriptSegment[] {
    const snapshot = this.listSnapshotsBySourceVideoId(sourceVideoId)[0];
    if (!snapshot) return [];
    return this.listTranscriptSegments(snapshot.id, 0, 100_000);
  }

  searchTranscriptFts(input: {
    query: string;
    sourceVideoIds?: string[];
    channelId?: string;
    limit?: number;
  }): Array<{
    sourceVideoId: string;
    startSec: number;
    endSec: number;
    snippet: string;
    segmentId: string;
  }> {
    const limit = input.limit ?? 20;
    const safe = input.query.replace(/"/g, '""');
    let sql = `
      SELECT ts.id, ts.start_sec, ts.end_sec, ts.text, vs.source_video_id
      FROM transcript_fts fts
      JOIN transcript_segments ts ON ts.rowid = fts.rowid
      JOIN video_snapshots vs ON vs.id = ts.video_snapshot_id
      WHERE transcript_fts MATCH ?
    `;
    const params: Array<string | number> = [safe];
    if (input.sourceVideoIds?.length) {
      sql += ` AND vs.source_video_id IN (${input.sourceVideoIds.map(() => '?').join(',')})`;
      params.push(...input.sourceVideoIds);
    }
    if (input.channelId) {
      sql += ` AND vs.spy_run_id IN (
        SELECT id FROM spy_runs WHERE source_identity LIKE ? OR canonical_source LIKE ? OR id=?
      )`;
      params.push(`%${input.channelId}%`, `%${input.channelId}%`, input.channelId);
    }
    sql += ' LIMIT ?';
    params.push(limit);
    try {
      const rows = this.database.prepare(sql).all(...params) as Row[];
      return rows.map((row) => ({
        sourceVideoId: String(row['source_video_id']),
        startSec: Number(row['start_sec']),
        endSec: Number(row['end_sec']),
        snippet: String(row['text']),
        segmentId: String(row['id']),
      }));
    } catch {
      const like = `%${input.query}%`;
      const rows = this.database.prepare(
        `SELECT ts.id, ts.start_sec, ts.end_sec, ts.text, vs.source_video_id
         FROM transcript_segments ts
         JOIN video_snapshots vs ON vs.id = ts.video_snapshot_id
         WHERE ts.text LIKE ?
         LIMIT ?`,
      ).all(like, limit) as Row[];
      return rows.map((row) => ({
        sourceVideoId: String(row['source_video_id']),
        startSec: Number(row['start_sec']),
        endSec: Number(row['end_sec']),
        snippet: String(row['text']),
        segmentId: String(row['id']),
      }));
    }
  }

  listTranscriptSegments(videoSnapshotId: string, offset = 0, limit = 500): TranscriptSegment[] {
    const rows = this.database.prepare(
      `SELECT * FROM transcript_segments WHERE video_snapshot_id=?
       ORDER BY segment_index LIMIT ? OFFSET ?`,
    ).all(videoSnapshotId, limit, offset) as Row[];
    return rows.map((row) => ({
      id: String(row['id']),
      videoSnapshotId: String(row['video_snapshot_id']),
      index: Number(row['segment_index']),
      startSec: Number(row['start_sec']),
      endSec: Number(row['end_sec']),
      text: String(row['text']),
      source: String(row['source']),
      language: nullableString(row['language']),
      contentHash: String(row['content_hash']),
    }));
  }

  getTranscriptSegment(id: string): TranscriptSegment | null {
    const row = this.database.prepare('SELECT * FROM transcript_segments WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      videoSnapshotId: String(row['video_snapshot_id']),
      index: Number(row['segment_index']),
      startSec: Number(row['start_sec']),
      endSec: Number(row['end_sec']),
      text: String(row['text']),
      source: String(row['source']),
      language: nullableString(row['language']),
      contentHash: String(row['content_hash']),
    };
  }

  transcriptSegmentCount(videoSnapshotId: string): number {
    const row = this.database.prepare(
      'SELECT COUNT(*) AS count FROM transcript_segments WHERE video_snapshot_id=?',
    ).get(videoSnapshotId) as Row;
    return Number(row['count']);
  }

  insertFrameSamples(frames: readonly FrameSample[]): void {
    const statement = this.database.prepare(
      `INSERT INTO frame_samples
       (id,video_snapshot_id,frame_index,timestamp_sec,dhash,artifact_json)
       VALUES (?,?,?,?,?,?)`,
    );
    this.transaction(() => {
      for (const frame of frames) {
        statement.run(
          frame.id,
          frame.videoSnapshotId,
          frame.index,
          frame.timestampSec,
          frame.dhash,
          JSON.stringify(frame.artifact),
        );
      }
    });
  }

  listFrameSamples(videoSnapshotId: string, offset = 0, limit = 100): FrameSample[] {
    const rows = this.database.prepare(
      `SELECT * FROM frame_samples WHERE video_snapshot_id=?
       ORDER BY frame_index LIMIT ? OFFSET ?`,
    ).all(videoSnapshotId, limit, offset) as Row[];
    return rows.map((row) => ({
      id: String(row['id']),
      videoSnapshotId: String(row['video_snapshot_id']),
      index: Number(row['frame_index']),
      timestampSec: Number(row['timestamp_sec']),
      dhash: String(row['dhash']),
      artifact: parseJson<ArtifactRef>(row['artifact_json']),
    }));
  }

  getFrameSample(id: string): FrameSample | null {
    const row = this.database.prepare('SELECT * FROM frame_samples WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      videoSnapshotId: String(row['video_snapshot_id']),
      index: Number(row['frame_index']),
      timestampSec: Number(row['timestamp_sec']),
      dhash: String(row['dhash']),
      artifact: parseJson<ArtifactRef>(row['artifact_json']),
    };
  }

  frameSampleCount(videoSnapshotId: string): number {
    const row = this.database.prepare(
      'SELECT COUNT(*) AS count FROM frame_samples WHERE video_snapshot_id=?',
    ).get(videoSnapshotId) as Row;
    return Number(row['count']);
  }

  saveMetrics(input: {
    scope: string;
    scopeId: string;
    spyRunId: string;
    payload: unknown;
  }): string {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO metrics (id, scope, scope_id, spy_run_id, payload_json, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.scope, input.scopeId, input.spyRunId, JSON.stringify(input.payload), nowIso());
    return id;
  }

  getLatestMetrics(scope: string, scopeId: string): { id: string; payload: unknown; computedAt: string; spyRunId: string } | null {
    const row = this.database.prepare(
      `SELECT * FROM metrics WHERE scope=? AND scope_id=? ORDER BY computed_at DESC LIMIT 1`,
    ).get(scope, scopeId) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      payload: parseJson<unknown>(row['payload_json']),
      computedAt: String(row['computed_at']),
      spyRunId: String(row['spy_run_id']),
    };
  }

  saveProfile(input: {
    scope: string;
    scopeId: string;
    spyRunId: string;
    kind: string;
    payload: unknown;
    evidence: unknown;
    model: string | null;
  }): string {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO profiles (id, scope, scope_id, spy_run_id, kind, payload_json, evidence_json, model, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.scope,
      input.scopeId,
      input.spyRunId,
      input.kind,
      JSON.stringify(input.payload),
      JSON.stringify(input.evidence),
      input.model,
      nowIso(),
    );
    return id;
  }

  getLatestProfile(scope: string, scopeId: string, kind: string): {
    id: string;
    payload: unknown;
    evidence: unknown;
    computedAt: string;
    spyRunId: string;
    model: string | null;
  } | null {
    const row = this.database.prepare(
      `SELECT * FROM profiles WHERE scope=? AND scope_id=? AND kind=? ORDER BY computed_at DESC LIMIT 1`,
    ).get(scope, scopeId, kind) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      payload: parseJson<unknown>(row['payload_json']),
      evidence: parseJson<unknown>(row['evidence_json']),
      computedAt: String(row['computed_at']),
      spyRunId: String(row['spy_run_id']),
      model: nullableString(row['model']),
    };
  }
}
