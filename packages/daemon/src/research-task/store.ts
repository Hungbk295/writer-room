/** Durable ResearchTask domain. All writes are SQLite transactions; actor identity comes from the caller's credential. */
import { Database } from 'bun:sqlite';
import { mkdirSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type Actor = { role: 'operator'; subject: string } | { role: 'worker'; subject: string; profile?: string } | { role: 'viewer'; subject: string };
export type SpyRunInfo = {
  status: string;
  videoIds: string[];
  run?: { videoCount?: number | null; kind?: string | null; createdAt?: string | null; completedAt?: string | null };
  videos?: { youtubeVideoId: string; viewCount?: number | null; durationSec?: number | null; publishedAt?: string | null; title?: string | null; channelTitle?: string | null; rank?: number | null; transcriptStatus?: string | null; transcriptSegments?: number | null }[];
};
export type Phase = 'created' | 'ready' | 'running' | 'pause_requested' | 'paused' | 'cancel_requested' | 'cancelled' | 'blocked' | 'failed' | 'completed' | 'unknown';
export type Budget = { maxRounds: number; maxUniqueVideos: number; maxSearchCost: number };
export class ResearchTaskError extends Error { constructor(public code: string, message: string) { super(message); } }
const fail = (code: string, message: string): never => { throw new ResearchTaskError(code, message); };
const iso = () => new Date().toISOString();
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const asString = (v: unknown, label: string) => typeof v === 'string' && v.trim() ? v.trim() : fail('INVALID', `${label} required`);
const asInt = (v: unknown, label: string, min = 0) => Number.isSafeInteger(v) && (v as number) >= min ? v as number : fail('INVALID', `${label} must be integer >= ${min}`);

/** Event types mirrored into `research_outbox` per audience.
 *  worker = wake/assignment signal (claim-waiting Hermes profile);
 *  operator = progress feed the Telegram bridge drains with receipts. */
const OUTBOX_AUDIENCE: Record<string, ('worker' | 'operator')[]> = {
  worker_bound: ['worker', 'operator'],
  worker_orphaned: ['worker', 'operator'],
  instruction_queued: ['worker'],
  running: ['worker', 'operator'], // resume wake — claim itself emits 'claimed'
  pause_requested: ['worker'],
  cancel_requested: ['worker'],
  unknown: ['worker', 'operator'],
  claimed: ['operator'],
  round_reserved: ['operator'],
  round_completed: ['operator'],
  instruction_applied: ['operator'],
  paused: ['operator'],
  cancelled: ['operator'],
  blocked: ['operator'],
  failed: ['operator'],
  completed: ['operator'],
};

export class ResearchTaskStore {
  readonly db: Database;
  readonly artifactRoot: string;
  /** Source-of-truth lookup for a Spy run (wired to SpyService in the daemon):
   *  returns run status + the video ids it actually produced, or null. */
  private readonly spyRunInfo?: (spyRunId: string) => SpyRunInfo | null;
  /** Real Spy quota probe (wired to `spy.quota.remaining('search')` in the
   *  daemon). `searchCost` on a round is counted in search.list calls. When the
   *  dep is wired and returns null the store fails CLOSED — a task must never
   *  reserve quota it cannot confirm. */
  private readonly spyQuota?: () => { searchRemaining: number } | null;
  constructor(dbPath: string, artifactRoot: string, opts: {
    spyRunInfo?: (spyRunId: string) => SpyRunInfo | null;
    spyQuota?: () => { searchRemaining: number } | null;
  } = {}) {
    this.spyRunInfo = opts.spyRunInfo;
    this.spyQuota = opts.spyQuota;
    mkdirSync(dirname(dbPath), { recursive: true }); mkdirSync(artifactRoot, { recursive: true });
    this.artifactRoot = realpathSync(artifactRoot);
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_tasks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mode TEXT NOT NULL, input_json TEXT NOT NULL, phase TEXT NOT NULL, round_index INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, max_rounds INTEGER NOT NULL, max_videos INTEGER NOT NULL, max_search INTEGER NOT NULL, spent_search INTEGER NOT NULL DEFAULT 0, reserved_search INTEGER NOT NULL DEFAULT 0, worker_subject TEXT, worker_profile TEXT, worker_session TEXT, lease_until TEXT, pending_command TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT);
      CREATE TABLE IF NOT EXISTS research_rounds (task_id TEXT NOT NULL, round_index INTEGER NOT NULL, plan_hash TEXT NOT NULL, phase TEXT NOT NULL, reserved_search INTEGER NOT NULL, actual_search INTEGER, started_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(task_id,round_index), FOREIGN KEY(task_id) REFERENCES research_tasks(id));
      CREATE TABLE IF NOT EXISTS research_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS research_events_task_cursor ON research_events(task_id,cursor);
      CREATE TABLE IF NOT EXISTS research_commands (task_id TEXT NOT NULL, command_id TEXT NOT NULL, operation TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(task_id,command_id));
      CREATE TABLE IF NOT EXISTS research_videos (task_id TEXT NOT NULL, video_id TEXT NOT NULL, spy_run_id TEXT NOT NULL, round_index INTEGER NOT NULL, PRIMARY KEY(task_id,video_id));
      CREATE TABLE IF NOT EXISTS research_spy_runs (task_id TEXT NOT NULL, spy_run_id TEXT NOT NULL, round_index INTEGER NOT NULL, PRIMARY KEY(task_id,spy_run_id));
      CREATE TABLE IF NOT EXISTS research_artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, round_index INTEGER NOT NULL, type TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, validation_state TEXT NOT NULL, UNIQUE(task_id,path));
      CREATE TABLE IF NOT EXISTS research_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, audience TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, receipt TEXT);
      CREATE INDEX IF NOT EXISTS research_outbox_undelivered ON research_outbox(audience,id) WHERE delivered_at IS NULL;
    `);
    // Migration: v3 adds fact_gate_version (P3 factual gate policy, fixed at
    // create by the operator — 1 = structural only, 2 = verified claims).
    const cols = this.db.query("PRAGMA table_info(research_tasks)").all() as any[];
    if (!cols.some((c) => c.name === 'fact_gate_version')) {
      this.db.exec('ALTER TABLE research_tasks ADD COLUMN fact_gate_version INTEGER NOT NULL DEFAULT 1');
    }
  }
  close() { this.db.close(); }
  private task(id: string): any { const row = this.db.query('SELECT * FROM research_tasks WHERE id=?').get(id) as any; return row ?? fail('NOT_FOUND', 'task not found'); }
  private authorize(actor: Actor, row: any, write = false) {
    if (actor.role === 'viewer') fail('FORBIDDEN', 'viewer has no Research access');
    if (actor.role === 'operator') { if (actor.subject !== row.owner_id) fail('FORBIDDEN', 'operator is not owner'); }
    else if (row.worker_subject !== actor.subject || (!row.lease_until || row.lease_until < iso())) fail('FORBIDDEN', 'worker not bound or lease expired');
    if (write && actor.role === 'worker' && !['running','pause_requested','cancel_requested'].includes(row.phase)) fail('PHASE', 'task is not active');
  }
  /** An operator-facing read path that does not require ownership — used by list(). */
  private view(row: any) {
    return { ...row, artifactDir: join(this.artifactRoot, row.id), factGateVersion: row.fact_gate_version, input: JSON.parse(row.input_json), budget: { maxRounds: row.max_rounds, maxUniqueVideos: row.max_videos, maxSearchCost: row.max_search, spentSearch: row.spent_search, reservedSearch: row.reserved_search, uniqueVideos: (this.db.query('SELECT COUNT(*) n FROM research_videos WHERE task_id=?').get(row.id) as any).n }, leaseExpired: Boolean(row.lease_until && row.lease_until < iso()) };
  }
  private event(id: string, type: string, payload: unknown) {
    this.db.query('INSERT INTO research_events(task_id,type,payload_json,created_at) VALUES(?,?,?,?)').run(id,type,JSON.stringify(payload),iso());
    // Durable outbox (P2): the same transaction also enqueues notifications.
    // 'worker' audience = wake signal the Hermes worker polls after resume /
    // assignment; 'operator' audience = Telegram-bridge progress feed. Delivery
    // is AT LEAST ONCE: the watcher/bridge must persist its transport receipt
    // via outboxAck and only then advance its cursor — a crash between send
    // and ack leaves the row undelivered and may produce a duplicate send.
    // Never pushed, never LLM-polled.
    for (const audience of OUTBOX_AUDIENCE[type] ?? []) {
      this.db.query('INSERT INTO research_outbox(task_id,audience,kind,payload_json,created_at) VALUES(?,?,?,?,?)').run(id,audience,type,JSON.stringify(payload),iso());
    }
  }

  /** Poll undelivered outbox rows. Worker sees 'worker' rows for tasks queued on
   *  its profile; operator sees 'operator' rows for tasks it owns. */
  outboxPoll(actor: Actor, arg: { audience: 'worker' | 'operator'; afterCursor?: number; limit?: number }) {
    if (actor.role === 'viewer') fail('FORBIDDEN', 'viewer has no Research access');
    const audience = arg.audience === 'worker' ? 'worker' : arg.audience === 'operator' ? 'operator' : fail('INVALID', 'audience must be worker|operator');
    if (audience === 'worker' && actor.role !== 'worker') fail('FORBIDDEN', 'worker audience requires worker token');
    if (audience === 'operator' && actor.role !== 'operator') fail('FORBIDDEN', 'operator audience requires operator token');
    const limit = Math.min(asInt(arg.limit ?? 100, 'limit'), 500);
    const cursor = asInt(arg.afterCursor ?? 0, 'afterCursor');
    const scope = audience === 'worker' ? (actor as { profile?: string }).profile ?? '' : actor.subject;
    const rows = audience === 'worker'
      ? this.db.query("SELECT o.id,o.task_id,o.kind,o.payload_json,o.created_at FROM research_outbox o JOIN research_tasks t ON t.id=o.task_id WHERE o.audience='worker' AND o.delivered_at IS NULL AND o.id>? AND t.worker_profile=? ORDER BY o.id LIMIT ?").all(cursor, scope, limit)
      : this.db.query("SELECT o.id,o.task_id,o.kind,o.payload_json,o.created_at FROM research_outbox o JOIN research_tasks t ON t.id=o.task_id WHERE o.audience='operator' AND o.delivered_at IS NULL AND o.id>? AND t.owner_id=? ORDER BY o.id LIMIT ?").all(cursor, scope, limit);
    return (rows as any[]).map((r) => ({ cursor: r.id, taskId: r.task_id, kind: r.kind, payload: JSON.parse(r.payload_json), at: r.created_at }));
  }

  /** Delivery receipt: marks outbox rows ≤ throughCursor as delivered. Replay is
   *  idempotent (already-delivered rows are skipped) — but this does NOT make
   *  end-to-end delivery exactly-once. The bridge should store the transport
   *  message id in `receipt` BEFORE acking; a row left undelivered after a
   *  crash means "unknown — reconcile via the transport receipt, do not
   *  auto-resend". */
  outboxAck(actor: Actor, arg: { audience: 'worker' | 'operator'; throughCursor: number; receipt?: string }) {
    if (actor.role === 'viewer') fail('FORBIDDEN', 'viewer has no Research access');
    const audience = arg.audience === 'worker' ? 'worker' : arg.audience === 'operator' ? 'operator' : fail('INVALID', 'audience must be worker|operator');
    if (audience === 'worker' && actor.role !== 'worker') fail('FORBIDDEN', 'worker audience requires worker token');
    if (audience === 'operator' && actor.role !== 'operator') fail('FORBIDDEN', 'operator audience requires operator token');
    const through = asInt(arg.throughCursor, 'throughCursor', 1);
    const receipt = typeof arg.receipt === 'string' && arg.receipt.trim() ? arg.receipt.trim() : null;
    return this.db.transaction(() => {
      const scope = audience === 'worker' ? (actor as { profile?: string }).profile ?? '' : actor.subject;
      const rows = audience === 'worker'
        ? this.db.query("SELECT o.id FROM research_outbox o JOIN research_tasks t ON t.id=o.task_id WHERE o.audience='worker' AND o.delivered_at IS NULL AND o.id<=? AND t.worker_profile=?").all(through, scope) as any[]
        : this.db.query("SELECT o.id FROM research_outbox o JOIN research_tasks t ON t.id=o.task_id WHERE o.audience='operator' AND o.delivered_at IS NULL AND o.id<=? AND t.owner_id=?").all(through, scope) as any[];
      for (const r of rows) this.db.query('UPDATE research_outbox SET delivered_at=?, receipt=? WHERE id=?').run(iso(), receipt, r.id);
      return { delivered: rows.length, throughCursor: through, receipt };
    })();
  }

  /** Exact-row ack: delivers ONLY the row at `cursor`. A HOLD/unknown row
   *  earlier in the stream stays undelivered (no false ack), so a relay can
   *  confirm row N without implicitly confirming row N-1. Idempotent — an
   *  already-delivered row returns delivered:0. */
  outboxAckOne(actor: Actor, arg: { audience: 'worker' | 'operator'; cursor: number; receipt?: string }) {
    if (actor.role === 'viewer') fail('FORBIDDEN', 'viewer has no Research access');
    const audience = arg.audience === 'worker' ? 'worker' : arg.audience === 'operator' ? 'operator' : fail('INVALID', 'audience must be worker|operator');
    if (audience === 'worker' && actor.role !== 'worker') fail('FORBIDDEN', 'worker audience requires worker token');
    if (audience === 'operator' && actor.role !== 'operator') fail('FORBIDDEN', 'operator audience requires operator token');
    const cursor = asInt(arg.cursor, 'cursor', 1);
    const receipt = typeof arg.receipt === 'string' && arg.receipt.trim() ? arg.receipt.trim() : null;
    const row = this.db.query("SELECT o.id FROM research_outbox o JOIN research_tasks t ON t.id=o.task_id WHERE o.id=? AND o.audience=? AND o.delivered_at IS NULL").get(cursor, audience) as any;
    if (!row) return { delivered: 0, cursor, receipt };
    const scope = audience === 'worker' ? (actor as { profile?: string }).profile ?? '' : actor.subject;
    const allowed = audience === 'worker'
      ? this.db.query("SELECT 1 FROM research_outbox o JOIN research_tasks t ON t.id=o.task_id WHERE o.id=? AND t.worker_profile=?").get(cursor, scope)
      : this.db.query("SELECT 1 FROM research_outbox o JOIN research_tasks t ON t.id=o.task_id WHERE o.id=? AND t.owner_id=?").get(cursor, scope);
    if (!allowed) fail('FORBIDDEN', 'row outside actor scope');
    this.db.query('UPDATE research_outbox SET delivered_at=?, receipt=? WHERE id=?').run(iso(), receipt, cursor);
    return { delivered: 1, cursor, receipt };
  }
  private command<T>(id: string, key: string, operation: string, payload: unknown, fn: () => T): T {
    asString(key,'commandId'); const hash = sha(JSON.stringify([operation,payload]));
    return this.db.transaction(() => {
      const old = this.db.query('SELECT * FROM research_commands WHERE task_id=? AND command_id=?').get(id,key) as any;
      if (old) { if (old.payload_hash !== hash) fail('CONFLICT','commandId reused with different payload'); return JSON.parse(old.result_json) as T; }
      const result = fn();
      this.db.query('INSERT INTO research_commands VALUES(?,?,?,?,?)').run(id,key,operation,hash,JSON.stringify(result));
      return result;
    })();
  }
  private bump(id: string, version: number, changes: Record<string,unknown>) {
    const keys=Object.keys(changes); const values=Object.values(changes) as (string | number | null)[];
    const result=this.db.query(`UPDATE research_tasks SET ${keys.length ? keys.map(k=>`${k}=?`).join(',')+',' : ''} version=version+1, updated_at=? WHERE id=? AND version=?`).run(...values,iso(),id,version);
    if (!result.changes) fail('VERSION','stale task version');
    return this.task(id);
  }
  create(actor: Actor, arg: { commandId:string; taskId?:string; mode:string; input:unknown; budget?:Partial<Budget>; factGateVersion?:number }) {
    if (actor.role !== 'operator') fail('FORBIDDEN','operator required');
    const id=arg.taskId ?? randomUUID(); const budget={maxRounds:arg.budget?.maxRounds ?? 13,maxUniqueVideos:arg.budget?.maxUniqueVideos ?? 1300,maxSearchCost:arg.budget?.maxSearchCost ?? 1300};
    asInt(budget.maxRounds,'maxRounds',1); asInt(budget.maxUniqueVideos,'maxUniqueVideos',1); asInt(budget.maxSearchCost,'maxSearchCost',0);
    // Fact-gate policy is fixed HERE by the operator — the worker cannot
    // downgrade a v2 task by omitting claimsVersion from its manifest.
    const factGate=arg.factGateVersion===undefined?1:arg.factGateVersion;
    if(factGate!==1&&factGate!==2)fail('INVALID','factGateVersion must be 1 or 2');
    return this.command(id,arg.commandId,'create',{actor:actor.subject,...arg,taskId:id,budget,factGateVersion:factGate},()=>{
      const at=iso(); this.db.query('INSERT INTO research_tasks(id,owner_id,mode,input_json,phase,round_index,version,max_rounds,max_videos,max_search,spent_search,reserved_search,worker_subject,worker_profile,worker_session,lease_until,pending_command,created_at,updated_at,last_error,fact_gate_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,actor.subject,asString(arg.mode,'mode'),JSON.stringify(arg.input),'created',0,1,budget.maxRounds,budget.maxUniqueVideos,budget.maxSearchCost,0,0,null,null,null,null,null,at,at,null,factGate);
      mkdirSync(join(this.artifactRoot, id), { recursive: true }); // per-task artifact dir, daemon-owned
      this.event(id,'created',{ownerId:actor.subject,budget}); return this.get(actor,id);
    });
  }
  get(actor:Actor,id:string) { const row=this.task(id); this.authorize(actor,row); return this.view(row); }
  list(actor:Actor,arg:{phase?:Phase;limit?:number}={}) {
    const limit=Math.min(arg.limit??100,500);
    if (actor.role === 'viewer') fail('FORBIDDEN', 'viewer has no Research access');
    const rows=actor.role==='operator'
      ? (arg.phase?this.db.query('SELECT * FROM research_tasks WHERE owner_id=? AND phase=? ORDER BY created_at DESC LIMIT ?').all(actor.subject,arg.phase,limit):this.db.query('SELECT * FROM research_tasks WHERE owner_id=? ORDER BY created_at DESC LIMIT ?').all(actor.subject,limit))
      : (arg.phase?this.db.query('SELECT * FROM research_tasks WHERE worker_subject=? AND phase=? ORDER BY created_at DESC LIMIT ?').all(actor.subject,arg.phase,limit):this.db.query('SELECT * FROM research_tasks WHERE worker_subject=? ORDER BY created_at DESC LIMIT ?').all(actor.subject,limit));
    return (rows as any[]).map(r=>this.view(r));
  }
  events(actor:Actor,id:string,afterCursor=0,limit=100) { this.authorize(actor,this.task(id)); return this.db.query('SELECT * FROM research_events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT ?').all(id,asInt(afterCursor,'afterCursor'),Math.min(asInt(limit,'limit',1),500)); }
  /** Operator assigns a task to a worker queue. `workerSubject` may be omitted: the
   *  first worker authenticated on `profile` that claims the task becomes the bound
   *  worker. Rebinding a `running` task is allowed only once its lease has expired
   *  (orphan reclaim) — an active lease cannot be hijacked. */
  bind(actor:Actor,id:string,arg:{commandId:string;expectedVersion:number;workerSubject?:string;profile:string;sessionRef?:string;leaseUntil?:string}) {
    if(actor.role!=='operator') fail('FORBIDDEN','operator required');
    return this.command(id,arg.commandId,'bind',arg,()=>{ const row=this.task(id); this.authorize(actor,row);
      const orphaned=['running','pause_requested','cancel_requested'].includes(row.phase)&&(!row.lease_until||row.lease_until<iso());
      if(!['created','ready','paused','blocked','unknown'].includes(row.phase)&&!orphaned) fail('PHASE','cannot bind now');
      // Cancel intent must survive a rebind: a cancel_requested orphan is
      // reassigned to the queue but stays cancel_requested — the next worker
      // claims it, then must cancel_ack. It never silently reverts to 'ready'.
      const keepCancel = row.phase === 'cancel_requested';
      const changes:Record<string,unknown>={worker_profile:asString(arg.profile,'profile'),phase:keepCancel?'cancel_requested':'ready'};
      // Omitting workerSubject opens the queue: any worker on the profile may claim.
      changes.worker_subject=arg.workerSubject!==undefined?asString(arg.workerSubject,'workerSubject'):null;
      changes.worker_session=arg.sessionRef?asString(arg.sessionRef,'sessionRef'):'queued';
      changes.lease_until=arg.leaseUntil?asString(arg.leaseUntil,'leaseUntil'):null;
      this.bump(id,arg.expectedVersion,changes);
      this.event(id,orphaned?'worker_orphaned':'worker_bound',{subject:arg.workerSubject??null,profile:arg.profile,cancelPreserved:keepCancel}); return this.get(actor,id); });
  }
  /** A worker claims the oldest `ready` task queued on its profile. The claim binds
   *  `worker_subject` (if the operator left the queue open) and starts the lease. */
  claim(actor:Actor,arg:{commandId:string;profile:string;sessionRef:string;leaseUntil:string}) {
    if(actor.role!=='worker') fail('FORBIDDEN','worker required');
    const profile=asString(arg.profile,'profile');
    // 'cancel_requested' rows are also claimable: the worker that picks one up
    // inherits the pending cancel and must ack it (phase stays cancel_requested
    // until research_task_ack cancel_ack). That is how a rebound orphan keeps
    // the operator's cancel intent.
    const row=this.db.query("SELECT * FROM research_tasks WHERE worker_profile=? AND phase IN ('ready','cancel_requested') AND (worker_subject IS NULL OR worker_subject=?) ORDER BY created_at LIMIT 1").get(profile,actor.subject) as any;
    if(!row) return null;
    return this.command(row.id,arg.commandId,'claim',arg,()=>{
      const current=this.task(row.id);if(!['ready','cancel_requested'].includes(current.phase)||current.worker_profile!==profile||(current.worker_subject&&current.worker_subject!==actor.subject))fail('CONFLICT','assignment changed');
      if(Date.parse(arg.leaseUntil)<=Date.now())fail('INVALID','lease must be future');
      this.bump(row.id,current.version,{worker_subject:actor.subject,worker_session:asString(arg.sessionRef,'sessionRef'),lease_until:arg.leaseUntil,phase:current.phase==='cancel_requested'?'cancel_requested':'running'});
      this.event(row.id,'claimed',{profile,sessionRef:arg.sessionRef,worker:actor.subject});return this.get(actor,row.id);
    });
  }
  heartbeat(actor:Actor,id:string,arg:{commandId:string;expectedVersion:number;leaseUntil:string}) {
    if(actor.role!=='worker') fail('FORBIDDEN','worker required');
    return this.command(id,arg.commandId,'heartbeat',arg,()=>{const row=this.task(id);this.authorize(actor,row,true);if(Date.parse(arg.leaseUntil)<=Date.now())fail('INVALID','lease must be future');this.bump(id,arg.expectedVersion,{lease_until:arg.leaseUntil});this.event(id,'heartbeat',{leaseUntil:arg.leaseUntil});return this.get(actor,id);});
  }
  /** Operator queues a durable mid-run instruction. It is applied (and cleared) at
   *  the next `reserve` round boundary — never mid-round, so a round already running
   *  finishes under the plan it reserved with. Replaces any unapplied instruction. */
  instruct(actor:Actor,id:string,arg:{commandId:string;expectedVersion:number;instruction:string}) {
    if(actor.role!=='operator') fail('FORBIDDEN','operator required');
    return this.command(id,arg.commandId,'instruct',arg,()=>{const row=this.task(id);this.authorize(actor,row);if(!['running','pause_requested','paused','ready'].includes(row.phase))fail('PHASE','task not instructable');
      this.bump(id,arg.expectedVersion,{pending_command:JSON.stringify({commandId:arg.commandId,instruction:asString(arg.instruction,'instruction'),at:iso()})});
      this.event(id,'instruction_queued',{commandId:arg.commandId});return this.get(actor,id);});
  }
  transition(actor:Actor,id:string,arg:{commandId:string;expectedVersion:number;action:'pause'|'pause_ack'|'resume'|'cancel'|'cancel_ack'|'block'|'fail'|'mark_unknown';reason?:string}) {
    const allowed:Record<string,[Phase[],Phase,'operator'|'worker']>={pause:[['running'],'pause_requested','operator'],pause_ack:[['pause_requested'],'paused','worker'],resume:[['paused','unknown','blocked'],'running','operator'],cancel:[['running','pause_requested','paused','ready','unknown','blocked'],'cancel_requested','operator'],cancel_ack:[['cancel_requested'],'cancelled','worker'],block:[['running','pause_requested'],'blocked','worker'],fail:[['running','pause_requested'],'failed','worker'],mark_unknown:[['running','pause_requested'],'unknown','operator']};
    return this.command(id,arg.commandId,arg.action,arg,()=>{const row=this.task(id);this.authorize(actor,row);const rule=allowed[arg.action] as [Phase[],Phase,'operator'|'worker'];
      if(!rule)fail('INVALID','unknown action');if(actor.role!==rule[2])fail('FORBIDDEN','wrong actor');if(!rule[0].includes(row.phase))fail('PHASE','invalid transition');
      if(arg.action==='mark_unknown'&&row.lease_until&&row.lease_until>=iso())fail('PHASE','worker lease still valid');
      const changes:Record<string,unknown>={phase:rule[1],last_error:arg.reason??null};
      if(arg.action==='cancel_ack'||arg.action==='fail'){
        const released=(this.db.query("SELECT COALESCE(SUM(reserved_search),0) s FROM research_rounds WHERE task_id=? AND phase='reserved'").get(id) as any).s as number;
        this.db.query("UPDATE research_rounds SET phase='aborted', completed_at=? WHERE task_id=? AND phase='reserved'").run(iso(),id);
        if(released)changes.reserved_search=row.reserved_search-released;
      }
      this.bump(id,arg.expectedVersion,changes);this.event(id,rule[1],{reason:arg.reason??null});return this.get(actor,id);});
  }
  reserve(actor:Actor,id:string,arg:{commandId:string;expectedVersion:number;roundIndex:number;planHash:string;searchCost:number}) {
    if(actor.role!=='worker') fail('FORBIDDEN','worker required');
    return this.command(id,arg.commandId,'reserve',arg,()=>{const row=this.task(id);this.authorize(actor,row,true);const round=asInt(arg.roundIndex,'roundIndex',1);const cost=asInt(arg.searchCost,'searchCost');if(round!==row.round_index+1||round>row.max_rounds)fail('BUDGET','round cap or sequence exceeded');if(row.spent_search+row.reserved_search+cost>row.max_search)fail('BUDGET','search quota exceeded');
      // Quota binding (P2): the task budget is a reservation ceiling — the REAL
      // check is Spy source-of-truth remaining units. Probe offline → fail
      // closed; depleted → reject the round so the worker can settle a partial
      // report instead of spending quota it does not have.
      if(this.spyQuota){const q=this.spyQuota()??fail('QUOTA','Spy quota source unavailable (fail closed)');
        // Aggregate outstanding reservations across ALL tasks — otherwise two
        // tasks each below the ledger remainder could over-subscribe it.
        const outstanding=(this.db.query("SELECT COALESCE(SUM(reserved_search),0) s FROM research_tasks").get() as any).s as number;
        const effective=q.searchRemaining-outstanding;
        if(effective<cost)fail('QUOTA',`Spy search quota depleted: ${effective} unit(s) free (${q.searchRemaining} remaining − ${outstanding} reserved), round needs ${cost}`);}if(this.db.query('SELECT 1 FROM research_rounds WHERE task_id=? AND round_index=?').get(id,round))fail('CONFLICT','round exists');this.db.query('INSERT INTO research_rounds VALUES(?,?,?,?,?,?,?,?)').run(id,round,asString(arg.planHash,'planHash'),'reserved',cost,null,iso(),null);
      const changes:Record<string,unknown>={round_index:round,reserved_search:row.reserved_search+cost};
      const pending=row.pending_command?JSON.parse(row.pending_command) as {commandId:string;instruction:string}:null;
      if(pending)changes.pending_command=null;
      this.bump(id,arg.expectedVersion,changes);
      this.event(id,'round_reserved',{roundIndex:round,searchCost:cost});
      if(pending)this.event(id,'instruction_applied',{commandId:pending.commandId,instruction:pending.instruction,roundIndex:round});
      return this.get(actor,id);});
  }
  completeRound(actor:Actor,id:string,arg:{commandId:string;expectedVersion:number;roundIndex:number;actualSearch:number;spyRunIds:string[];videos:{videoId:string;spyRunId:string}[]}) {
    if(actor.role!=='worker') fail('FORBIDDEN','worker required');
    return this.command(id,arg.commandId,'round_complete',arg,()=>{const row=this.task(id);this.authorize(actor,row,true);const round=this.db.query('SELECT * FROM research_rounds WHERE task_id=? AND round_index=?').get(id,arg.roundIndex) as any;if(!round||round.phase!=='reserved'||arg.roundIndex!==row.round_index)fail('PHASE','round not reserved');const actual=asInt(arg.actualSearch,'actualSearch');if(actual>round.reserved_search)fail('BUDGET','actual exceeds reservation');if(!arg.spyRunIds?.length)fail('EVIDENCE','Spy run required');const refs=new Set(arg.spyRunIds.map(x=>asString(x,'spyRunId')));if(refs.size!==arg.spyRunIds.length)fail('EVIDENCE','duplicate Spy run');
      const runInfo=new Map<string,{status:string;videoIds:string[]}>();
      if(this.spyRunInfo){for(const ref of refs){const info=this.spyRunInfo(ref)??fail('EVIDENCE',`Spy run not found in source-of-truth: ${ref}`);if(info.status!=='completed')fail('EVIDENCE',`Spy run ${ref} is ${info.status}, not completed`);runInfo.set(ref,info);}}
      for(const v of arg.videos??[]) {asString(v.videoId,'videoId');if(!refs.has(v.spyRunId))fail('EVIDENCE','video lacks round Spy run');const info=runInfo.get(v.spyRunId);if(info&&!info.videoIds.includes(v.videoId))fail('EVIDENCE',`video ${v.videoId} not in Spy run ${v.spyRunId} manifest`);}
      const existing=(this.db.query('SELECT COUNT(*) n FROM research_videos WHERE task_id=?').get(id) as any).n;const unique=new Set((arg.videos??[]).map(v=>v.videoId));let additions=0;for(const videoId of unique)if(!this.db.query('SELECT 1 FROM research_videos WHERE task_id=? AND video_id=?').get(id,videoId))additions++;if(existing+additions>row.max_videos)fail('BUDGET','unique video cap exceeded');
      for(const ref of refs)this.db.query('INSERT INTO research_spy_runs VALUES(?,?,?)').run(id,ref,arg.roundIndex);for(const v of arg.videos??[])this.db.query('INSERT OR IGNORE INTO research_videos VALUES(?,?,?,?)').run(id,v.videoId,v.spyRunId,arg.roundIndex);
      this.db.query('UPDATE research_rounds SET phase=?,actual_search=?,completed_at=? WHERE task_id=? AND round_index=?').run('completed',actual,iso(),id,arg.roundIndex);this.bump(id,arg.expectedVersion,{spent_search:row.spent_search+actual,reserved_search:row.reserved_search-round.reserved_search});this.event(id,'round_completed',{roundIndex:arg.roundIndex,actualSearch:actual,uniqueVideosAdded:additions,spyRunIds:arg.spyRunIds});return this.get(actor,id);});
  }
  registerArtifact(actor:Actor,id:string,arg:{commandId:string;expectedVersion:number;roundIndex:number;type:'manifest'|'report'|'checkpoint'|'other';path:string}) {
    if(actor.role!=='worker') fail('FORBIDDEN','worker required');
    return this.command(id,arg.commandId,'artifact',arg,()=>{const row=this.task(id);this.authorize(actor,row,true);if(arg.roundIndex<1||arg.roundIndex>row.round_index)fail('INVALID','roundIndex invalid');const path=realpathSync(resolve(arg.path));const rel=relative(join(this.artifactRoot,id),path);if(rel.startsWith('..')||isAbsolute(rel)||!rel)fail('FORBIDDEN','artifact outside task dir');const stat=statSync(path);if(!stat.isFile())fail('INVALID','artifact must be file');const bytes=readFileSync(path);if(bytes.length>10_000_000)fail('INVALID','artifact too large');const hash=sha(bytes);
      // Supersede: re-registering the same path replaces the stored hash in
      // place (one artifact row per path) — the drifted/'stale' row heals and
      // the swap is audit-logged as artifact_superseded with old→new sha256.
      const prev=this.db.query('SELECT * FROM research_artifacts WHERE task_id=? AND path=?').get(id,path) as any;
      if(prev){this.db.query("UPDATE research_artifacts SET round_index=?,type=?,sha256=?,size=?,validation_state='registered' WHERE id=?").run(arg.roundIndex,arg.type,hash,bytes.length,prev.id);this.bump(id,arg.expectedVersion,{});this.event(id,'artifact_superseded',{artifactId:prev.id,path,type:arg.type,oldSha256:prev.sha256,newSha256:hash});return {artifactId:prev.id,sha256:hash,size:bytes.length,version:row.version+1};}
      const artifactId=randomUUID();this.db.query('INSERT INTO research_artifacts VALUES(?,?,?,?,?,?,?,?)').run(artifactId,id,arg.roundIndex,arg.type,path,hash,bytes.length,'registered');this.bump(id,arg.expectedVersion,{});this.event(id,'artifact_registered',{artifactId,type:arg.type,sha256:hash});return {artifactId,sha256:hash,size:bytes.length,version:row.version+1};});
  }
  completeTask(actor:Actor,id:string,arg:{commandId:string;expectedVersion:number}) {
    if(actor.role!=='worker') fail('FORBIDDEN','worker required');
    return this.command(id,arg.commandId,'task_complete',arg,()=>{const row=this.task(id);this.authorize(actor,row,true);if(row.reserved_search!==0)fail('PHASE','outstanding reservation');const pending=(this.db.query("SELECT COUNT(*) n FROM research_rounds WHERE task_id=? AND phase!='completed'").get(id) as any).n;if(pending||row.round_index===0)fail('PHASE','rounds incomplete');const arts=this.db.query('SELECT * FROM research_artifacts WHERE task_id=?').all(id) as any[];if(!arts.some(x=>x.type==='manifest')||!arts.some(x=>x.type==='report'))fail('EVIDENCE','manifest and report required');
      // Hard gate: rehash every registered artifact — content must still match what
      // was registered; drift marks the row 'stale' and blocks completion.
      for(const art of arts){let ok=false;try{ok=statSync(art.path).isFile()&&sha(readFileSync(art.path))===art.sha256;}catch{ok=false;}
        this.db.query('UPDATE research_artifacts SET validation_state=? WHERE id=?').run(ok?'verified':'stale',art.id);
        if(!ok)fail('EVIDENCE',`artifact drifted or missing: ${art.path}`);}
      const spyRefs=(this.db.query('SELECT spy_run_id FROM research_spy_runs WHERE task_id=?').all(id) as any[]).map(r=>r.spy_run_id as string);
      if(!spyRefs.length)fail('EVIDENCE','Spy run required');
      const runInfos=new Map<string,SpyRunInfo>();
      if(this.spyRunInfo)for(const ref of spyRefs){const info=this.spyRunInfo(ref);if(info===null||info===undefined)fail('EVIDENCE',`Spy run missing in source-of-truth: ${ref}`);const runInfo=info as SpyRunInfo;if(runInfo.status!=='completed')fail('EVIDENCE',`Spy run ${ref} is ${runInfo.status}, not completed`);runInfos.set(ref,runInfo);}
      // Schema gate: manifest = JSON object with spyRunIds[] covering every recorded
      // Spy ref; report = non-empty body. A report that references nothing cannot
      // satisfy "facts cross-checked with Spy" (plan §4).
      const manifest=arts.find(x=>x.type==='manifest');const report=arts.find(x=>x.type==='report');
      let manifestRefs:string[]=[];let manifestObj:any=null;try{manifestObj=JSON.parse(readFileSync(manifest.path,'utf8'));const m=manifestObj;if(!m||typeof m!=='object'||!Array.isArray(m.spyRunIds)||!m.spyRunIds.every((x:unknown)=>typeof x==='string'))fail('EVIDENCE','manifest.spyRunIds must be a string array');manifestRefs=m.spyRunIds;}catch(e){if(e instanceof ResearchTaskError)throw e;fail('EVIDENCE','manifest is not valid JSON');}
      for(const ref of spyRefs)if(!manifestRefs.includes(ref))fail('EVIDENCE',`manifest does not reference Spy run ${ref}`);
      if(!readFileSync(report.path,'utf8').trim())fail('EVIDENCE','report is empty');
      // P3 v2 fact gate: policy fixed at create() by the operator — a v2 task
      // requires claimsVersion=2 + structured claims[]; omitting it cannot
      // downgrade the task to structural-only checks. Summary counts are
      // computed HERE from validated claims, never trusted from the manifest.
      // Scope: only whitelisted manifest metrics are verified against the Spy
      // stored snapshot; prose outside claims[] is NOT checked — this is not
      // "100% fact check".
      let claimsSummary:Record<string,number>|undefined;
      if(row.fact_gate_version===2){if(!this.spyRunInfo)fail('EVIDENCE','fact gate requires Spy source-of-truth verifier');claimsSummary=this.validateClaims(manifestObj,spyRefs,runInfos);}
      this.bump(id,arg.expectedVersion,{phase:'completed'});this.event(id,'completed',claimsSummary?{claims:claimsSummary}:{});return this.get(actor,id);});
  }
  /** P3 claims validator. Deterministic — no prose parsing. Returns
   *  daemon-computed summary {factVerified,factFailed,inference,unverifiable}.
   *  Comparisons are pinned to the stored Spy snapshot, never live YouTube. */
  private validateClaims(manifest:any, spyRefs:string[], runs:Map<string,SpyRunInfo>):Record<string,number>{
    if(manifest.claimsVersion!==2)fail('EVIDENCE','task factGateVersion=2 requires manifest claimsVersion=2');
    const claims=manifest.claims;
    if(!Array.isArray(claims)||!claims.length)fail('EVIDENCE','claims[] must be non-empty on a v2 task');
    if(claims.length>500)fail('INVALID','claims[] exceeds 500');
    const ids=new Set<string>();const summary={factVerified:0,factFailed:0,inference:0,unverifiable:0};const failures:string[]=[];let facts=0;
    for(const c of claims){
      if(!c||typeof c!=='object'||Array.isArray(c))fail('INVALID','claim must be an object');
      const cid=asString(c.id,'claim.id');if(ids.has(cid))fail('INVALID',`duplicate claim id: ${cid}`);ids.add(cid);
      const kind=c.kind;if(kind!=='fact'&&kind!=='inference'&&kind!=='unverifiable')fail('INVALID',`claim ${cid}: kind must be fact|inference|unverifiable`);
      const subj=c.subject;if(!subj||typeof subj!=='object')fail('INVALID',`claim ${cid}: subject required`);
      const runId=asString(subj.spyRunId,`claim ${cid}.subject.spyRunId`);
      if(!spyRefs.includes(runId))fail('EVIDENCE',`claim ${cid}: spyRunId ${runId} is not a recorded task ref`);
      const info=runs.get(runId)!;
      if(kind==='inference'){summary.inference++;continue;}
      if(kind==='unverifiable'){summary.unverifiable++;continue;}
      facts++;
      const metric=asString(c.metric,`claim ${cid}.metric`);
      const op=c.op;if(op!=='eq'&&op!=='gte'&&op!=='lte')fail('INVALID',`claim ${cid}: op must be eq|gte|lte`);
      const videoId=subj.videoId===undefined?undefined:asString(subj.videoId,`claim ${cid}.subject.videoId`);
      const table=videoId===undefined?CLAIM_METRICS.run:CLAIM_METRICS.video;
      const mtype=(table as Record<string,string>)[metric];
      if(!mtype)fail('INVALID',`claim ${cid}: metric '${metric}' is not a whitelisted ${videoId===undefined?'run':'video'} metric`);
      if(mtype==='cat'&&op!=='eq')fail('INVALID',`claim ${cid}: categorical metrics only support eq`);
      let snap:unknown;
      if(videoId===undefined){snap=metric==='status'?info.status:(info.run as any)?.[metric];}
      else{if(!info.videoIds.includes(videoId))fail('EVIDENCE',`claim ${cid}: video ${videoId} not in Spy run ${runId}`);snap=((info.videos??[]).find(v=>v.youtubeVideoId===videoId) as Record<string,unknown>|undefined)?.[metric];}
      if(snap===undefined||snap===null)fail('EVIDENCE',`claim ${cid}: Spy snapshot has no value for metric ${metric}`);
      if(mtype==='num'){
        if(typeof c.value!=='number'||!Number.isFinite(c.value))fail('INVALID',`claim ${cid}: value must be a finite number`);
        if(typeof snap!=='number'||!Number.isFinite(snap))fail('EVIDENCE',`claim ${cid}: snapshot ${metric} is not numeric`);
        const s=snap as number;const ok=op==='eq'?s===c.value:op==='gte'?s>=c.value:s<=c.value;
        if(ok)summary.factVerified++;else{summary.factFailed++;failures.push(`${cid}: ${metric} snapshot=${snap} expected ${op} ${c.value}`);}
      }else if(mtype==='cat'){
        if(op!=='eq')fail('INVALID',`claim ${cid}: categorical metrics only support eq`);
        if(typeof c.value!=='string')fail('INVALID',`claim ${cid}: value must be a string`);
        if(typeof snap!=='string')fail('EVIDENCE',`claim ${cid}: snapshot ${metric} is not a string`);
        const ok=normStr(snap as string)===normStr(c.value);
        if(ok)summary.factVerified++;else{summary.factFailed++;failures.push(`${cid}: ${metric} snapshot='${snap}' expected '${c.value}'`);}
      }else{ // date: strict ISO-UTC parse, epoch compare
        if(typeof c.value!=='string'||Number.isNaN(Date.parse(c.value)))fail('INVALID',`claim ${cid}: value must be an ISO date string`);
        if(typeof snap!=='string'||Number.isNaN(Date.parse(snap)))fail('EVIDENCE',`claim ${cid}: snapshot ${metric} is not a date`);
        const a=Date.parse(snap as string),b=Date.parse(c.value);
        const ok=op==='eq'?a===b:op==='gte'?a>=b:a<=b;
        if(ok)summary.factVerified++;else{summary.factFailed++;failures.push(`${cid}: ${metric} snapshot=${snap} expected ${op} ${c.value}`);}
      }
    }
    if(!facts)fail('EVIDENCE','v2 manifest requires at least one fact claim');
    if(summary.factFailed)fail('EVIDENCE',`fact claims failed vs Spy snapshot: ${failures.join('; ')}`);
    return summary;
  }
}
const normStr=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
const CLAIM_METRICS={
  run:{videoCount:'num',status:'cat',kind:'cat',createdAt:'date',completedAt:'date'},
  video:{viewCount:'num',durationSec:'num',rank:'num',transcriptSegments:'num',title:'cat',channelTitle:'cat',transcriptStatus:'cat',publishedAt:'date'},
};
