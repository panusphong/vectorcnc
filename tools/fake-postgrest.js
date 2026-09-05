'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  fake-postgrest.js — ตัวจำลอง PostgREST สำหรับ "ทดสอบเท่านั้น"
 *
 *  ของจริงบน Supabase คือ PostgREST — ตัวนี้แปลง request แบบเดียวกัน
 *  ให้เป็น SQL เพื่อให้ทดสอบระบบทั้งก้อนได้บนเครื่องโดยไม่ต้องต่อเน็ต
 *
 *  ‼ ห้ามใช้ใน production เด็ดขาด (ไม่มี auth ไม่มี RLS)
 * ═══════════════════════════════════════════════════════════════════ */
const express = require('express');
const { Client } = require('pg');

/** แปลงตัวกรองแบบ PostgREST (eq.x, ilike.x, is.null) เป็น SQL */
function toSql(col, raw, params) {
  const i = String(raw).indexOf('.');
  const op = i < 0 ? 'eq' : String(raw).slice(0, i);
  const val = i < 0 ? raw : String(raw).slice(i + 1);
  const q = `"${col.replace(/"/g, '')}"`;

  if (op === 'is') return `${q} is ${val === 'null' ? 'null' : val}`;
  if (op === 'ilike') { params.push(val); return `${q} ilike $${params.length}`; }
  if (op === 'like')  { params.push(val); return `${q} like $${params.length}`; }
  if (op === 'in')    { params.push(val.replace(/^\(|\)$/g, '').split(',')); return `${q} = any($${params.length})`; }
  const map = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  params.push(val === 'null' ? null : val);
  return `${q} ${map[op] || '='} $${params.length}`;
}

async function start(pgUrl, port) {
  const client = new Client({ connectionString: pgUrl });
  await client.connect();

  const app = express();
  app.use(express.json());

  const schemaOf = req =>
    req.headers['content-profile'] || req.headers['accept-profile'] || 'app';

  const RESERVED = new Set(['select', 'limit', 'offset', 'order', 'on_conflict']);

  /* เรียก stored function — PostgREST ใช้ POST /rest/v1/rpc/<ชื่อฟังก์ชัน>
   * ต้องประกาศก่อน route ของตาราง ไม่งั้น 'rpc' จะถูกมองว่าเป็นชื่อตาราง */
  app.post('/rest/v1/rpc/:fn', async (req, res) => {
    const schema = schemaOf(req);
    const args = req.body || {};
    const names = Object.keys(args);
    const values = names.map(k => args[k]);
    const call = names.map((k, i) => `"${k.replace(/"/g, '')}" => $${i + 1}`).join(', ');
    try {
      const r = await client.query(
        `select "${schema}"."${req.params.fn.replace(/"/g, '')}"(${call}) as v`, values);
      // ฟังก์ชันที่คืนค่าเดี่ยว PostgREST ส่งค่านั้นตรง ๆ ไม่ห่อ array
      res.json(r.rows.length === 1 ? r.rows[0].v : r.rows.map(x => x.v));
    } catch (e) {
      res.status(400).json({ message: e.message, code: e.code });
    }
  });

  app.all('/rest/v1/:table', async (req, res) => {
    const table = `"${schemaOf(req)}"."${req.params.table.replace(/"/g, '')}"`;
    const params = [];
    const where = Object.entries(req.query)
      .filter(([k]) => !RESERVED.has(k))
      .map(([k, v]) => toSql(k, v, params));
    const whereSql = where.length ? ' where ' + where.join(' and ') : '';

    try {
      let sql, result;

      if (req.method === 'GET') {
        const cols = req.query.select && req.query.select !== '*' && req.query.select !== 'count'
          ? req.query.select.split(',').map(c => `"${c.trim()}"`).join(',')
          : '*';
        sql = `select ${cols} from ${table}${whereSql}`;
        if (req.query.order) {
          const [c, d] = String(req.query.order).split('.');
          sql += ` order by "${c}" ${d === 'desc' ? 'desc' : 'asc'}`;
        }
        /* ‼ เลียนแบบ Supabase ให้ตรงของจริง: ตัดที่ 1,000 แถวเสมอ
         *   ของจริงตัดเงียบ ๆ ไม่บอกว่าตัด — คืนมา 1,000 แถวเหมือนมีแค่นั้น
         *   ถ้าตัวจำลองไม่ตัดด้วย บั๊กแบบ "อ่านไม่ครบแล้ว insert ทับ"
         *   จะผ่านเทสต์หมดแล้วไปพังเอาตอนขึ้นของจริง (เกิดมาแล้ว 4 ก.ย. 69) */
        const MAX_ROWS = 1000;
        const want = req.query.limit ? parseInt(req.query.limit, 10) : MAX_ROWS;
        sql += ` limit ${Math.min(want, MAX_ROWS)}`;
        if (req.query.offset) sql += ` offset ${parseInt(req.query.offset, 10)}`;
        result = await client.query(sql, params);

        // รองรับการนับแบบ Prefer: count=exact
        if (String(req.headers.prefer || '').includes('count=exact')) {
          const c = await client.query(`select count(*)::int n from ${table}${whereSql}`, params);
          res.setHeader('Content-Range', `0-0/${c.rows[0].n}`);
        }
        return res.json(result.rows);
      }

      if (req.method === 'POST') {
        const body = Array.isArray(req.body) ? req.body : [req.body];
        const keys = Object.keys(body[0]);
        const vals = [];
        const tuples = body.map(row =>
          '(' + keys.map(k => { vals.push(row[k]); return '$' + vals.length; }).join(',') + ')'
        );
        sql = `insert into ${table} (${keys.map(k => `"${k}"`).join(',')}) values ${tuples.join(',')} returning *`;
        result = await client.query(sql, vals);
        return res.status(201).json(result.rows);
      }

      if (req.method === 'PATCH') {
        const keys = Object.keys(req.body);
        const sets = keys.map(k => { params.push(req.body[k]); return `"${k}"=$${params.length}`; });
        sql = `update ${table} set ${sets.join(',')}${whereSql} returning *`;
        result = await client.query(sql, params);
        return res.json(result.rows);
      }

      if (req.method === 'DELETE') {
        result = await client.query(`delete from ${table}${whereSql} returning *`, params);
        return res.json(result.rows);
      }

      res.status(405).json({ message: 'method not allowed' });
    } catch (e) {
      res.status(400).json({ message: e.message, code: e.code });
    }
  });

  app.get('/rest/v1/', (_q, s) => s.json({ ok: true }));

  return new Promise(resolve => {
    const srv = app.listen(port, () => resolve({
      srv,
      close: async () => { srv.close(); await client.end(); },
    }));
  });
}

module.exports = { start };
