# Aria "Leave Now" — MVP Spec
*Authored by Ray — April 13, 2026*
*Product vision: Lyle Dizon*

---

## The Magic

> "You have a 2:00 PM meeting in Walnut Creek. Current traffic puts travel at 28 minutes. You should leave by 1:27 PM. Want me to open maps?"

This is not a reminder. This is situational execution. Aria doesn't just know your schedule — she knows where you are, where you need to be, and exactly when you need to move. That's the difference between a calendar app and a chief of staff.

---

## Core Goal

Build an MVP where Aria uses location, calendar context, and live traffic to determine when the user needs to leave for a meeting, then proactively alerts them via push, SMS, WhatsApp, or call.

---

## Build Strategy

**Wrapper app first (Capacitor), not native.**

Why:
- Single codebase
- Faster iteration
- Mobile presence immediately
- Enough OS access for location + notifications
- Validate the loop before rebuilding UX natively

Do not optimize for native polish yet. Optimize for:
- Reliability
- Timing accuracy
- Habit loop formation
- User trust

---

## MVP User Flow

1. User grants location permission in app
2. Backend reads upcoming calendar events
3. System identifies meetings with valid physical locations
4. Maps / travel-time API calculates current ETA from user location
5. Backend computes leave-by time using live traffic + safety buffer
6. Aria decides whether to notify
7. User receives: push notification → SMS/WhatsApp → optional call for urgent
8. Tapping the alert opens the app or maps

---

## MVP Architecture

**Client (Capacitor wrapper app):**
- Requests location permission
- Captures current device location
- Sends location updates on: app open, app resume, scheduled activity windows
- Receives push notifications
- Deep links into maps

**Backend:**
- Reads next calendar events from `calendar_events` table
- Filters for events with real locations
- Normalizes destination address
- Calls Maps / travel-time API
- Calculates leave-by time
- Applies confidence logic and safety buffer
- Triggers Aria alert workflow

**Integrations needed:**
- Google Calendar → already live via `calendar_events` table ✅
- WhatsApp messaging → already live ✅
- Twilio SMS → already wired ✅
- Alert scheduling → `scheduled_alerts` table already exists ✅
- `calendar_events.location` column → already in schema ✅
- Maps / travel-time API → Google Maps or Mapbox (new)
- Push notifications → Capacitor plugin (new)
- Wrapper app → Capacitor (new)

---

## Aria Decision Logic

Aria should not alert on every event. Rules:

- Event starts within configurable upcoming window
- Event has a physical destination (location field not null/empty)
- User is not already at or near destination
- Calculated departure time is within alert threshold
- Traffic meaningfully changes required leave time
- Suppress duplicates within cooldown window

**Alert ladder:**
1. Push notification first
2. SMS / WhatsApp if urgent or push unacknowledged
3. Voice call only for high-importance or user-defined events

---

## Version 1 Scope

Assume:
- App is installed and permissions granted
- Location checks happen on app open, resume, and predictable active windows
- Backend handles all reasoning
- Push + SMS/WhatsApp provide delivery reliability

**Do not build a perfect background agent on day one.**

---

## Version 2 (once loop is validated)

- Geofence support
- Background refresh improvements
- Smarter leave-time prediction using user travel habits
- Confidence scoring
- One-tap open maps
- Route-aware follow-ups: "You're still 18 min away and the meeting starts in 10. Want me to text them?"

---

## Key Constraint

The main product constraint is iOS background behavior, not the wrapper itself.

**Design principle:** Backend does the reasoning. Mobile app provides permissions, context, and delivery surface. Never rely on the client to make the decision.

---

## What Makes This Magic

Every other reminder tool tells you *when* your meeting is.

Aria tells you *when to leave* — based on where you actually are, what traffic actually looks like, right now.

That's not a calendar feature. That's an agent.

---

## Build Order

1. Capacitor wrapper app — location permission + device context
2. Maps/travel-time API integration (Google Maps or Mapbox)
3. Leave-by time calculation engine in backend
4. Decision logic (rules above)
5. Alert delivery via existing push + WhatsApp + SMS stack
6. V2 geofencing + background improvements

---

*This is the feature that makes Aria feel like magic. Build it.*
