# Clinic Booking API & Web Interface

A production-grade Clinic Booking API and interactive web interface built for the **Koya AI Automation Developer (Cohort 4)** assessment. 

Fully implements and validates **all 5 levels** of the technical specification ([koyaacademy.com/assessment-api](https://koyaacademy.com/assessment-api)).

---

## 🚀 Features by Level

- **Level 1 — Core Slot & Booking CRUD**
  - `POST /reset`: Clears all bookings and seed new slots.
  - `GET /slots`: Lists all slots, earliest `start` first. Supports filtering by `provider`. Computes dynamic `available: boolean` field.
  - `POST /bookings`: Creates booking with status `confirmed`, returning HTTP `201`.
  - `GET /bookings/{id}`: Looks up a booking by ID (`200`), or returns `404`.
- **Level 2 — Authentication & Input Validation**
  - `X-API-Key` authentication: Missing or wrong key returns HTTP `401`.
  - Rejects missing or empty `slot_id`, `name`, or `email` (`400`).
  - Strict email format validation (`400`).
  - Rejects slots in the past (`400`) or nonexistent slots (`404`).
  - Trims whitespace from `name` and `email`, and lowercases `email`.
- **Level 3 — Concurrency Safety & Cancellation**
  - **Thread-safe double-booking prevention**: Strict unique constraint and atomic transactions prevent simultaneous race conditions (`409 Conflict`).
  - `DELETE /bookings/{id}`: Sets status to `cancelled` and immediately frees the slot (`200`). Re-cancelling returns `409`.
- **Level 4 — Idempotency & Cursor Pagination**
  - Optional `Idempotency-Key` header: identical retries return the same cached response and ID (`201`); reusing the key with a different body returns `422`.
  - `GET /bookings?email=...`: Cursor-based pagination (`next_cursor`), case-insensitive email match, and integer `limit` validation (1–50).
- **Level 5 — Rate Limiting**
  - Sliding window rate limiting: maximum 5 booking attempts per email per minute (failed and successful).
  - The 6th attempt returns HTTP `429 Too Many Requests` with a `Retry-After: <seconds>` header. Other emails remain completely unaffected.
- **Interactive Web Page**
  - Responsive single-page application at `/` letting patients browse slots, filter by doctor, book appointments, view confirmations, and look up existing bookings.

---

## 🛠️ Tech Stack & Database Architecture

* **Runtime:** Node.js (Express)
* **Database:** Dual-engine architecture:
  * **SQLite** (`better-sqlite3`) for zero-config local development and Render persistent deployment.
  * **PostgreSQL** (`pg`) when `DATABASE_URL` is set (e.g. Neon, Supabase) for serverless deployments on Vercel.

---

## 🧪 Automated Test Suite (51 Tests)

Run the full end-to-end test suite covering all 5 levels:

```bash
npm test
```

Sample output:
```text
====================================================
   Starting Clinic Booking API Level 1–5 Test Suite
====================================================

--- TESTING LEVEL 1: Core Slot & Booking CRUD ---
  ✓ POST /reset returns 200
  ✓ GET /slots returns 200
  ...
--- TESTING LEVEL 2: Authentication & Validation ---
  ✓ Missing X-API-Key returns 401
  ...
--- TESTING LEVEL 3: Concurrency & Cancellation ---
  ✓ Exactly ONE request succeeded (status 201)
  ✓ All 9 competing concurrent requests returned 409 Conflict
  ...
--- TESTING LEVEL 4: Idempotency & Cursor Pagination ---
  ✓ Retried request with same Idempotency-Key returns same 201
  ...
--- TESTING LEVEL 5: Rate Limiting ---
  ✓ 6th attempt returns 429 Too Many Requests
  ✓ 429 response contains Retry-After header

====================================================
TEST RESULTS: 51 passed, 0 failed.
====================================================
```

---

## 🏃 Running Locally

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the server:**
   ```bash
   npm start
   ```

3. Open your browser:
   * **Web App:** [http://localhost:3000](http://localhost:3000) (or [http://localhost:3001](http://localhost:3001) if port 3000 is busy)
   * **Health Check:** [http://localhost:3000/health](http://localhost:3000/health)

*(The server will automatically switch to port 3001 if another app is already using port 3000).*

Default API Key: `koya-clinic-secret-key-2026` (configurable via `API_KEY` environment variable).

---

## ☁️ Deployment Guide (Free HTTPS URL)

### Option 1: Render (Recommended — 2 Minutes)
1. Push this folder to a GitHub repository.
2. Sign in to [render.com](https://render.com) and click **New Web Service**.
3. Select your repository.
4. Set:
   * **Build Command:** `npm install`
   * **Start Command:** `node server.js`
   * **Environment Variables:**
     * `API_KEY`: *(Choose your secret key, e.g. `koya-clinic-key-2026`)*
5. Click **Deploy Web Service**. You will receive an `https://<service-name>.onrender.com` URL.

### Option 2: Vercel + Neon (Free Serverless Postgres)
1. Create a free PostgreSQL database on [neon.tech](https://neon.tech).
2. Copy your Neon connection string (`postgres://...`).
3. Deploy to Vercel:
   ```bash
   npx vercel
   ```
4. Set environment variables on Vercel:
   * `DATABASE_URL`: `postgres://...`
   * `API_KEY`: `koya-clinic-key-2026`

---

## 📡 API Reference Quick Cheatsheet

| Method | Endpoint | Description | Headers |
| :--- | :--- | :--- | :--- |
| `POST` | `/reset` | Replaces all slots, deletes all bookings | `X-API-Key` |
| `GET` | `/slots` | Lists slots earliest `start` first (`?provider=`) | `X-API-Key` |
| `POST` | `/bookings` | Books a slot (rate-limited, concurrency-safe) | `X-API-Key`, `Idempotency-Key` (optional) |
| `GET` | `/bookings` | Lists bookings for email (`?email=&limit=&cursor=`) | `X-API-Key` |
| `GET` | `/bookings/{id}` | Gets booking by ID | `X-API-Key` |
| `DELETE` | `/bookings/{id}` | Cancels booking and frees slot | `X-API-Key` |
