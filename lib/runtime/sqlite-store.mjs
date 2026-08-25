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
      CREATE TABLE IF NOT EXISTS runtime_jobs (
        job_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        owner_id TEXT,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_jobs_status_created
        ON runtime_jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS daemon_leases (
        name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decision_audit (
        decision_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        attempt_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        packet_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        notification_id TEXT PRIMARY KEY,
        attention_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE(attention_id, transport)
      );
      CREATE TABLE IF NOT EXISTS external_deliveries (
        source TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        event_type TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY(source, delivery_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_nodes (
        workflow_run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        task_json TEXT NOT NULL,
        depends_json TEXT NOT NULL,
        result_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workflow_run_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS remote_runner_jobs (
        runner_job_id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        task_json TEXT NOT NULL,
        generation INTEGER NOT NULL,
        token TEXT NOT NULL,
        runner_id TEXT,
        lease_expires_at TEXT,
        result_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        schedule_id TEXT PRIMARY KEY,
        every_ms INTEGER NOT NULL,
        task_json TEXT NOT NULL,
        next_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_occurrences (
        occurrence_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        due_at TEXT NOT NULL,
        task_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const eventColumns = this.#database.prepare('PRAGMA table_info(events)').all();
    if (!eventColumns.some((column) => column.name === 'routed_at')) {
      this.#database.exec('ALTER TABLE events ADD COLUMN routed_at TEXT');
      this.#database.prepare("UPDATE events SET routed_at = ? WHERE lane = 'control'").run(this.#now());
    }
    const jobColumns = this.#database.prepare('PRAGMA table_info(runtime_jobs)').all();
    if (!jobColumns.some((column) => column.name === 'lease_expires_at')) {
      this.#database.exec('ALTER TABLE runtime_jobs ADD COLUMN lease_expires_at TEXT');
      this.#database.exec(`
        UPDATE runtime_jobs SET lease_expires_at = updated_at
        WHERE status = 'RUNNING' AND lease_expires_at IS NULL
      `);
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

  getAttention(attentionId) {
    const row = this.#database.prepare('SELECT data_json FROM attention WHERE attention_id = ?').get(attentionId);
    return parseJson(row?.data_json);
  }

  respondToAttention({ attentionId, response, responseType, idempotencyKey }) {
    requireId(attentionId, 'attentionId');
    requireId(response, 'response');
    requireId(responseType, 'responseType');
    const existing = this.getAttention(attentionId);
    if (!existing) throw new Error(`unknown Attention: ${attentionId}`);
    if (existing.status !== 'OPEN') return existing;
    const resolvedAt = this.#now();
    const resolved = {
      ...existing,
      status: 'RESOLVED',
      response,
      response_type: responseType,
      resolved_at: resolvedAt
    };
    const job = {
      job_id: idempotencyKey ?? `J-attention-${attentionId}`,
      workflow_run_id: existing.workflow_run_id,
      type: responseType,
      payload: { attention_id: attentionId, response }
    };
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        UPDATE attention SET status = 'RESOLVED', data_json = ?, resolved_at = ?
        WHERE attention_id = ? AND status = 'OPEN'
      `).run(JSON.stringify(resolved), resolvedAt, attentionId);
      this.enqueueJob(job);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return resolved;
  }

  listAttention({ openOnly = false } = {}) {
    const sql = openOnly
      ? "SELECT data_json FROM attention WHERE status = 'OPEN' ORDER BY created_at"
      : 'SELECT data_json FROM attention ORDER BY created_at';
    return this.#database.prepare(sql).all().map((row) => parseJson(row.data_json)).filter(Boolean);
  }

  enqueueJob(job) {
    const now = this.#now();
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO runtime_jobs (
        job_id, workflow_run_id, type, status, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?)
    `).run(
      requireId(job?.job_id, 'job.job_id'),
      requireId(job?.workflow_run_id, 'job.workflow_run_id'),
      requireId(job?.type, 'job.type'),
      JSON.stringify(job.payload ?? {}),
      now,
      now
    );
    return Number(result.changes) === 1;
  }

  #jobFromRow(row) {
    if (!row) return null;
    return {
      job_id: row.job_id,
      workflow_run_id: row.workflow_run_id,
      type: row.type,
      status: row.status,
      payload: parseJson(row.payload_json, {}),
      result: parseJson(row.result_json),
      owner_id: row.owner_id,
      lease_expires_at: row.lease_expires_at,
      attempts: row.attempts,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  getJob(jobId) {
    return this.#jobFromRow(this.#database.prepare('SELECT * FROM runtime_jobs WHERE job_id = ?').get(jobId));
  }

  listJobs({ status, limit = 100 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 100, 1_000));
    const rows = status
      ? this.#database.prepare('SELECT * FROM runtime_jobs WHERE status = ? ORDER BY created_at LIMIT ?').all(status, bounded)
      : this.#database.prepare('SELECT * FROM runtime_jobs ORDER BY created_at LIMIT ?').all(bounded);
    return rows.map((row) => this.#jobFromRow(row));
  }

  claimJob(jobId, ownerId, { ttlMs = 30_000 } = {}) {
    requireId(jobId, 'jobId');
    requireId(ownerId, 'ownerId');
    const now = this.#now();
    const expiresAt = new Date(Date.parse(now) + Math.max(100, Number(ttlMs) || 30_000)).toISOString();
    const result = this.#database.prepare(`
      UPDATE runtime_jobs SET
        status = 'RUNNING', owner_id = ?, lease_expires_at = ?,
        attempts = attempts + 1, updated_at = ?
      WHERE job_id = ?
        AND (status = 'PENDING' OR (status = 'RUNNING' AND lease_expires_at <= ?))
    `).run(ownerId, expiresAt, now, jobId, now);
    if (Number(result.changes) !== 1) return null;
    return this.getJob(jobId);
  }

  claimNextJob(ownerId, { ttlMs = 30_000 } = {}) {
    requireId(ownerId, 'ownerId');
    const now = this.#now();
    const expiresAt = new Date(Date.parse(now) + Math.max(100, Number(ttlMs) || 30_000)).toISOString();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare(`
        SELECT job_id FROM runtime_jobs
        WHERE status = 'PENDING' OR (status = 'RUNNING' AND lease_expires_at <= ?)
        ORDER BY created_at, job_id LIMIT 1
      `).get(now);
      if (!row) {
        this.#database.exec('COMMIT');
        return null;
      }
      const result = this.#database.prepare(`
        UPDATE runtime_jobs SET
          status = 'RUNNING', owner_id = ?, lease_expires_at = ?,
          attempts = attempts + 1, updated_at = ?
        WHERE job_id = ?
          AND (status = 'PENDING' OR (status = 'RUNNING' AND lease_expires_at <= ?))
      `).run(ownerId, expiresAt, now, row.job_id, now);
      this.#database.exec('COMMIT');
      return Number(result.changes) === 1 ? this.getJob(row.job_id) : null;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  renewJobLease(jobId, ownerId, { ttlMs = 30_000 } = {}) {
    const now = this.#now();
    const expiresAt = new Date(Date.parse(now) + Math.max(100, Number(ttlMs) || 30_000)).toISOString();
    const result = this.#database.prepare(`
      UPDATE runtime_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND owner_id = ? AND status = 'RUNNING' AND lease_expires_at > ?
    `).run(
      expiresAt, now, requireId(jobId, 'jobId'), requireId(ownerId, 'ownerId'), now
    );
    return Number(result.changes) === 1;
  }

  completeJob(jobId, result = {}, { ownerId } = {}) {
    const ownerClause = ownerId ? ' AND owner_id = ?' : '';
    const parameters = [JSON.stringify(result), this.#now(), requireId(jobId, 'jobId')];
    if (ownerId) parameters.push(requireId(ownerId, 'ownerId'));
    this.#database.prepare(`
      UPDATE runtime_jobs SET
        status = 'COMPLETED', result_json = ?, owner_id = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'RUNNING'${ownerClause}
    `).run(...parameters);
    return this.getJob(jobId);
  }

  failJob(jobId, error, { retry = false, ownerId } = {}) {
    const ownerClause = ownerId ? ' AND owner_id = ?' : '';
    const parameters = [retry ? 'PENDING' : 'FAILED', String(error), this.#now(), requireId(jobId, 'jobId')];
    if (ownerId) parameters.push(requireId(ownerId, 'ownerId'));
    this.#database.prepare(`
      UPDATE runtime_jobs SET
        status = ?, last_error = ?, owner_id = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'RUNNING'${ownerClause}
    `).run(...parameters);
    return this.getJob(jobId);
  }

  requeueRunningJobs(ownerId) {
    const result = this.#database.prepare(`
      UPDATE runtime_jobs SET status = 'PENDING', owner_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'RUNNING' AND owner_id = ?
    `).run(this.#now(), requireId(ownerId, 'ownerId'));
    return Number(result.changes);
  }

  acquireLease({ name, owner_id, pid, ttl_ms }) {
    requireId(name, 'lease.name');
    requireId(owner_id, 'lease.owner_id');
    const now = this.#now();
    const expiresAt = new Date(Date.parse(now) + Math.max(100, Number(ttl_ms) || 30_000)).toISOString();
    const result = this.#database.prepare(`
      INSERT INTO daemon_leases (name, owner_id, pid, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        owner_id = excluded.owner_id, pid = excluded.pid,
        heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at
      WHERE daemon_leases.owner_id = excluded.owner_id OR daemon_leases.expires_at <= excluded.heartbeat_at
    `).run(name, owner_id, Number(pid) || 0, now, expiresAt);
    return Number(result.changes) === 1;
  }

  renewLease({ name, owner_id, ttl_ms }) {
    const now = this.#now();
    const expiresAt = new Date(Date.parse(now) + Math.max(100, Number(ttl_ms) || 30_000)).toISOString();
    const result = this.#database.prepare(`
      UPDATE daemon_leases SET heartbeat_at = ?, expires_at = ?
      WHERE name = ? AND owner_id = ? AND expires_at > ?
    `).run(now, expiresAt, requireId(name, 'lease.name'), requireId(owner_id, 'lease.owner_id'), now);
    return Number(result.changes) === 1;
  }

  releaseLease({ name, owner_id }) {
    const result = this.#database.prepare('DELETE FROM daemon_leases WHERE name = ? AND owner_id = ?')
      .run(requireId(name, 'lease.name'), requireId(owner_id, 'lease.owner_id'));
    return Number(result.changes) === 1;
  }

  saveDecisionAudit(audit) {
    const stored = { ...audit, created_at: audit.created_at ?? this.#now() };
    this.#database.prepare(`
      INSERT INTO decision_audit (
        decision_id, workflow_run_id, attempt_id, provider, model, packet_hash,
        status, data_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requireId(stored.decision_id, 'decision.decision_id'),
      requireId(stored.workflow_run_id, 'decision.workflow_run_id'),
      stored.attempt_id ?? null,
      requireId(stored.provider, 'decision.provider'),
      requireId(stored.model, 'decision.model'),
      requireId(stored.packet_hash, 'decision.packet_hash'),
      requireId(stored.status, 'decision.status'),
      JSON.stringify(stored),
      stored.created_at
    );
    return stored;
  }

  getDecisionAudit(decisionId) {
    const row = this.#database.prepare('SELECT data_json FROM decision_audit WHERE decision_id = ?').get(decisionId);
    return parseJson(row?.data_json);
  }

  enqueueNotification({ notification_id, attention_id, transport, payload }) {
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO notification_deliveries (
        notification_id, attention_id, transport, status, payload_json, created_at
      ) VALUES (?, ?, ?, 'PENDING', ?, ?)
    `).run(
      requireId(notification_id, 'notification.notification_id'),
      requireId(attention_id, 'notification.attention_id'),
      requireId(transport, 'notification.transport'),
      JSON.stringify(payload ?? {}),
      this.#now()
    );
    return Number(result.changes) === 1;
  }

  #notificationFromRow(row) {
    if (!row) return null;
    return {
      notification_id: row.notification_id,
      attention_id: row.attention_id,
      transport: row.transport,
      status: row.status,
      payload: parseJson(row.payload_json, {}),
      attempts: row.attempts,
      last_error: row.last_error,
      created_at: row.created_at,
      delivered_at: row.delivered_at
    };
  }

  listNotificationDeliveries({ status, limit = 100 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 100, 1_000));
    const rows = status
      ? this.#database.prepare('SELECT * FROM notification_deliveries WHERE status = ? ORDER BY created_at LIMIT ?').all(status, bounded)
      : this.#database.prepare('SELECT * FROM notification_deliveries ORDER BY created_at LIMIT ?').all(bounded);
    return rows.map((row) => this.#notificationFromRow(row));
  }

  markNotificationDelivered(notificationId) {
    this.#database.prepare(`
      UPDATE notification_deliveries
      SET status = 'DELIVERED', attempts = attempts + 1, delivered_at = ?, last_error = NULL
      WHERE notification_id = ? AND status = 'PENDING'
    `).run(this.#now(), requireId(notificationId, 'notificationId'));
  }

  markNotificationFailed(notificationId, error) {
    this.#database.prepare(`
      UPDATE notification_deliveries SET attempts = attempts + 1, last_error = ?
      WHERE notification_id = ? AND status = 'PENDING'
    `).run(String(error), requireId(notificationId, 'notificationId'));
  }

  recordExternalDelivery({ source, delivery_id, payload_hash, event_type }) {
    const existing = this.#database.prepare(`
      SELECT payload_hash, event_type FROM external_deliveries WHERE source = ? AND delivery_id = ?
    `).get(requireId(source, 'delivery.source'), requireId(delivery_id, 'delivery.delivery_id'));
    if (existing) {
      return existing.payload_hash === payload_hash && existing.event_type === event_type
        ? 'duplicate'
        : 'collision';
    }
    this.#database.prepare(`
      INSERT INTO external_deliveries (source, delivery_id, payload_hash, event_type, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(source, delivery_id, requireId(payload_hash, 'delivery.payload_hash'), requireId(event_type, 'delivery.event_type'), this.#now());
    return 'inserted';
  }

  saveWorkflowNode(node) {
    this.#database.prepare(`
      INSERT INTO workflow_nodes (
        workflow_run_id, node_id, status, task_json, depends_json, result_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_run_id, node_id) DO UPDATE SET
        status = excluded.status, task_json = excluded.task_json,
        depends_json = excluded.depends_json, result_json = excluded.result_json,
        updated_at = excluded.updated_at
    `).run(
      requireId(node.workflow_run_id, 'node.workflow_run_id'),
      requireId(node.node_id, 'node.node_id'),
      requireId(node.status, 'node.status'),
      JSON.stringify(node.task ?? {}),
      JSON.stringify(node.depends_on ?? []),
      node.result === undefined ? null : JSON.stringify(node.result),
      this.#now()
    );
  }

  listWorkflowNodes(workflowRunId) {
    return this.#database.prepare(`
      SELECT * FROM workflow_nodes WHERE workflow_run_id = ? ORDER BY node_id
    `).all(requireId(workflowRunId, 'workflowRunId')).map((row) => ({
      workflow_run_id: row.workflow_run_id,
      node_id: row.node_id,
      status: row.status,
      task: parseJson(row.task_json, {}),
      depends_on: parseJson(row.depends_json, []),
      result: parseJson(row.result_json)
    }));
  }

  saveRemoteRunnerJob(job) {
    this.#database.prepare(`
      INSERT INTO remote_runner_jobs (
        runner_job_id, workflow_run_id, status, task_json, generation, token, updated_at
      ) VALUES (?, ?, 'PENDING', ?, ?, ?, ?)
    `).run(
      requireId(job.runner_job_id, 'runner.runner_job_id'),
      requireId(job.workflow_run_id, 'runner.workflow_run_id'),
      JSON.stringify(job.task ?? {}),
      job.generation,
      requireId(job.token, 'runner.token'),
      this.#now()
    );
  }

  getRemoteRunnerJob(jobId) {
    const row = this.#database.prepare('SELECT * FROM remote_runner_jobs WHERE runner_job_id = ?').get(jobId);
    if (!row) return null;
    return {
      runner_job_id: row.runner_job_id, workflow_run_id: row.workflow_run_id,
      status: row.status, task: parseJson(row.task_json, {}), generation: row.generation,
      token: row.token, runner_id: row.runner_id, lease_expires_at: row.lease_expires_at,
      result: parseJson(row.result_json)
    };
  }

  claimRemoteRunnerJob(runnerId, expiresAt, now = this.#now(), recoveryToken = null) {
    const row = this.#database.prepare(`
      SELECT runner_job_id FROM remote_runner_jobs
      WHERE status = 'PENDING' OR (status = 'LEASED' AND lease_expires_at <= ?)
      ORDER BY updated_at LIMIT 1
    `).get(now);
    if (!row) return null;
    const result = this.#database.prepare(`
      UPDATE remote_runner_jobs SET
        generation = CASE WHEN status = 'LEASED' THEN generation + 1 ELSE generation END,
        token = CASE WHEN status = 'LEASED' THEN ? ELSE token END,
        status = 'LEASED', runner_id = ?, lease_expires_at = ?, updated_at = ?
      WHERE runner_job_id = ?
        AND (status = 'PENDING' OR (status = 'LEASED' AND lease_expires_at <= ?))
    `).run(
      recoveryToken ?? '', requireId(runnerId, 'runnerId'), expiresAt,
      this.#now(), row.runner_job_id, now
    );
    return Number(result.changes) === 1 ? this.getRemoteRunnerJob(row.runner_job_id) : null;
  }

  heartbeatRemoteRunnerJob(jobId, runnerId, expiresAt) {
    const result = this.#database.prepare(`
      UPDATE remote_runner_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE runner_job_id = ? AND runner_id = ? AND status = 'LEASED'
    `).run(expiresAt, this.#now(), requireId(jobId, 'jobId'), requireId(runnerId, 'runnerId'));
    return Number(result.changes) === 1;
  }

  completeRemoteRunnerJob(jobId, result) {
    this.#database.prepare(`
      UPDATE remote_runner_jobs SET status = 'COMPLETED', result_json = ?, lease_expires_at = NULL, updated_at = ?
      WHERE runner_job_id = ? AND status = 'LEASED'
    `).run(JSON.stringify(result), this.#now(), requireId(jobId, 'jobId'));
    return this.getRemoteRunnerJob(jobId);
  }

  upsertSchedule({ schedule_id, every_ms, task, next_at }) {
    this.#database.prepare(`
      INSERT INTO schedules (schedule_id, every_ms, task_json, next_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(schedule_id) DO UPDATE SET
        every_ms = excluded.every_ms, task_json = excluded.task_json,
        next_at = excluded.next_at, updated_at = excluded.updated_at
    `).run(requireId(schedule_id, 'schedule.schedule_id'), every_ms, JSON.stringify(task ?? {}), next_at, this.#now());
  }

  listDueSchedules(now) {
    return this.#database.prepare('SELECT * FROM schedules WHERE next_at <= ? ORDER BY next_at')
      .all(now).map((row) => ({
        schedule_id: row.schedule_id, every_ms: row.every_ms,
        task: parseJson(row.task_json, {}), next_at: row.next_at
      }));
  }

  createScheduleOccurrence({ occurrence_id, schedule_id, due_at, task, next_at }) {
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO schedule_occurrences (
        occurrence_id, schedule_id, due_at, task_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(occurrence_id, schedule_id, due_at, JSON.stringify(task ?? {}), this.#now());
    this.#database.prepare('UPDATE schedules SET next_at = ?, updated_at = ? WHERE schedule_id = ?')
      .run(next_at, this.#now(), schedule_id);
    return Number(result.changes) === 1;
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
