const functions  = require('firebase-functions');
const admin      = require('firebase-admin');
const { google } = require('googleapis');

if (!admin.apps.length) admin.initializeApp();

const REGION      = 'us-east1';
const TIMEZONE    = 'America/New_York';
const CALENDAR_ID = 'cynthiadjones98@gmail.com';

// Time slots offered in the booking calendar (Eastern local time)
const TIME_SLOTS = [
  { label: '9:00 AM',  hour: 9,  minute: 0 },
  { label: '10:00 AM', hour: 10, minute: 0 },
  { label: '11:00 AM', hour: 11, minute: 0 },
  { label: '1:00 PM',  hour: 13, minute: 0 },
  { label: '2:00 PM',  hour: 14, minute: 0 },
  { label: '3:00 PM',  hour: 15, minute: 0 },
  { label: '4:00 PM',  hour: 16, minute: 0 },
];

function getAuthClient() {
  const credentials = require('./service-account.json');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

// Convert Eastern local datetime to a UTC Date.
// Uses the sv-SE locale trick to reliably determine DST offset.
function easternToUTC(year, month0, day, hour, minute) {
  const pad  = (n) => String(n).padStart(2, '0');
  const isoZ = `${year}-${pad(month0 + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00Z`;

  // Parse as UTC to get a reference timestamp
  const refMs = Date.parse(isoZ);

  // Get what Eastern time looks like at that UTC moment
  const etStr = new Date(refMs).toLocaleString('sv-SE', { timeZone: 'America/New_York' });
  const etMs  = Date.parse(etStr.replace(' ', 'T') + 'Z');

  // ET offset from UTC (e.g. 4h in EDT, 5h in EST, in ms)
  const offsetMs = refMs - etMs;

  // Actual UTC = treat our local time as UTC, then apply offset
  return new Date(refMs + offsetMs);
}

// ── GET AVAILABILITY ───────────────────────────────────────────────────────────
// Callable function: client portal passes { year, month } (month is 0-indexed).
// Returns { blockedDates: { 'YYYY-MM-DD': { allDay: bool, times: [...] } } }
exports.getAvailability = functions.region(REGION).https.onCall(async (data) => {
  const { year, month } = data;

  if (typeof year !== 'number' || typeof month !== 'number') {
    throw new functions.https.HttpsError('invalid-argument', 'year and month are required.');
  }

  try {
    const auth     = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    // Use Eastern midnight as boundaries so no slots are cut off by UTC conversion
    const timeMin = easternToUTC(year, month, 1, 0, 0).toISOString();
    const timeMax = easternToUTC(year, month + 1, 1, 0, 0).toISOString();

    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: TIMEZONE,
        items: [{ id: CALENDAR_ID }],
      },
    });

    const busyPeriods = res.data.calendars[CALENDAR_ID]?.busy || [];
    console.log(`[getAvailability] ${year}-${month + 1}: ${busyPeriods.length} busy period(s)`, JSON.stringify(busyPeriods));

    // For each day, determine which time slots are blocked
    const daysInMonth  = new Date(year, month + 1, 0).getDate();
    const blockedDates = {};

    for (let d = 1; d <= daysInMonth; d++) {
      const busySlots = [];

      for (const slot of TIME_SLOTS) {
        const slotStart = easternToUTC(year, month, d, slot.hour, slot.minute);
        const slotEnd   = new Date(slotStart.getTime() + 60 * 60 * 1000); // 1 hour

        const isBusy = busyPeriods.some(bp => {
          const busyStart = new Date(bp.start);
          const busyEnd   = new Date(bp.end);
          return busyStart < slotEnd && busyEnd > slotStart;
        });

        if (isBusy) busySlots.push(slot.label);
      }

      if (busySlots.length > 0) {
        const pad    = (n) => String(n).padStart(2, '0');
        const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
        blockedDates[dateStr] = {
          allDay: busySlots.length === TIME_SLOTS.length,
          times:  busySlots,
        };
      }
    }

    return { blockedDates };

  } catch (err) {
    console.error('getAvailability error:', err.message);
    throw new functions.https.HttpsError('internal', 'Could not fetch calendar availability.');
  }
});


// ── SESSION STATUS CHANGE → SYNC GOOGLE CALENDAR ──────────────────────────────
// Firestore trigger: sessions/{sessionId}
// - confirmed  → create Google Calendar event, store gcalEventId in session doc
// - cancelled / declined → delete the event from Google Calendar
exports.onSessionStatusChanged = functions.region(REGION).firestore
  .document('sessions/{sessionId}')
  .onUpdate(async (change) => {
    const before = change.before.data();
    const after  = change.after.data();

    if (before.status === after.status) return null;

    let calendar;
    try {
      const auth = getAuthClient();
      calendar   = google.calendar({ version: 'v3', auth });
    } catch (err) {
      console.error('Google Calendar auth failed:', err.message);
      return null;
    }

    // ── Confirmed → create event ─────────────────────────────
    if (after.status === 'confirmed' && !after.gcalEventId) {
      const { date, time, durationMinutes, service, clientName, seniorName, notes, cost } = after;
      const [h, m]   = (time || '09:00').split(':').map(Number);
      const duration = durationMinutes || 60;

      const pad      = (n) => String(n).padStart(2, '0');
      const startStr = `${date}T${pad(h)}:${pad(m)}:00`;

      const totalEndMins = h * 60 + m + duration;
      const endH   = Math.floor(totalEndMins / 60) % 24;
      const endM   = totalEndMins % 60;
      const endStr = `${date}T${pad(endH)}:${pad(endM)}:00`;

      const description = [
        `Client: ${clientName}`,
        seniorName ? `Senior: ${seniorName}` : '',
        `Duration: ${duration} min`,
        `Cost: $${cost || 50}`,
        notes ? `Notes: ${notes}` : '',
      ].filter(Boolean).join('\n');

      try {
        const event = await calendar.events.insert({
          calendarId:  CALENDAR_ID,
          requestBody: {
            summary:     `AAP: ${service} \u2014 ${seniorName || clientName}`,
            description,
            start: { dateTime: startStr, timeZone: TIMEZONE },
            end:   { dateTime: endStr,   timeZone: TIMEZONE },
          },
        });

        await change.after.ref.update({ gcalEventId: event.data.id });
        console.log('Created Google Calendar event:', event.data.id);
      } catch (err) {
        console.error('Could not create Google Calendar event:', err.message);
      }
    }

    // ── Cancelled / declined → delete event ──────────────────
    if ((after.status === 'cancelled' || after.status === 'declined') && after.gcalEventId) {
      try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: after.gcalEventId });
        await change.after.ref.update({ gcalEventId: admin.firestore.FieldValue.delete() });
        console.log('Deleted Google Calendar event:', after.gcalEventId);
      } catch (err) {
        console.warn('Could not delete Google Calendar event:', err.message);
      }
    }

    return null;
  });
