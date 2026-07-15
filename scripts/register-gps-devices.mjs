import { readFileSync } from 'fs';
import pg from 'pg';
import { randomUUID } from 'crypto';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .filter((l) => !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function deviceIdForCode(boatCode) {
  return `gps-${String(boatCode).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

const client = await pool.connect();
try {
  await client.query('begin');

  const upd = await client.query(`
    update gps_devices d
    set device_id = 'gps-wb-005', updated_at = now()
    from boats b
    where d.boat_id = b.boat_id
      and b.boat_code = 'WB_005'
      and d.device_id = 'WB_005'
    returning d.gps_device_id, d.device_id, b.boat_code
  `);
  console.log('updated WB_005', upd.rows);

  const boats = await client.query(`
    select boat_id, boat_code
    from boats
    where boat_code ~ '^WB_00[1-7]$'
    order by boat_code
  `);

  for (const boat of boats.rows) {
    const want = deviceIdForCode(boat.boat_code);
    const existing = await client.query(
      'select gps_device_id, device_id, is_active from gps_devices where boat_id = $1',
      [boat.boat_id],
    );
    if (!existing.rows.length) {
      const ins = await client.query(
        `
        insert into gps_devices (gps_device_id, device_id, boat_id, is_active, created_at, updated_at)
        values ($1, $2, $3, true, now(), now())
        returning device_id, boat_id
      `,
        [randomUUID(), want, boat.boat_id],
      );
      console.log('inserted', boat.boat_code, ins.rows[0]);
      continue;
    }
    const row = existing.rows[0];
    if (row.device_id !== want || !row.is_active) {
      const u = await client.query(
        `
        update gps_devices
        set device_id = $1, is_active = true, updated_at = now()
        where gps_device_id = $2
        returning device_id
      `,
        [want, row.gps_device_id],
      );
      console.log('normalized', boat.boat_code, row.device_id, '->', u.rows[0].device_id);
    } else {
      console.log('ok', boat.boat_code, row.device_id);
    }
  }

  await client.query('commit');
  const final = await client.query(`
    select b.boat_code, d.device_id, d.is_active
    from gps_devices d
    join boats b on b.boat_id = d.boat_id
    where b.boat_code like 'WB_%'
    order by b.boat_code
  `);
  console.log('FINAL', final.rows);
} catch (error) {
  await client.query('rollback');
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
