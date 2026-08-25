import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseJson(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function requireId(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function sameCanonicalEvent(left, right) {
  if (!left || !right) return false;
  const fields = [
    'event_id', 'workflow_run_id', 'task_id', 'attempt_id', 'source', 'type',
    'idempotency_key', 'lane', 'session_id', 'generation'
  ];
  return fields.every((field) => left[field] === right[field])
    && JSON.stringify(left.payload ?? {}) === JSON.stringify(right.payload ?? {});
}

export class SQLiteRuntimeStore {
  #database;
  #closed = false;
  #now;

  constructor(databasePath, { now = () => new Date().toISOString() } = {}) {
    requireId(databasePath, 'databasePath');
    if (databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    this.#now = now;
    this.#migrate(databasePath);
  }

  #migrate(databasePath) {
    this.#database.exec('PRAGMA foreign_keys = ON');
    if (databasePath !== ':memory:') this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        run_id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        state TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workflow_run_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        status TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        executor_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        conversation_root_id TEXT,
        head_attempt_id TEXT,
        status TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        workflow_run_id TEXT NOT NULL,
        task_id TEXT,
        attempt_id TEXT,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        lane TEXT NOT NULL,
        session_id TEXT,
        generation INTEGER,
        routed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS events_workflow_sequence
        ON events(workflow_run_id, sequence);
      CREATE TABLE IF NOT EXISTS cursors (
        source TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attention (
        attention_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_ref TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const eventColumns = this.#database.prepare('PRAGMA table_info(events)').all();
    if (!eventColumns.some((column) => column.name === 'routed_at')) {
      this.#database.exec('ALTER TABLE events ADD COLUMN routed_at TEXT');
      this.#database.prepare("UPDATE events SET routed_at = ? WHERE lane = 'control'").run(this.#now());
    }
  }

  saveWorkflow(workflow) {
    requireId(workflow?.run_id, 'workflow.run_id');
    requireId(workflow?.objective, 'workflow.objective');
    requireId(workflow?.state, 'workflow.state');
    this.#database.prepare(`
      INSERT INTO workflows (run_id, objective, state, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        objective = excluded.objective,
        state = excluded.state,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(workflow.run_id, workflow.objective, workflow.state, JSON.stringify(workflow), this.#now());
  }

  getWorkflow(runId) {
    const row = this.#database.prepare('SELECT data_json FROM workflows WHERE run_id = ?').get(runId);
    return parseJson(row?.data_json);
  }

  listWorkflows() {
    return this.#database.prepare('SELECT data_json FROM workflows ORDER BY updated_at DESC')
      .all().map((row) => parseJson(row.data_json)).filter(Boolean);
  }

  saveAttempt(attempt) {
    requireId(attempt?.attempt_id, 'attempt.attempt_id');
    this.#database.prepare(`
      INSERT INTO attempts (
        attempt_id, task_id, workflow_run_id, number, status, evidence_json, data_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET
        status = excluded.status,
        evidence_json = excluded.evidence_json,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(
      attempt.attempt_id,
      requireId(attempt.task_id, 'attempt.task_id'),
      requireId(attempt.workflow_run_id, 'attempt.workflow_run_id'),
      attempt.number,
      requireId(attempt.status, 'attempt.status'),
      JSON.stringify(attempt.evidence ?? {}),
      JSON.stringify(attempt),
      this.#now()
    );
  }

  getAttempt(attemptId) {
    const row = this.#database.prepare('SELECT data_json, evidence_json FROM attempts WHERE attempt_id = ?').get(attemptId);
    if (!row) return null;
    return { ...parseJson(row.data_json, {}), evidence: parseJson(row.evidence_json, {}) };
  }

  listAttempts({ workflowRunId }) {
    requireId(workflowRunId, 'workflowRunId');
    return this.#database.prepare(`
      SELECT data_json, evidence_json FROM attempts
      WHERE workflow_run_id = ? ORDER BY number
    `).all(workflowRunId).map((row) => ({
      ...parseJson(row.data_json, {}),
      evidence: parseJson(row.evidence_json, {})
    }));
  }

  saveSession(session) {
    requireId(session?.session_id, 'session.session_id');
    const generation = Number.isInteger(session.generation) && session.generation > 0 ? session.generation : 1;
    const stored = { ...session, generation };
    this.#database.prepare(`
      INSERT INTO sessions (
        session_id, executor_id, workspace_id, task_id, conversation_root_id,
        head_attempt_id, status, generation, data_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        executor_id = excluded.executor_id,
        workspace_id = excluded.workspace_id,
        task_id = excluded.task_id,
        conversation_root_id = excluded.conversation_root_id,
        head_attempt_id = excluded.head_attempt_id,
        status = excluded.status,
        generation = excluded.generation,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(
      stored.session_id,
      requireId(stored.executor_id, 'session.executor_id'),
      requireId(stored.workspace_id, 'session.workspace_id'),
      requireId(stored.task_id, 'session.task_id'),
      stored.conversation_root_id ?? null,
      stored.head_attempt_id ?? null,
      requireId(stored.status, 'session.status'),
      generation,
      JSON.stringify(stored),
      this.#now()
    );
  }

  getSession(sessionId) {
    const row = this.#database.prepare('SELECT data_json FROM sessions WHERE session_id = ?').get(sessionId);
    return parseJson(row?.data_json);
  }

  findSessionForTask(taskId, executorId) {
    const row = this.#database.prepare(`
      SELECT data_json FROM sessions
      WHERE task_id = ? AND executor_id = ? AND status NOT IN ('LOST', 'CANCELLED', 'COMPLETED')
      ORDER BY updated_at DESC LIMIT 1
    `).get(taskId, executorId);
    return parseJson(row?.data_json);
  }

  listSessions({ statuses } = {}) {
    if (statuses === undefined) {
      return this.#database.prepare('SELECT data_json FROM sessions ORDER BY updated_at')
        .all().map((row) => parseJson(row.data_json)).filter(Boolean);
    }
    if (!Array.isArray(statuses) || statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    return this.#database.prepare(`
      SELECT data_json FROM sessions WHERE status IN (${placeholders}) ORDER BY updated_at
    `).all(...statuses).map((row) => parseJson(row.data_json)).filter(Boolean);
  }

  setCursor(source, cursor) {
    requireId(source, 'cursor source');
    requireId(cursor, 'cursor');
    this.#database.prepare(`
      INSERT INTO cursors (source, cursor, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
    `).run(source, cursor, this.#now());
  }

  getCursor(source) {
    return this.#database.prepare('SELECT cursor FROM cursors WHERE source = ?').get(source)?.cursor ?? null;
  }

  createAttention(attention) {
    const createdAt = attention.created_at ?? this.#now();
    const stored = { ...attention, status: attention.status ?? 'OPEN', created_at: createdAt };
    this.#database.prepare(`
      INSERT INTO attention (
        attention_id, workflow_run_id, type, message, status, data_json, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attention_id) DO NOTHING
    `).run(
      requireId(stored.attention_id, 'attention.attention_id'),
      requireId(stored.workflow_run_id, 'attention.workflow_run_id'),
      requireId(stored.type, 'attention.type'),
      requireId(stored.message, 'attention.message'),
      stored.status,
      JSON.stringify(stored),
      createdAt,
      stored.resolved_at ?? null
    );
  }

  listAttention({ openOnly = false } = {}) {
    const sql = openOnly
      ? "SELECT data_json FROM attention WHERE status = 'OPEN' ORDER BY created_at"
      : 'SELECT data_json FROM attention ORDER BY created_at';
    return this.#database.prepare(sql).all().map((row) => parseJson(row.data_json)).filter(Boolean);
  }

  appendEvent(event) {
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, workflow_run_id, task_id, attempt_id, source, type, timestamp,
        payload_json, idempotency_key, lane, session_id, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requireId(event.event_id, 'event.event_id'),
      requireId(event.workflow_run_id, 'event.workflow_run_id'),
      event.task_id ?? null,
      event.attempt_id ?? null,
      requireId(event.source, 'event.source'),
      requireId(event.type, 'event.type'),
      requireId(event.timestamp, 'event.timestamp'),
      JSON.stringify(event.payload ?? {}),
      requireId(event.idempotency_key, 'event.idempotency_key'),
      requireId(event.lane, 'event.lane'),
      event.session_id ?? null,
      event.generation ?? null
    );
    if (Number(result.changes) === 1) return { status: 'inserted', event: this.getEvent(event.event_id) };
    const byEventId = this.getEvent(event.event_id);
    if (byEventId) {
      return sameCanonicalEvent(byEventId, event)
        ? { status: 'duplicate', event: byEventId }
        : { status: 'collision', event: byEventId };
    }
    const conflicting = this.#eventFromRow(
      this.#database.prepare('SELECT * FROM events WHERE idempotency_key = ?').get(event.idempotency_key)
    );
    return { status: 'collision', event: conflicting };
  }

  #eventFromRow(row) {
    if (!row) return null;
    return {
      event_id: row.event_id,
      workflow_run_id: row.workflow_run_id,
      task_id: row.task_id,
      attempt_id: row.attempt_id,
      source: row.source,
      type: row.type,
      timestamp: row.timestamp,
      payload: parseJson(row.payload_json, {}),
      idempotency_key: row.idempotency_key,
      lane: row.lane,
      session_id: row.session_id,
      generation: row.generation
    };
  }

  getEvent(eventId) {
    return this.#eventFromRow(this.#database.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId));
  }

  markEventRouted(eventId) {
    requireId(eventId, 'eventId');
    this.#database.prepare('UPDATE events SET routed_at = ? WHERE event_id = ?').run(this.#now(), eventId);
  }

  isEventRouted(eventId) {
    requireId(eventId, 'eventId');
    return Boolean(this.#database.prepare('SELECT routed_at FROM events WHERE event_id = ?').get(eventId)?.routed_at);
  }

  listPendingControlEvents({ workflowRunId, limit = 100 } = {}) {
    requireId(workflowRunId, 'workflowRunId');
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 1_000));
    return this.#database.prepare(`
      SELECT * FROM events
      WHERE workflow_run_id = ? AND lane = 'control' AND routed_at IS NULL
      ORDER BY sequence LIMIT ?
    `).all(workflowRunId, boundedLimit).map((row) => this.#eventFromRow(row));
  }

  listEvents({ workflowRunId, controlOnly = false, limit = 100 } = {}) {
    requireId(workflowRunId, 'workflowRunId');
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 1_000));
    const sql = controlOnly
      ? "SELECT * FROM events WHERE workflow_run_id = ? AND lane = 'control' ORDER BY sequence DESC LIMIT ?"
      : 'SELECT * FROM events WHERE workflow_run_id = ? ORDER BY sequence DESC LIMIT ?';
    return this.#database.prepare(sql).all(workflowRunId, boundedLimit)
      .reverse().map((row) => this.#eventFromRow(row));
  }

  saveArtifact({ artifact_ref, workflow_run_id, kind, content }) {
    this.#database.prepare(`
      INSERT INTO artifacts (artifact_ref, workflow_run_id, kind, content_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(artifact_ref) DO UPDATE SET content_json = excluded.content_json
    `).run(
      requireId(artifact_ref, 'artifact.artifact_ref'),
      requireId(workflow_run_id, 'artifact.workflow_run_id'),
      requireId(kind, 'artifact.kind'),
      JSON.stringify(content),
      this.#now()
    );
    return artifact_ref;
  }

  getArtifact(artifactRef) {
    const row = this.#database.prepare('SELECT * FROM artifacts WHERE artifact_ref = ?').get(artifactRef);
    if (!row) return null;
    return {
      artifact_ref: row.artifact_ref,
      workflow_run_id: row.workflow_run_id,
      kind: row.kind,
      content: parseJson(row.content_json),
      created_at: row.created_at
    };
  }

  close() {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
