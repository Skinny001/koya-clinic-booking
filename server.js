const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'koya-clinic-secret-key-2026';

app.use(cors());
app.use(express.json());

// Serve static web page from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Public health check and config endpoint for web page
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Expose public API config for the frontend UI
app.get('/config', (req, res) => {
  res.json({ defaultApiKey: API_KEY });
});

// Authentication middleware for API endpoints (Level 2)
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }
  next();
}

// Basic email validator regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ==========================================
// Level 1: POST /reset - Replace all slots
// ==========================================
app.post('/reset', requireApiKey, async (req, res) => {
  try {
    const { slots } = req.body || {};
    if (!Array.isArray(slots)) {
      return res.status(400).json({ error: 'slots array is required' });
    }

    await db.reset(slots);
    res.status(200).json({ status: 'ok', message: 'All slots reset' });
  } catch (err) {
    console.error('Reset error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Level 1: GET /slots - List slots
// ==========================================
app.get('/slots', requireApiKey, async (req, res) => {
  try {
    const { provider } = req.query;
    const slots = await db.getSlots(provider);
    res.status(200).json({ slots });
  } catch (err) {
    console.error('Get slots error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Levels 1-5: POST /bookings - Book a slot
// ==========================================
app.post('/bookings', async (req, res) => {
  try {
    let { slot_id, name, email } = req.body || {};

    // Level 5: Rate Limiting (checked per email before other validations)
    // At most 5 attempts per email per minute, failed attempts included.
    if (email && typeof email === 'string' && email.trim()) {
      const trimmedEmail = email.trim().toLowerCase();
      const rateCheck = await db.recordAndCheckRateLimit(trimmedEmail);
      if (!rateCheck.allowed) {
        res.setHeader('Retry-After', String(rateCheck.retryAfter));
        return res.status(429).json({ error: 'Too many attempts for this email' });
      }
    }

    // Level 2: API Key Check
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== API_KEY) {
      return res.status(401).json({ error: 'Missing or invalid API key' });
    }

    // Level 2: Body validation
    if (!slot_id || typeof slot_id !== 'string' || !slot_id.trim()) {
      return res.status(400).json({ error: 'slot_id is required' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'email is required' });
    }

    // Trim spaces from name and email, store email in lower case
    slot_id = slot_id.trim();
    name = name.trim();
    email = email.trim().toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'invalid email address' });
    }

    // Level 4: Idempotency-Key header check
    const idempotencyKey = req.headers['idempotency-key'];
    const canonicalBody = JSON.stringify({ slot_id, name, email });
    const requestHash = crypto.createHash('sha256').update(canonicalBody).digest('hex');

    if (idempotencyKey) {
      const existing = await db.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.request_hash === requestHash) {
          // Reused with identical body -> return cached response
          return res.status(existing.status_code).json(JSON.parse(existing.response_body));
        } else {
          // Reused with different body -> 422
          return res.status(422).json({ error: 'Idempotency-Key reused with a different body' });
        }
      }
    }

    // Level 2: Slot existence check
    const slot = await db.getSlotById(slot_id);
    if (!slot) {
      return res.status(404).json({ error: 'The slot does not exist' });
    }

    // Level 2: Check if slot has already started (start <= now)
    const slotStartTime = new Date(slot.start).getTime();
    if (slotStartTime <= Date.now()) {
      return res.status(400).json({ error: 'The slot has already started' });
    }

    // Level 1 & Level 3: Concurrency-safe booking creation
    const bookingId = 'bk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const createdAt = new Date().toISOString();

    const newBooking = {
      id: bookingId,
      slot_id,
      name,
      email,
      status: 'confirmed',
      created_at: createdAt
    };

    try {
      await db.createBooking(newBooking);
    } catch (err) {
      if (err.code === 'SLOT_BOOKED') {
        return res.status(409).json({ error: 'Slot already booked' });
      }
      throw err;
    }

    // Level 4: Cache response if Idempotency-Key was provided
    if (idempotencyKey) {
      await db.saveIdempotency(idempotencyKey, requestHash, 201, JSON.stringify(newBooking));
    }

    res.status(201).json(newBooking);
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Level 4: GET /bookings - List a person's bookings
// ==========================================
app.get('/bookings', requireApiKey, async (req, res) => {
  try {
    const { email, limit, cursor } = req.query;

    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'email query parameter is required' });
    }

    let parsedLimit = 10;
    if (limit !== undefined) {
      // Must be an integer 1 to 50
      if (!/^\d+$/.test(limit)) {
        return res.status(400).json({ error: 'Invalid limit' });
      }
      parsedLimit = parseInt(limit, 10);
      if (parsedLimit < 1 || parsedLimit > 50) {
        return res.status(400).json({ error: 'Invalid limit' });
      }
    }

    const result = await db.listBookingsByEmail(email.trim().toLowerCase(), parsedLimit, cursor);
    res.status(200).json(result);
  } catch (err) {
    console.error('List bookings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Level 1: GET /bookings/:id - Get a booking
// ==========================================
app.get('/bookings/:id', requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await db.getBookingById(id);
    if (!booking) {
      return res.status(404).json({ error: 'No booking with that id' });
    }
    res.status(200).json(booking);
  } catch (err) {
    console.error('Get booking error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Level 3: DELETE /bookings/:id - Cancel a booking
// ==========================================
app.delete('/bookings/:id', requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.cancelBooking(id);

    if (result.notFound) {
      return res.status(404).json({ error: 'No booking with that id' });
    }
    if (result.alreadyCancelled) {
      return res.status(409).json({ error: 'Already cancelled' });
    }

    res.status(200).json(result.booking);
  } catch (err) {
    console.error('Cancel booking error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server with automatic fallback if port is already in use
async function start(port = PORT) {
  await db.init();
  const server = app.listen(port, () => {
    console.log(`\n🏥 Clinic Booking API & Web Interface running at:`);
    console.log(`   ➜ Local: http://localhost:${port}`);
    console.log(`   ➜ API Key: ${API_KEY}\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Port ${port} is already in use. Retrying on port ${Number(port) + 1}...`);
      start(Number(port) + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
