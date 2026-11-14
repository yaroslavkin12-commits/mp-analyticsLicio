const { query, getPool } = require('../db');
const MAX_GAP_SECONDS = 75;
const IDLE_SECONDS = 300;
let ready;
function ensure() {
  if (!ready) ready = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS app_access_logins (
      id BIGSERIAL PRIMARY KEY, user_id INT REFERENCES app_users(id) ON DELETE SET NULL,
      login VARCHAR(64) NOT NULL, name VARCHAR(128), session_hash CHAR(64) NOT NULL,
      logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), logged_out_at TIMESTAMPTZ, source VARCHAR(24) NOT NULL DEFAULT 'user')`);
    await query(`ALTER TABLE app_access_logins ADD COLUMN IF NOT EXISTS source VARCHAR(24) NOT NULL DEFAULT 'user'`);
    await query(`CREATE TABLE IF NOT EXISTS app_access_visits (
      id UUID PRIMARY KEY, user_id INT REFERENCES app_users(id) ON DELETE SET NULL,
      login VARCHAR(64) NOT NULL, name VARCHAR(128), session_hash CHAR(64) NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ, active_seconds INT NOT NULL DEFAULT 0, was_active BOOLEAN NOT NULL DEFAULT false,
      page VARCHAR(64), cabinet VARCHAR(32))`);
    await query(`CREATE TABLE IF NOT EXISTS app_access_spans (
      id BIGSERIAL PRIMARY KEY, visit_id UUID NOT NULL REFERENCES app_access_visits(id) ON DELETE CASCADE,
      user_id INT REFERENCES app_users(id) ON DELETE SET NULL, login VARCHAR(64) NOT NULL,
      start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL, CHECK (end_at > start_at))`);
    await query(`CREATE INDEX IF NOT EXISTS app_access_visits_start ON app_access_visits(started_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS app_access_spans_time ON app_access_spans(start_at, end_at)`);
    await query(`CREATE INDEX IF NOT EXISTS app_access_login_time ON app_access_logins(logged_in_at DESC)`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}
function activeSlice(previous, now, input) {
  const prev = new Date(previous.last_seen_at).getTime(), end = new Date(now).getTime();
  const gap = (end - prev) / 1000;
  if (!previous.was_active || gap <= 0 || gap > MAX_GAP_SECONDS) return null;
  const age = Math.max(0, Math.min(86400, Number(input.idleSeconds)));
  if (!Number.isFinite(age)) return null;
  const until = Math.min(end, end + (IDLE_SECONDS - age) * 1000);
  const seconds = Math.max(0, Math.floor((until - prev) / 1000));
  return seconds ? { start: new Date(prev).toISOString(), end: new Date(prev + seconds * 1000).toISOString(), seconds } : null;
}
const validVisit = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function cleanInput(body = {}) {
  if (!validVisit(body.visitId)) return null;
  const idleSeconds = Number(body.idleSeconds);
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0 || idleSeconds > 86400) return null;
  return { visitId: body.visitId, idleSeconds, visible: body.visible === true, close: body.close === true,
    page: typeof body.page === 'string' ? body.page.slice(0, 64) : '',
    cabinet: typeof body.cabinet === 'string' ? body.cabinet.slice(0, 32) : '' };
}
async function recordLogin(userId, sessionHash, internal = false) {
  await ensure();
  await query(`INSERT INTO app_access_logins (user_id, login, name, session_hash, source)
    SELECT id, login, name, $2, $3 FROM app_users WHERE id = $1`, [userId, sessionHash, internal ? 'service-check' : 'user']);
}
async function heartbeat(user, sessionHash, input) {
  await ensure();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO app_access_visits (id, user_id, login, name, session_hash, was_active, page, cabinet)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
    [input.visitId, user.id, user.login, user.name || user.login, sessionHash,
      input.visible && input.idleSeconds < IDLE_SECONDS && !input.close, input.page, input.cabinet]);
    const result = await client.query(`SELECT * FROM app_access_visits WHERE id = $1 FOR UPDATE`, [input.visitId]);
    const visit = result.rows[0];
    if (!visit || Number(visit.user_id) !== Number(user.id) || visit.session_hash !== sessionHash) {
      const error = Error('Это посещение принадлежит другой сессии'); error.status = 403; throw error;
    }
    if (!visit.ended_at) {
      const { rows: clock } = await client.query('SELECT clock_timestamp() AS server_now');
      const now = clock[0].server_now;
      const span = activeSlice(visit, now, input);
      if (span) await client.query(`INSERT INTO app_access_spans (visit_id, user_id, login, start_at, end_at) VALUES ($1,$2,$3,$4,$5)`, [input.visitId, user.id, user.login, span.start, span.end]);
      await client.query(`UPDATE app_access_visits SET last_seen_at=$2, active_seconds=active_seconds+$3,
        was_active=$4, page=$5, cabinet=$6, ended_at=CASE WHEN $7 THEN $2 ELSE NULL END WHERE id=$1`,
      [input.visitId, now, span?.seconds || 0, input.visible && input.idleSeconds < IDLE_SECONDS && !input.close, input.page, input.cabinet, input.close]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function closeSession(hash) {
  await ensure();
  await query(`UPDATE app_access_visits SET ended_at=LEAST(NOW(),last_seen_at+INTERVAL '75 seconds'), was_active=false WHERE session_hash=$1 AND ended_at IS NULL`, [hash]);
  await query('UPDATE app_access_logins SET logged_out_at=NOW() WHERE session_hash=$1 AND logged_out_at IS NULL', [hash]);
}
function period(input = {}) {
  const now = Date.now();
  const from = input.from ? new Date(input.from).getTime() : now - 7 * 86400000;
  const to = input.to ? new Date(input.to).getTime() : now;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 93 * 86400000) throw Object.assign(Error('Выберите период до 93 дней'), { status: 400 });
  return [new Date(from).toISOString(), new Date(to).toISOString()];
}
async function report(input) {
  await ensure();
  const [from, to] = period(input);
  // Объединяем пересекающиеся интервалы: несколько вкладок не умножают время.
  const summary = await query(`WITH clipped AS (
      SELECT login, tstzrange(GREATEST(start_at,$1::timestamptz),LEAST(end_at,$2::timestamptz),'[)') AS span
      FROM app_access_spans WHERE start_at < $2 AND end_at > $1
    ), merged AS (SELECT login, range_agg(span) AS spans FROM clipped GROUP BY login),
    active AS (SELECT login, SUM(EXTRACT(EPOCH FROM upper(r)-lower(r)))::bigint AS active_seconds
      FROM merged CROSS JOIN LATERAL unnest(spans) AS r GROUP BY login),
    visits AS (SELECT login, MAX(name) AS name, COUNT(*)::int AS visits,
      MIN(GREATEST(started_at,$1::timestamptz)) AS first_seen,
      MAX(LEAST(last_seen_at,$2::timestamptz)) AS last_seen,
      BOOL_OR(was_active AND ended_at IS NULL AND last_seen_at > NOW()-INTERVAL '75 seconds') AS online
      FROM app_access_visits WHERE started_at < $2 AND COALESCE(ended_at,last_seen_at) >= $1 GROUP BY login)
    SELECT v.*, COALESCE(a.active_seconds,0)::bigint AS active_seconds FROM visits v LEFT JOIN active a USING(login) ORDER BY last_seen DESC`, [from, to]);
  const visits = await query(`SELECT v.id, v.login, v.name, v.started_at, v.last_seen_at, v.ended_at, v.was_active,
      COALESCE((SELECT SUM(EXTRACT(EPOCH FROM LEAST(s.end_at,$2::timestamptz)-GREATEST(s.start_at,$1::timestamptz)))
        FROM app_access_spans s WHERE s.visit_id=v.id AND s.start_at < $2 AND s.end_at > $1),0)::bigint AS active_seconds,
      GREATEST(0,EXTRACT(EPOCH FROM LEAST(COALESCE(v.ended_at,LEAST(NOW(),v.last_seen_at+INTERVAL '75 seconds')),$2::timestamptz)-GREATEST(v.started_at,$1::timestamptz)))::bigint AS duration_seconds,
      v.page, v.cabinet, (v.ended_at IS NULL AND v.last_seen_at > NOW()-INTERVAL '75 seconds') AS online
    FROM app_access_visits v WHERE v.started_at < $2 AND COALESCE(v.ended_at,v.last_seen_at) >= $1 ORDER BY v.started_at DESC LIMIT 200`, [from, to]);
  const logins = await query(`SELECT id, login, name, logged_in_at, logged_out_at, source FROM app_access_logins
    WHERE logged_in_at >= $1 AND logged_in_at < $2 ORDER BY logged_in_at DESC LIMIT 200`, [from, to]);
  return { from, to, idleMinutes: IDLE_SECONDS / 60, limit: 200, summary, visits, logins };
}
module.exports = { ensure, activeSlice, validVisit, cleanInput, recordLogin, heartbeat, closeSession, period, report };
