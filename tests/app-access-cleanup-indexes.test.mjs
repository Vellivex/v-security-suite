import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAppAccess } from '../server/app-access/core.mjs';

const schema = readFileSync(new URL('../server/app-access/schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../server/app-access/migrations/20261113-expiry-indexes.sql', import.meta.url), 'utf8');
const additions = [
  'CREATE INDEX IF NOT EXISTS va_email_state_expiry ON va_email_state(expires_at);',
  'CREATE INDEX IF NOT EXISTS va_handoff_parent ON va_handoffs(sso_hash);'
];
const oldSchema = additions.reduce((text, sql) => text.replace(sql, ''), schema);
const now = 1_000_000;
const tables = ['va_users', 'va_flows', 'va_logout_flows', 'va_email_state', 'va_email_challenges', 'va_sso_sessions', 'va_handoffs', 'va_app_sessions', 'va_limits', 'va_mail_budget'];

// Capture the actual cleanup statements through the production request handler.
// The adapter only collects SQL; it never reads a remote database or sends mail.
async function cleanupStatements() {
  let statements;
  const db = {
    prepare(sql) { return { bind(...args) { return { sql, args, async first() { return { hits: 1 }; }, async run() { return {}; } }; } }; },
    async batch(batch) { statements = batch; return batch.map(() => ({ results: [] })); }
  };
  const token = Buffer.alloc(32, 1).toString('base64url');
  const response = await createAppAccess({ now: () => now, sendMail: async () => { throw Error('Unexpected email'); } }).fetch(
    new Request('https://app-access.internal/__app_access/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.30' },
      body: JSON.stringify({ audience: 'https://www.vellivex.com', returnPath: '/apps/vault', state: token, verifierHash: token })
    }), { ACCOUNTS_DB: db, VELLIVEX_ACCOUNT_KEY: token });
  assert.equal(response.status, 200);
  assert.equal(statements?.length, 9);
  return statements;
}

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(oldSchema);
  db.exec('BEGIN');
  const user = db.prepare('INSERT INTO va_users(id,email_index,email_cipher,created_at,verified_at) VALUES(?,?,?,?,?)');
  for (let i = 0; i < 8; i++) user.run(`user-${i}`, `email-${i}`, `fixture-cipher-${i}`, 1, 1);
  const sso = db.prepare('INSERT INTO va_sso_sessions(token_hash,user_id,epoch,created_at,expires_at) VALUES(?,?,1,1,?)');
  for (let i = 0; i < 500; i++) sso.run(`sso-${i}`, `user-${i % 8}`, i % 47 === 0 ? now : now + 100000);
  const handoff = db.prepare('INSERT INTO va_handoffs(code_hash,flow_id,sso_hash,user_id,epoch,audience,return_path,state,verifier_hash,created_at,expires_at) VALUES(?,?,?,?,1,?,?,?,?,1,?)');
  const app = db.prepare('INSERT INTO va_app_sessions(token_hash,sso_hash,user_id,epoch,audience,created_at,expires_at) VALUES(?,?,?,1,?,1,?)');
  for (let i = 0; i < 1500; i++) {
    handoff.run(`handoff-${i}`, `flow-${i}`, `sso-${i % 500}`, `user-${i % 8}`, 'https://www.vellivex.com', '/apps/vault', 'fixture-state', 'fixture-verifier', i % 71 === 0 ? now - 1 : now + 100000);
    app.run(`app-${i}`, `sso-${i % 500}`, `user-${i % 8}`, 'https://www.vellivex.com', i % 73 === 0 ? now : now + 100000);
  }
  const email = db.prepare('INSERT INTO va_email_state(email_index,latest_challenge,last_requested_at,expires_at) VALUES(?,?,1,?)');
  for (let i = 0; i < 2000; i++) email.run(`email-state-${i}`, `challenge-${i}`, i % 83 === 0 ? now : now + 100000);
  for (const expires of [now - 1, now, now + 1]) {
    db.prepare('INSERT INTO va_flows(id,audience,return_path,state,verifier_hash,created_at,expires_at) VALUES(?,?,?,?,?,1,?)').run(`flow-${expires}`, 'https://www.vellivex.com', '/apps/vault', 'fixture-state', 'fixture-verifier', expires);
    db.prepare('INSERT INTO va_logout_flows(id,browser_hash,sso_hash,expires_at) VALUES(?,?,?,?)').run(`logout-${expires}`, 'fixture-browser', 'fixture-sso', expires);
    db.prepare('INSERT INTO va_email_challenges(id,flow_id,browser_hash,email_index,email_cipher,code_mac,updates_opt_in,delivery,created_at,expires_at) VALUES(?,?,?,?,?,?,0,\'sent\',1,?)').run(`challenge-${expires}`, 'fixture-flow', 'fixture-browser', 'fixture-email', 'fixture-cipher', 'fixture-mac', expires);
    db.prepare('INSERT INTO va_limits(key,hits,expires_at) VALUES(?,1,?)').run(`limit-${expires}`, expires);
  }
  db.prepare('INSERT INTO va_mail_budget(key,sent,expires_at) VALUES(?,1,?)').run('d:fixture', now);
  db.prepare('INSERT INTO va_mail_budget(key,sent,expires_at) VALUES(?,1,?)').run('m:fixture', now + 100000);
  db.exec('COMMIT'); return db;
}
function rows(db) { return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])); }
function plans(db, statement) { return db.prepare('EXPLAIN QUERY PLAN ' + statement.sql).all(...statement.args).map(row => row.detail); }
function applyCleanup(db, statements) {
  db.exec('BEGIN');
  try { for (const statement of statements) db.prepare(statement.sql).run(...statement.args); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('expiry index migration is additive and repeatable without changing stored rows', () => {
  const db = fixture(), before = rows(db);
  const indexes = () => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all();
  const original = indexes(); db.exec(migration); const once = indexes(); db.exec(migration);
  assert.deepEqual(indexes(), once); assert.deepEqual(rows(db), before);
  assert.deepEqual(once.filter(item => !original.some(old => old.name === item.name)).map(item => item.name), ['va_email_state_expiry', 'va_handoff_parent']);
  assert.deepEqual(db.prepare("PRAGMA index_info('va_email_state_expiry')").all().map(row => row.name), ['expires_at']);
  assert.deepEqual(db.prepare("PRAGMA index_info('va_handoff_parent')").all().map(row => row.name), ['sso_hash']);
  db.close();
});

test('actual cleanup and parent cascade plans avoid full email-state and handoff scans after migration', async () => {
  const db = fixture(), cleanup = await cleanupStatements();
  const email = cleanup.find(item => item.sql.startsWith('DELETE FROM va_email_state '));
  const handoff = cleanup.find(item => item.sql.startsWith('DELETE FROM va_handoffs '));
  const sso = cleanup.find(item => item.sql.startsWith('DELETE FROM va_sso_sessions '));
  assert(plans(db, email).some(detail => /^SCAN va_email_state\b/.test(detail)));
  assert(plans(db, handoff).some(detail => /^SCAN va_handoffs\b/.test(detail)));
  assert(plans(db, sso).some(detail => /^SCAN va_handoffs\b/.test(detail)));
  db.exec(migration);
  assert(plans(db, email).some(detail => /USING INDEX va_email_state_expiry/.test(detail)));
  const handoffPlan = plans(db, handoff).join('\n');
  assert.match(handoffPlan, /MULTI-INDEX OR/); assert.match(handoffPlan, /va_handoff_expiry/); assert.match(handoffPlan, /va_handoff_parent/);
  assert(!plans(db, handoff).some(detail => /^SCAN va_handoffs\b/.test(detail)));
  assert(!plans(db, sso).some(detail => /^SCAN va_handoffs\b/.test(detail)));
  assert(plans(db, sso).some(detail => /USING COVERING INDEX va_handoff_parent/.test(detail)));
  db.close();
});

test('indexed cleanup preserves identical results across expiry boundaries and parent cascades', async () => {
  const baseline = fixture(), indexed = fixture(), statements = await cleanupStatements();
  const leaseKey = statements.find(item => item.sql.includes('AND key<>?')).args[1];
  for (const db of [baseline, indexed]) db.prepare('INSERT INTO va_limits(key,hits,expires_at) VALUES(?,1,?)').run(leaseKey, now - 1);
  indexed.exec(migration);
  applyCleanup(baseline, statements); applyCleanup(indexed, statements);
  assert.deepEqual(rows(indexed), rows(baseline));
  assert.equal(indexed.prepare('SELECT count(*) AS n FROM va_users').get().n, 8);
  assert.equal(indexed.prepare('SELECT count(*) AS n FROM va_email_state').get().n, 1975);
  assert.equal(indexed.prepare('SELECT count(*) AS n FROM va_sso_sessions WHERE expires_at<=?').get(now).n, 0);
  assert.equal(indexed.prepare('SELECT count(*) AS n FROM va_handoffs WHERE expires_at<=?').get(now).n, 0);
  assert(indexed.prepare('SELECT key FROM va_limits WHERE key=?').get(leaseKey));
  assert.deepEqual(indexed.prepare('PRAGMA foreign_key_check').all(), []);
  baseline.close(); indexed.close();
});

test('fresh schema and existing-database migration install the same two indexes', () => {
  const fresh = new DatabaseSync(':memory:'), migrated = new DatabaseSync(':memory:');
  fresh.exec(schema); migrated.exec(oldSchema); migrated.exec(migration);
  const definition = db => db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all();
  assert.deepEqual(definition(fresh), definition(migrated));
  for (const statement of additions) assert.equal(schema.split(statement).length - 1, 1);
  fresh.close(); migrated.close();
});
