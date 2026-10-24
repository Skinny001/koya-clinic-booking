const http = require('http');
const { app, start } = require('./server');

const PORT = 3456;
const API_KEY = process.env.API_KEY || 'koya-clinic-secret-key-2026';
let server = null;

// Helper to make HTTP requests
function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };

    if (postData) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json
        });
      });
    });

    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Assert helper
let totalPassed = 0;
let totalFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    totalPassed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    totalFailed++;
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('   Starting Clinic Booking API Level 1–5 Test Suite');
  console.log('====================================================\n');

  // Start test server
  const db = require('./db');
  await db.init();
  await new Promise(resolve => {
    server = app.listen(PORT, resolve);
  });

  const future1 = new Date(Date.now() + 86400000).toISOString();
  const future1End = new Date(Date.now() + 86400000 + 1800000).toISOString();
  const future2 = new Date(Date.now() + 172800000).toISOString();
  const future2End = new Date(Date.now() + 172800000 + 1800000).toISOString();
  const pastStart = new Date(Date.now() - 3600000).toISOString();
  const pastEnd = new Date(Date.now() - 1800000).toISOString();

  // -----------------------------------------------------------------
  // LEVEL 1: Core CRUD
  // -----------------------------------------------------------------
  console.log('--- TESTING LEVEL 1: Core Slot & Booking CRUD ---');

  // 1.1 POST /reset
  const resetRes = await request('POST', '/reset', {
    slots: [
      { id: 's_past', provider: 'Dr Past', start: pastStart, end: pastEnd },
      { id: 's2', provider: 'Dr Ngozi', start: future2, end: future2End },
      { id: 's1', provider: 'Dr Ade', start: future1, end: future1End }
    ]
  }, { 'X-API-Key': API_KEY });
  assert(resetRes.status === 200, 'POST /reset returns 200');

  // 1.2 GET /slots (earliest start first)
  const slotsRes = await request('GET', '/slots', null, { 'X-API-Key': API_KEY });
  assert(slotsRes.status === 200, 'GET /slots returns 200');
  assert(Array.isArray(slotsRes.body.slots), 'GET /slots returns slots array');
  assert(slotsRes.body.slots[0].id === 's_past' && slotsRes.body.slots[1].id === 's1', 'GET /slots orders earliest start first');
  assert(slotsRes.body.slots[1].available === true, 'GET /slots shows available: true when unbooked');

  // 1.3 GET /slots?provider=Dr Ade (exact match)
  const filterRes = await request('GET', '/slots?provider=Dr%20Ade', null, { 'X-API-Key': API_KEY });
  assert(filterRes.status === 200, 'GET /slots?provider=... returns 200');
  assert(filterRes.body.slots.length === 1 && filterRes.body.slots[0].provider === 'Dr Ade', 'Filter by provider matches exact provider');

  // 1.4 POST /bookings
  const bookRes = await request('POST', '/bookings', {
    slot_id: 's1',
    name: 'Ada Obi',
    email: 'ada@example.com'
  }, { 'X-API-Key': API_KEY });
  assert(bookRes.status === 201, 'POST /bookings returns 201 on success');
  assert(bookRes.body.status === 'confirmed', 'Booking status is "confirmed"');
  assert(typeof bookRes.body.id === 'string' && bookRes.body.id.length > 0, 'Generated unique booking id');
  const bookingId1 = bookRes.body.id;

  // 1.5 Verify slot now marked available: false
  const updatedSlotsRes = await request('GET', '/slots?provider=Dr%20Ade', null, { 'X-API-Key': API_KEY });
  assert(updatedSlotsRes.body.slots[0].available === false, 'Booked slot now has available: false');

  // 1.6 GET /bookings/:id
  const getBookingRes = await request('GET', `/bookings/${bookingId1}`, null, { 'X-API-Key': API_KEY });
  assert(getBookingRes.status === 200, 'GET /bookings/:id returns 200');
  assert(getBookingRes.body.name === 'Ada Obi', 'GET /bookings/:id returns correct booking data');

  const getMissingRes = await request('GET', '/bookings/nonexistent_id', null, { 'X-API-Key': API_KEY });
  assert(getMissingRes.status === 404, 'GET /bookings/:id returns 404 if booking not found');

  // -----------------------------------------------------------------
  // LEVEL 2: Authentication & Input Validation
  // -----------------------------------------------------------------
  console.log('\n--- TESTING LEVEL 2: Authentication & Validation ---');

  // 2.1 API Key Auth
  const noKeyRes = await request('GET', '/slots');
  assert(noKeyRes.status === 401, 'Missing X-API-Key returns 401');

  const wrongKeyRes = await request('GET', '/slots', null, { 'X-API-Key': 'wrong-key-xyz' });
  assert(wrongKeyRes.status === 401, 'Wrong X-API-Key returns 401');

  // 2.2 Missing/empty fields
  const missingSlot = await request('POST', '/bookings', { name: 'Ada', email: 'ada@example.com' }, { 'X-API-Key': API_KEY });
  assert(missingSlot.status === 400, 'Missing slot_id returns 400');

  const emptyName = await request('POST', '/bookings', { slot_id: 's2', name: '   ', email: 'ada@example.com' }, { 'X-API-Key': API_KEY });
  assert(emptyName.status === 400, 'Empty name returns 400');

  // 2.3 Invalid email
  const invalidEmail = await request('POST', '/bookings', { slot_id: 's2', name: 'Ada', email: 'not-an-email' }, { 'X-API-Key': API_KEY });
  assert(invalidEmail.status === 400, 'Invalid email returns 400');

  // 2.4 Nonexistent slot -> 404
  const noSlot = await request('POST', '/bookings', { slot_id: 'ghost_slot', name: 'Ada', email: 'ada@example.com' }, { 'X-API-Key': API_KEY });
  assert(noSlot.status === 404, 'Nonexistent slot_id returns 404');

  // 2.5 Slot in the past -> 400
  const pastSlot = await request('POST', '/bookings', { slot_id: 's_past', name: 'Ada', email: 'ada@example.com' }, { 'X-API-Key': API_KEY });
  assert(pastSlot.status === 400, 'Slot that has already started returns 400');

  // 2.6 Trim whitespace & lowercase email
  const trimBook = await request('POST', '/bookings', {
    slot_id: 's2',
    name: '  Emeka Okafor  ',
    email: '  EMEKA@EXAMPLE.COM  '
  }, { 'X-API-Key': API_KEY });
  assert(trimBook.status === 201, 'Booking with untrimmed fields succeeds');
  assert(trimBook.body.name === 'Emeka Okafor', 'Name was trimmed');
  assert(trimBook.body.email === 'emeka@example.com', 'Email was trimmed and lowercased');

  // -----------------------------------------------------------------
  // LEVEL 3: Concurrency Safety & Cancellation
  // -----------------------------------------------------------------
  console.log('\n--- TESTING LEVEL 3: Concurrency & Cancellation ---');

  // Reset with fresh slot s_concurrent
  const future3 = new Date(Date.now() + 259200000).toISOString();
  const future3End = new Date(Date.now() + 259200000 + 1800000).toISOString();
  await request('POST', '/reset', {
    slots: [{ id: 's_concurrent', provider: 'Dr Tunde', start: future3, end: future3End }]
  }, { 'X-API-Key': API_KEY });

  // Fire 10 simultaneous booking attempts for s_concurrent at the exact same moment
  console.log('  Firing 10 simultaneous concurrent requests for the same slot...');
  const concurrentPromises = Array.from({ length: 10 }, (_, i) =>
    request('POST', '/bookings', {
      slot_id: 's_concurrent',
      name: `User ${i}`,
      email: `user${i}@example.com`
    }, { 'X-API-Key': API_KEY })
  );

  const concurrentResults = await Promise.all(concurrentPromises);
  const successCount = concurrentResults.filter(r => r.status === 201).length;
  const conflictCount = concurrentResults.filter(r => r.status === 409).length;

  assert(successCount === 1, 'Exactly ONE request succeeded (status 201)');
  assert(conflictCount === 9, 'All 9 competing concurrent requests returned 409 Conflict');

  const wonBooking = concurrentResults.find(r => r.status === 201).body;

  // 3.2 DELETE /bookings/:id (cancel booking)
  const cancelRes = await request('DELETE', `/bookings/${wonBooking.id}`, null, { 'X-API-Key': API_KEY });
  assert(cancelRes.status === 200, 'DELETE /bookings/:id returns 200 on cancel');
  assert(cancelRes.body.status === 'cancelled', 'Cancelled booking has status "cancelled"');

  // Verify slot is now available again!
  const freedSlotRes = await request('GET', '/slots', null, { 'X-API-Key': API_KEY });
  assert(freedSlotRes.body.slots[0].available === true, 'Cancelling booking immediately frees the slot (available: true)');

  // 3.3 Double cancellation -> 409
  const doubleCancelRes = await request('DELETE', `/bookings/${wonBooking.id}`, null, { 'X-API-Key': API_KEY });
  assert(doubleCancelRes.status === 409, 'Cancelling an already cancelled booking returns 409');

  // -----------------------------------------------------------------
  // LEVEL 4: Idempotency & Cursor Pagination
  // -----------------------------------------------------------------
  console.log('\n--- TESTING LEVEL 4: Idempotency & Cursor Pagination ---');

  // Re-book freed slot with an Idempotency-Key
  const idemKey = 'idem-req-abc-123';
  const idemBook1 = await request('POST', '/bookings', {
    slot_id: 's_concurrent',
    name: 'Idem User',
    email: 'idem@example.com'
  }, { 'X-API-Key': API_KEY, 'Idempotency-Key': idemKey });
  assert(idemBook1.status === 201, 'Initial booking with Idempotency-Key returns 201');

  // Retry same key with same body -> must return same 201 and same booking id
  const idemBookRetry = await request('POST', '/bookings', {
    slot_id: 's_concurrent',
    name: 'Idem User',
    email: 'idem@example.com'
  }, { 'X-API-Key': API_KEY, 'Idempotency-Key': idemKey });
  assert(idemBookRetry.status === 201, 'Retried request with same Idempotency-Key returns same 201');
  assert(idemBookRetry.body.id === idemBook1.body.id, 'Retried request returns identical booking id');

  // Reuse same key with different body -> 422
  const idemDifferentBody = await request('POST', '/bookings', {
    slot_id: 's_concurrent',
    name: 'Different Person',
    email: 'different@example.com'
  }, { 'X-API-Key': API_KEY, 'Idempotency-Key': idemKey });
  assert(idemDifferentBody.status === 422, 'Reusing Idempotency-Key with different body returns 422');

  // 4.2 Cursor Pagination for GET /bookings
  // Seed multiple slots and bookings for patient pagination
  const pageSlots = Array.from({ length: 5 }, (_, i) => ({
    id: `page_slot_${i}`,
    provider: 'Dr Pagination',
    start: new Date(Date.now() + 300000000 + i * 3600000).toISOString(),
    end: new Date(Date.now() + 300000000 + (i + 1) * 3600000).toISOString()
  }));

  await request('POST', '/reset', { slots: pageSlots }, { 'X-API-Key': API_KEY });

  // Create 4 bookings for patient 'pete@example.com'
  for (let i = 0; i < 4; i++) {
    await request('POST', '/bookings', {
      slot_id: `page_slot_${i}`,
      name: `Pete ${i}`,
      email: 'pete@example.com'
    }, { 'X-API-Key': API_KEY });
  }

  // Page 1 with limit=2 (case-insensitive email)
  const page1 = await request('GET', '/bookings?email=PETE@EXAMPLE.COM&limit=2', null, { 'X-API-Key': API_KEY });
  assert(page1.status === 200, 'GET /bookings returns 200 with case-insensitive email');
  assert(page1.body.bookings.length === 2, 'Page 1 returns limit (2) bookings');
  assert(typeof page1.body.next_cursor === 'string' && page1.body.next_cursor.length > 0, 'Page 1 returns non-null next_cursor');

  // Page 2 using next_cursor
  const page2 = await request('GET', `/bookings?email=pete@example.com&limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`, null, { 'X-API-Key': API_KEY });
  assert(page2.status === 200, 'Page 2 with cursor returns 200');
  assert(page2.body.bookings.length === 2, 'Page 2 returns 2 bookings');
  assert(page2.body.bookings[0].id !== page1.body.bookings[0].id, 'Page 2 has distinct bookings from Page 1');

  // Page 3 (should be empty / last page)
  if (page2.body.next_cursor) {
    const page3 = await request('GET', `/bookings?email=pete@example.com&limit=2&cursor=${encodeURIComponent(page2.body.next_cursor)}`, null, { 'X-API-Key': API_KEY });
    assert(page3.body.next_cursor === null, 'Final page returns next_cursor: null');
  }

  // Invalid limit check
  const badLimit1 = await request('GET', '/bookings?email=pete@example.com&limit=0', null, { 'X-API-Key': API_KEY });
  assert(badLimit1.status === 400, 'Limit 0 returns 400');

  const badLimit2 = await request('GET', '/bookings?email=pete@example.com&limit=51', null, { 'X-API-Key': API_KEY });
  assert(badLimit2.status === 400, 'Limit > 50 returns 400');

  // -----------------------------------------------------------------
  // LEVEL 5: Rate Limiting
  // -----------------------------------------------------------------
  console.log('\n--- TESTING LEVEL 5: Rate Limiting ---');

  // Reset rate limits by resetting database
  await request('POST', '/reset', {
    slots: [
      { id: 'rate_s1', provider: 'Dr Rate', start: new Date(Date.now() + 400000000).toISOString(), end: new Date(Date.now() + 401800000).toISOString() }
    ]
  }, { 'X-API-Key': API_KEY });

  const spamEmail = 'spammer@example.com';
  console.log('  Sending 5 booking attempts for spammer@example.com...');
  for (let i = 1; i <= 5; i++) {
    const res = await request('POST', '/bookings', {
      slot_id: 'nonexistent_slot', // failed attempt counts toward limit
      name: 'Spammer',
      email: spamEmail
    }, { 'X-API-Key': API_KEY });
    assert(res.status === 404, `Attempt #${i} counted (404 failure counts as attempt)`);
  }

  // 6th attempt MUST return 429 with Retry-After header
  console.log('  Sending 6th booking attempt for spammer@example.com...');
  const rateLimitRes = await request('POST', '/bookings', {
    slot_id: 'rate_s1',
    name: 'Spammer',
    email: spamEmail
  }, { 'X-API-Key': API_KEY });

  assert(rateLimitRes.status === 429, '6th attempt returns 429 Too Many Requests');
  assert(rateLimitRes.headers['retry-after'] !== undefined, '429 response contains Retry-After header');
  assert(parseInt(rateLimitRes.headers['retry-after'], 10) > 0, `Retry-After is a positive integer: ${rateLimitRes.headers['retry-after']} seconds`);

  // Verify other email is NOT affected
  const innocentRes = await request('POST', '/bookings', {
    slot_id: 'rate_s1',
    name: 'Innocent User',
    email: 'innocent@example.com'
  }, { 'X-API-Key': API_KEY });
  assert(innocentRes.status === 201, 'Other email is NOT affected and successfully books (201)');

  console.log('\n====================================================');
  console.log(`TEST RESULTS: ${totalPassed} passed, ${totalFailed} failed.`);
  console.log('====================================================');

  server.close();
  process.exit(totalFailed === 0 ? 0 : 1);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  if (server) server.close();
  process.exit(1);
});
