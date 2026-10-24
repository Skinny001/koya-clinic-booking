const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');

// Determine if we should use PostgreSQL (via DATABASE_URL) or local SQLite
const isPostgres = Boolean(process.env.DATABASE_URL);

let sqliteDb = null;
let pgPool = null;

if (isPostgres) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
} else {
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'clinic.db');
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
}

// Initialize tables and indexes
async function initDb() {
  if (isPostgres) {
    const client = await pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS slots (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          start TIMESTAMPTZ NOT NULL,
          "end" TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bookings (
          id TEXT PRIMARY KEY,
          slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );

        -- Strict concurrency protection: only one confirmed booking allowed per slot
        CREATE UNIQUE INDEX IF NOT EXISTS idx_confirmed_slot 
        ON bookings(slot_id) WHERE status = 'confirmed';

        CREATE INDEX IF NOT EXISTS idx_bookings_email_created 
        ON bookings(email, created_at);

        CREATE TABLE IF NOT EXISTS idempotency (
          key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          response_body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS attempts (
          email TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attempts_email_time ON attempts(email, created_at);
      `);
    } finally {
      client.release();
    }
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS slots (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        slot_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Strict concurrency protection: only one confirmed booking allowed per slot
      CREATE UNIQUE INDEX IF NOT EXISTS idx_confirmed_slot 
      ON bookings(slot_id) WHERE status = 'confirmed';

      CREATE INDEX IF NOT EXISTS idx_bookings_email_created 
      ON bookings(email, created_at);

      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attempts (
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_email_time ON attempts(email, created_at);
    `);

    // Auto-seed default upcoming consultation slots if database is empty
    const slotCount = sqliteDb.prepare('SELECT COUNT(*) as cnt FROM slots').get();
    if (slotCount && slotCount.cnt === 0) {
      const now = Date.now();
      const day = 86400000;
      const defaultSlots = [
        { id: 'slot_cardio_1', provider: 'Dr. Sarah Johnson', start: new Date(now + day + 3600000 * 9).toISOString(), end: new Date(now + day + 3600000 * 9.5).toISOString() },
        { id: 'slot_cardio_2', provider: 'Dr. Sarah Johnson', start: new Date(now + day + 3600000 * 14).toISOString(), end: new Date(now + day + 3600000 * 14.5).toISOString() },
        { id: 'slot_peds_1', provider: 'Dr. Tunde Bakare', start: new Date(now + day + 3600000 * 10).toISOString(), end: new Date(now + day + 3600000 * 10.5).toISOString() },
        { id: 'slot_peds_2', provider: 'Dr. Tunde Bakare', start: new Date(now + day + 3600000 * 15.5).toISOString(), end: new Date(now + day + 3600000 * 16).toISOString() },
        { id: 'slot_gp_1', provider: 'Dr. Fatima Bello', start: new Date(now + day + 3600000 * 11.5).toISOString(), end: new Date(now + day + 3600000 * 12).toISOString() },
        { id: 'slot_gp_2', provider: 'Dr. Fatima Bello', start: new Date(now + day * 2 + 3600000 * 10).toISOString(), end: new Date(now + day * 2 + 3600000 * 10.5).toISOString() }
      ];
      const insert = sqliteDb.prepare('INSERT INTO slots (id, provider, start, end) VALUES (@id, @provider, @start, @end)');
      for (const s of defaultSlots) {
        insert.run(s);
      }
    }
  }
}

// Database helper functions
const db = {
  isPostgres,
  init: initDb,

  // Replace all slots and delete every booking
  async reset(slots) {
    if (isPostgres) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM bookings');
        await client.query('DELETE FROM slots');
        await client.query('DELETE FROM idempotency');
        await client.query('DELETE FROM attempts');

        for (const s of slots) {
          await client.query(
            'INSERT INTO slots (id, provider, start, "end") VALUES ($1, $2, $3, $4)',
            [s.id, s.provider, s.start, s.end]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      const resetTx = sqliteDb.transaction((slotList) => {
        sqliteDb.prepare('DELETE FROM bookings').run();
        sqliteDb.prepare('DELETE FROM slots').run();
        sqliteDb.prepare('DELETE FROM idempotency').run();
        sqliteDb.prepare('DELETE FROM attempts').run();

        const insertSlot = sqliteDb.prepare(
          'INSERT INTO slots (id, provider, start, end) VALUES (@id, @provider, @start, @end)'
        );
        for (const s of slotList) {
          insertSlot.run(s);
        }
      });
      resetTx(slots);
    }
  },

  // Get all slots with availability status, ordered earliest start first
  async getSlots(provider) {
    if (isPostgres) {
      let query = `
        SELECT s.id, s.provider, to_char(s.start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as start,
               to_char(s."end" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "end",
               CASE WHEN b.id IS NULL THEN true ELSE false END as available
        FROM slots s
        LEFT JOIN bookings b ON s.id = b.slot_id AND b.status = 'confirmed'
      `;
      const params = [];
      if (provider !== undefined) {
        query += ' WHERE s.provider = $1';
        params.push(provider);
      }
      query += ' ORDER BY s.start ASC';
      const res = await pgPool.query(query, params);
      return res.rows;
    } else {
      let query = `
        SELECT s.id, s.provider, s.start, s.end,
               CASE WHEN b.id IS NULL THEN 1 ELSE 0 END as available
        FROM slots s
        LEFT JOIN bookings b ON s.id = b.slot_id AND b.status = 'confirmed'
      `;
      const params = [];
      if (provider !== undefined) {
        query += ' WHERE s.provider = ?';
        params.push(provider);
      }
      query += ' ORDER BY s.start ASC';
      const rows = sqliteDb.prepare(query).all(...params);
      return rows.map(r => ({
        ...r,
        available: Boolean(r.available)
      }));
    }
  },

  // Get a single slot by ID
  async getSlotById(id) {
    if (isPostgres) {
      const res = await pgPool.query(
        `SELECT id, provider, to_char(start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as start,
                to_char("end" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "end"
         FROM slots WHERE id = $1`,
        [id]
      );
      return res.rows[0] || null;
    } else {
      return sqliteDb.prepare('SELECT id, provider, start, end FROM slots WHERE id = ?').get(id) || null;
    }
  },

  // Check if slot has a confirmed booking
  async isSlotBooked(slotId) {
    if (isPostgres) {
      const res = await pgPool.query(
        "SELECT 1 FROM bookings WHERE slot_id = $1 AND status = 'confirmed'",
        [slotId]
      );
      return res.rowCount > 0;
    } else {
      const row = sqliteDb.prepare(
        "SELECT 1 FROM bookings WHERE slot_id = ? AND status = 'confirmed'"
      ).get(slotId);
      return Boolean(row);
    }
  },

  // Create a new booking atomically
  async createBooking(booking) {
    if (isPostgres) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        // Check slot availability with row lock
        const slotCheck = await client.query(
          "SELECT 1 FROM bookings WHERE slot_id = $1 AND status = 'confirmed' FOR UPDATE",
          [booking.slot_id]
        );
        if (slotCheck.rowCount > 0) {
          await client.query('ROLLBACK');
          const err = new Error('Slot already booked');
          err.code = 'SLOT_BOOKED';
          throw err;
        }

        await client.query(
          `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [booking.id, booking.slot_id, booking.name, booking.email, booking.status, booking.created_at]
        );
        await client.query('COMMIT');
        return booking;
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505' || err.code === 'SLOT_BOOKED') {
          const conflict = new Error('Slot already booked');
          conflict.code = 'SLOT_BOOKED';
          throw conflict;
        }
        throw err;
      } finally {
        client.release();
      }
    } else {
      try {
        const insertTx = sqliteDb.transaction((b) => {
          // Check if already booked
          const exists = sqliteDb.prepare(
            "SELECT 1 FROM bookings WHERE slot_id = ? AND status = 'confirmed'"
          ).get(b.slot_id);
          if (exists) {
            const err = new Error('Slot already booked');
            err.code = 'SLOT_BOOKED';
            throw err;
          }

          sqliteDb.prepare(`
            INSERT INTO bookings (id, slot_id, name, email, status, created_at)
            VALUES (@id, @slot_id, @name, @email, @status, @created_at)
          `).run(b);
        });

        insertTx(booking);
        return booking;
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SLOT_BOOKED') {
          const conflict = new Error('Slot already booked');
          conflict.code = 'SLOT_BOOKED';
          throw conflict;
        }
        throw err;
      }
    }
  },

  // Get booking by ID
  async getBookingById(id) {
    if (isPostgres) {
      const res = await pgPool.query(
        `SELECT id, slot_id, name, email, status,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
         FROM bookings WHERE id = $1`,
        [id]
      );
      return res.rows[0] || null;
    } else {
      return sqliteDb.prepare('SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = ?').get(id) || null;
    }
  },

  // Cancel a booking
  async cancelBooking(id) {
    if (isPostgres) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        const check = await client.query(
          `SELECT id, slot_id, name, email, status,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
           FROM bookings WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (check.rowCount === 0) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        const current = check.rows[0];
        if (current.status === 'cancelled') {
          await client.query('ROLLBACK');
          return { alreadyCancelled: true };
        }

        await client.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [id]);
        await client.query('COMMIT');
        return { booking: { ...current, status: 'cancelled' } };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      const cancelTx = sqliteDb.transaction((bookingId) => {
        const current = sqliteDb.prepare('SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = ?').get(bookingId);
        if (!current) return { notFound: true };
        if (current.status === 'cancelled') return { alreadyCancelled: true };

        sqliteDb.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(bookingId);
        return { booking: { ...current, status: 'cancelled' } };
      });
      return cancelTx(id);
    }
  },

  // Cursor pagination for bookings
  async listBookingsByEmail(email, limit, cursor) {
    let cursorTime = null;
    let cursorId = null;

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf8');
        const [t, id] = decoded.split('|');
        cursorTime = t;
        cursorId = id;
      } catch {
        // If cursor is malformed, treat as start
      }
    }

    if (isPostgres) {
      let query = `
        SELECT id, slot_id, name, email, status,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
        FROM bookings
        WHERE LOWER(email) = LOWER($1)
      `;
      const params = [email];

      if (cursorTime && cursorId) {
        query += ` AND (created_at > $2 OR (created_at = $2 AND id > $3))`;
        params.push(cursorTime, cursorId);
      }

      query += ` ORDER BY created_at ASC, id ASC LIMIT $${params.length + 1}`;
      params.push(limit + 1);

      const res = await pgPool.query(query, params);
      const rows = res.rows;
      let nextCursor = null;

      if (rows.length > limit) {
        const lastItemOfPage = rows[limit - 1];
        nextCursor = Buffer.from(`${lastItemOfPage.created_at}|${lastItemOfPage.id}`).toString('base64');
        rows.splice(limit);
      }

      return { bookings: rows, next_cursor: nextCursor };
    } else {
      let query = `
        SELECT id, slot_id, name, email, status, created_at
        FROM bookings
        WHERE LOWER(email) = LOWER(?)
      `;
      const params = [email];

      if (cursorTime && cursorId) {
        query += ` AND (created_at > ? OR (created_at = ? AND id > ?))`;
        params.push(cursorTime, cursorTime, cursorId);
      }

      query += ` ORDER BY created_at ASC, id ASC LIMIT ?`;
      params.push(limit + 1);

      const rows = sqliteDb.prepare(query).all(...params);
      let nextCursor = null;

      if (rows.length > limit) {
        const lastItemOfPage = rows[limit - 1];
        nextCursor = Buffer.from(`${lastItemOfPage.created_at}|${lastItemOfPage.id}`).toString('base64');
        rows.splice(limit);
      }

      return { bookings: rows, next_cursor: nextCursor };
    }
  },

  // Idempotency helpers
  async getIdempotency(key) {
    if (isPostgres) {
      const res = await pgPool.query('SELECT * FROM idempotency WHERE key = $1', [key]);
      return res.rows[0] || null;
    } else {
      return sqliteDb.prepare('SELECT * FROM idempotency WHERE key = ?').get(key) || null;
    }
  },

  async saveIdempotency(key, requestHash, statusCode, responseBody) {
    const now = new Date().toISOString();
    if (isPostgres) {
      await pgPool.query(
        `INSERT INTO idempotency (key, request_hash, status_code, response_body, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO NOTHING`,
        [key, requestHash, statusCode, responseBody, now]
      );
    } else {
      sqliteDb.prepare(`
        INSERT OR IGNORE INTO idempotency (key, request_hash, status_code, response_body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(key, requestHash, statusCode, responseBody, now);
    }
  },

  // Rate limit tracking: record attempt and check rolling 60-second window
  async recordAndCheckRateLimit(email) {
    const now = Date.now();
    const windowStart = now - 60000; // 60 seconds ago

    if (isPostgres) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        // Delete older than 2 minutes to keep table lightweight
        await client.query('DELETE FROM attempts WHERE created_at < $1', [now - 120000]);

        // Get attempts in window
        const res = await client.query(
          'SELECT created_at FROM attempts WHERE LOWER(email) = LOWER($1) AND created_at >= $2 ORDER BY created_at ASC',
          [email, windowStart]
        );

        const count = res.rowCount;
        if (count >= 5) {
          // The 6th or more within the minute
          const oldestInWindow = Number(res.rows[0].created_at);
          const retryAfterSec = Math.max(1, Math.ceil((oldestInWindow + 60000 - now) / 1000));
          await client.query('ROLLBACK');
          return { allowed: false, retryAfter: retryAfterSec };
        }

        // Record this attempt
        await client.query('INSERT INTO attempts (email, created_at) VALUES ($1, $2)', [email.toLowerCase(), now]);
        await client.query('COMMIT');
        return { allowed: true };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      const tx = sqliteDb.transaction((userEmail) => {
        // Prune older than 2 minutes
        sqliteDb.prepare('DELETE FROM attempts WHERE created_at < ?').run(now - 120000);

        const rows = sqliteDb.prepare(
          'SELECT created_at FROM attempts WHERE LOWER(email) = LOWER(?) AND created_at >= ? ORDER BY created_at ASC'
        ).all(userEmail, windowStart);

        if (rows.length >= 5) {
          const oldestInWindow = rows[0].created_at;
          const retryAfterSec = Math.max(1, Math.ceil((oldestInWindow + 60000 - now) / 1000));
          return { allowed: false, retryAfter: retryAfterSec };
        }

        sqliteDb.prepare('INSERT INTO attempts (email, created_at) VALUES (?, ?)').run(userEmail.toLowerCase(), now);
        return { allowed: true };
      });

      return tx(email);
    }
  }
};

module.exports = db;
