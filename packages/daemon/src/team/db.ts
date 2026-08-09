/** Team hub SQLite (bun:sqlite). Separate from Spy DB. */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database;

export function nowIso(): string {
  return new Date().toISOString();
}

export function openTeamDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_messages (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL,
      sender_agent_id TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions_json TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_team_messages_channel_cursor
      ON team_messages(channel, cursor);

    CREATE TABLE IF NOT EXISTS team_acks (
      channel TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      through_cursor INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel, agent_id)
    );

    CREATE TABLE IF NOT EXISTS team_assignments (
      agent_id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_agent_state (
      agent_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      summary TEXT,
      resume_session_ref TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      message_cursor INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_team_turns_status_agent
      ON team_turns(status, agent_id);

    CREATE TABLE IF NOT EXISTS team_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      agent_id TEXT,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}
