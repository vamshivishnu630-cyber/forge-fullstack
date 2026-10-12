# Forge: AI Creator Marketplace (full stack)

A web app (creators, brands, agencies) with a real backend. **No npm install needed.**

## Run it
1. Install Node.js 22.5 or newer (https://nodejs.org).
2. In this folder run: `node server.js`
3. Open http://localhost:3000 and put the browser in full screen.

Demo logins (click "Use email and password instead"), password `demo1234` for all:
- `vamshi@forge.demo`: creator (3D animation, Hyderabad). Has 7 collaborations in every stage, 3 portfolio projects with demo reels, payments and growth logs.
- `brand@forge.demo`: brand with campaigns, leads and collabs.
- `creator@forge.demo`: creator (AI video).

The database also holds 20 more sample creators with varied skills, tools, content types, languages and locations, plus 43 portfolio projects.
An existing `forge.db` gets this extra data automatically the next time you start the server (it never duplicates).
Phone sign-up works too. Without an SMS provider the one-time code is shown on screen (demo mode).

Optional settings: `PORT=8080`, `DB_FILE=/path/forge.db`. Delete `forge.db` to reset to the sample data.
Run the checks with `node test.js` and `node test_extra.js` (each starts its own server on a temporary database).

## What the backend does
- SQLite database (`forge.db`, created on first run), password hashing with scrypt, random session tokens (7 days), rate limits on login and OTP.
- Every write goes through `POST /api/sync` and is checked on the server: ownership, roles, and the collab state machine
  (Requested, Accepted, Funded, Delivered, Completed). Payments are created and released **by the server**. Clients cannot edit roles, verification, or other people's data.
- Private data (collabs, payments, leads, growth, shortlists) is only returned to the people involved.
- Static files are served with security headers and a content security policy.

## Endpoints
GET /api/health, GET /api/state, POST /api/otp/request, /api/otp/verify, /api/auth/register, /api/auth/login, /api/auth/logout, /api/sync, /api/view

## Implemented vs planned
Implemented: accounts, profiles, AI portfolios, briefs with licensing terms, rule-based matching, collabs, demo payment ledger, growth log, rewards, leads, shortlist, 6 colour themes.
The demo reel in a portfolio project is a generated placeholder animation, not the creator's real video. Real uploads are not built yet.
Not production-ready yet: real SMS (needs MSG91/Twilio), real payments (needs Razorpay/Stripe), media upload, admin verification queue, messaging, email. Matching and brief drafting are rule-based templates, not AI models.
Deploy note: put it behind HTTPS (e.g. a reverse proxy) and add a persistent disk for `forge.db`.

## Desktop dashboard
On a laptop or desktop the app shows a dark sidebar, a top bar (search with Ctrl+K, notifications, help, account menu) and a dashboard home page with live counts, a monthly activity chart and a content-mix donut. All numbers are computed from saved data.
Run `node test.js` and `node test_extra.js` to check the backend.
