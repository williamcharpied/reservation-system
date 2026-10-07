import crypto from "node:crypto";

// ── Salon config ─────────────────────────────────────────────────────────────

const SALON_NAME    = "Amour Nail Studio";
const SALON_ADDRESS = "25 N Bishop St Apt 2 · Chicago, IL";
const SALON_PHONE   = "(773) 543-6527";
// TODO: switch to an amournailstudio.com address when the new domain is ready
// (or set SALON_EMAIL in the Netlify environment variables).
const SALON_EMAIL   = process.env.SALON_EMAIL || "bookings@monalizanails.com";
const FROM_EMAIL    = SALON_NAME + " <" + SALON_EMAIL + ">";
const SALON_LOCATION = "25 N Bishop St Apt 2, Chicago, IL 60607";

// Liza (nail tech / owner). Gets her own copy of every customer email (with a calendar
// invite attached) and a text message for every new, changed or cancelled appointment.
const OWNER_NAME   = "Liza Solovei";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "lizasolovey89@gmail.com";
const NOTIFY_PHONE = process.env.NOTIFY_PHONE || "7735436527";

// ── Availability (hardcoded) ─────────────────────────────────────────────────
// Open Sunday and Monday, 10:00 AM – 6:00 PM Chicago time.
const TZ              = "America/Chicago";
const OPEN_DAYS       = [0, 1];   // 0 = Sunday, 1 = Monday
const OPEN_HOUR       = 10;
const CLOSE_HOUR      = 18;
const SLOT_STEP_MIN   = 30;       // appointments can start every 30 minutes
const MAX_CONCURRENT  = 1;        // appointments that may overlap at once
const SEARCH_WINDOW_DAYS = 60;    // how far ahead staff search / SMS lookups scan

// ── Time helpers (all salon logic is in Chicago time) ────────────────────────

function chicagoParts(ms) {
  const p = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return p;
}

function tzOffsetMs(utcMs) {
  const p = chicagoParts(utcMs);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// "2026-10-11" + 10:00 in Chicago -> UTC milliseconds (handles CDT/CST)
function chicagoToUtcMs(dateStr, hour, minute) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - tzOffsetMs(guess);
  return guess - tzOffsetMs(first);
}

function chicagoDateStr(ms) {
  const p = chicagoParts(ms);
  return p.year + "-" + p.month + "-" + p.day;
}

function isValidDateStr(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function fmtChicago(isoStr) {
  return new Date(isoStr).toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZoneName: "short",
  });
}

function within24h(startAt) {
  return (new Date(startAt).getTime() - Date.now()) < 24 * 60 * 60 * 1000;
}

// Every legal start time (UTC ms) on a date for an appointment of `durMin` minutes
function slotStartsForDate(dateStr, durMin) {
  if (!isValidDateStr(dateStr)) return [];
  if (!OPEN_DAYS.includes(weekdayOf(dateStr))) return [];
  const open  = chicagoToUtcMs(dateStr, OPEN_HOUR, 0);
  const close = chicagoToUtcMs(dateStr, CLOSE_HOUR, 0);
  const out = [];
  for (let t = open; t + durMin * 60000 <= close; t += SLOT_STEP_MIN * 60000) out.push(t);
  return out;
}

function overlaps(aStart, aDurMin, bStart, bDurMin) {
  return aStart < bStart + bDurMin * 60000 && bStart < aStart + aDurMin * 60000;
}

function isSlotFree(dayBookings, startMs, durMin, ignoreId) {
  const clashes = dayBookings.filter(b =>
    b.status === "BOOKED" && b.id !== ignoreId &&
    overlaps(startMs, durMin, Date.parse(b.start_at), b.duration_minutes));
  return clashes.length < MAX_CONCURRENT;
}

// ── Manage-link tokens ───────────────────────────────────────────────────────
// HMAC token: bookingId + expiry, signed with MANAGE_TOKEN_SECRET.

function makeManageToken(bookingId, secret) {
  const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  const payload = bookingId + ":" + expiry;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  return Buffer.from(payload + ":" + sig).toString("base64url");
}

function verifyManageToken(token, secret) {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const parts = decoded.split(":");
    if (parts.length !== 3) return null;
    const [bookingId, expiry, sig] = parts;
    if (Date.now() > parseInt(expiry)) return null;
    const payload = bookingId + ":" + expiry;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
    if (sig !== expected) return null;
    return bookingId;
  } catch (e) { return null; }
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// ── Booking storage (Netlify Blobs) ──────────────────────────────────────────
// day/<YYYY-MM-DD>/<id>  -> booking JSON (source of truth, grouped by day)
// idx/<id>               -> { day }      (finds a booking from its id)

let storeFactory = async function () {
  const { getStore } = await import("@netlify/blobs");
  return getStore({ name: "bookings", consistency: "strong" });
};

const ID_RE = /^[a-f0-9]{10}$/;

async function loadDay(store, dateStr) {
  const { blobs } = await store.list({ prefix: "day/" + dateStr + "/" });
  const items = await Promise.all(blobs.map(b => store.get(b.key, { type: "json" })));
  return items.filter(Boolean);
}

async function loadRange(store, fromDate, toDate) {
  const { blobs } = await store.list({ prefix: "day/" });
  const keys = blobs.map(b => b.key).filter(k => {
    const d = k.split("/")[1];
    return d >= fromDate && d <= toDate;
  });
  const items = await Promise.all(keys.map(k => store.get(k, { type: "json" })));
  return items.filter(Boolean).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
}

async function getBooking(store, id) {
  if (typeof id !== "string" || !ID_RE.test(id.trim().toLowerCase())) return null;
  id = id.trim().toLowerCase();
  const idx = await store.get("idx/" + id, { type: "json" });
  if (!idx) return null;
  return store.get("day/" + idx.day + "/" + id, { type: "json" });
}

async function saveBooking(store, booking, previousDay) {
  const day = chicagoDateStr(Date.parse(booking.start_at));
  await store.setJSON("day/" + day + "/" + booking.id, booking);
  await store.setJSON("idx/" + booking.id, { day });
  if (previousDay && previousDay !== day) {
    await store.delete("day/" + previousDay + "/" + booking.id);
  }
}

async function availableSlots(store, dateStr, durMin, ignoreId) {
  const starts = slotStartsForDate(dateStr, durMin);
  if (!starts.length) return [];
  const day = await loadDay(store, dateStr);
  const now = Date.now();
  return starts
    .filter(s => s > now && isSlotFree(day, s, durMin, ignoreId))
    .map(s => ({ start_at: new Date(s).toISOString() }));
}

// Returns an error string if the slot can't be booked, otherwise null
async function checkSlot(store, startMs, durMin, ignoreId) {
  if (!Number.isFinite(startMs)) return "Please choose a valid date and time.";
  const dateStr = chicagoDateStr(startMs);
  if (!slotStartsForDate(dateStr, durMin).includes(startMs)) {
    return "That time isn't available. We're open Sunday and Monday, 10 AM – 6 PM.";
  }
  if (startMs <= Date.now()) return "That time has already passed. Please choose another.";
  const day = await loadDay(store, dateStr);
  if (!isSlotFree(day, startMs, durMin, ignoreId)) {
    return "Sorry, that time was just booked. Please choose another.";
  }
  return null;
}

// ── Messaging helpers ────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function digitsOnly(s) { return (s || "").replace(/\D/g, ""); }

function firstNameOf(name) { return name ? String(name).trim().split(/\s+/)[0] : "there"; }

async function sendEmail(resendKey, { from, to, subject, html, attachments }) {
  if (!resendKey) return null;
  const payload = { from, to, subject, html };
  if (attachments && attachments.length) payload.attachments = attachments;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await r.json();
  if (result && result.statusCode >= 400) {
    console.error("Resend error:", result.statusCode, result.name, result.message);
  }
  return result;
}

async function writeToSheet(scriptUrl, data) {
  if (!scriptUrl) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000); // 4s max
    await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (e) {
    if (e.name === "AbortError") console.error("Sheet write timed out (>4s):", data.sheet);
    else console.error("Sheet write error:", e.message);
  }
}

// ── Calendar invites (.ics) ──────────────────────────────────────────────────

function icsEscape(text) {
  return String(text == null ? "" : text)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// RFC 5545: lines are limited to 75 octets; continuation lines start with a space.
// Never split in the middle of a multi-byte UTF-8 character.
function icsFold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0, limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xC0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;   // the leading space counts toward the 75
  }
  return parts.join("\r\n ");
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsParam(text) { return String(text || "").replace(/["\r\n]/g, ""); }

// method: "REQUEST" (new or updated appointment) or "CANCEL".
// The UID stays the same for the life of a booking and SEQUENCE goes up with every change,
// so Apple Calendar / Google Calendar / Outlook update or remove the existing event
// instead of adding a duplicate.
function buildIcs(booking, { method, forOwner, manageUrl }) {
  const startMs = Date.parse(booking.start_at);
  const endMs   = startMs + booking.duration_minutes * 60000;
  const cancelled = method === "CANCEL";
  const addonText = booking.addons.length ? booking.addons.map(a => a.name).join(", ") : "None";
  const attendee  = forOwner ? { name: OWNER_NAME, email: NOTIFY_EMAIL } : { name: booking.name, email: booking.email };

  const summary = forOwner
    ? `${booking.name} – ${booking.service.name}`
    : `${SALON_NAME} – ${booking.service.name}`;
  const description = forOwner
    ? [`Client: ${booking.name}`, `Phone: ${booking.phone}`, `Email: ${booking.email}`,
       `Service: ${booking.service.name}`, `Add-ons: ${addonText}`, `Booking ID: ${booking.id}`].join("\n")
    : [`Service: ${booking.service.name}`, `Add-ons: ${addonText}`, `Booking ID: ${booking.id}`,
       ...(manageUrl && !cancelled ? [`Cancel or reschedule: ${manageUrl}`] : [])].join("\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Amour Nail Studio//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:" + method,
    "BEGIN:VEVENT",
    "UID:" + booking.id + "@amournailstudio.booking",
    "DTSTAMP:" + icsDate(Date.now()),
    "SEQUENCE:" + (booking.seq || 0),
    "DTSTART:" + icsDate(startMs),
    "DTEND:" + icsDate(endMs),
    "SUMMARY:" + icsEscape(cancelled ? "Cancelled: " + summary : summary),
    "DESCRIPTION:" + icsEscape(description),
    "LOCATION:" + icsEscape(SALON_LOCATION),
    "STATUS:" + (cancelled ? "CANCELLED" : "CONFIRMED"),
    "TRANSP:" + (cancelled ? "TRANSPARENT" : "OPAQUE"),
    `ORGANIZER;CN="${icsParam(SALON_NAME)}":mailto:${SALON_EMAIL}`,
    `ATTENDEE;CN="${icsParam(attendee.name)}";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${attendee.email}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

// Sends one customer email, plus a separate (not cc/bcc) copy to Liza. Each message carries
// its own calendar invite. `toCustomer: false` sends Liza's copy only (staff made a change
// and chose not to notify the customer, but Liza's calendar still needs to stay accurate).
async function sendEmailWithCopy(ctx, booking, { subject, html, method, manageUrl, toCustomer }) {
  const recipients = [];
  if (toCustomer && booking.email) recipients.push({ to: booking.email, forOwner: false });
  const sameAddress = (booking.email || "").trim().toLowerCase() === NOTIFY_EMAIL.toLowerCase();
  if (NOTIFY_EMAIL && !(toCustomer && sameAddress)) recipients.push({ to: NOTIFY_EMAIL, forOwner: true });

  await Promise.all(recipients.map(async ({ to, forOwner }) => {
    const content = Buffer.from(buildIcs(booking, { method, forOwner, manageUrl }), "utf8").toString("base64");
    // If the email service rejects the attachment for any reason, retry with a plainer one,
    // then without it, so a calendar problem can never stop the email itself.
    const variants = [
      [{ filename: "appointment.ics", content, content_type: `text/calendar; charset=utf-8; method=${method}` }],
      [{ filename: "appointment.ics", content }],
      [],
    ];
    for (const attachments of variants) {
      try {
        const result = await sendEmail(ctx.resendKey, { from: FROM_EMAIL, to: [to], subject, html, attachments });
        if (!result || !(result.statusCode >= 400)) return;
      } catch (e) { console.error("Email send failed:", e.message); }
    }
  }));
}

function emailShell(inner, footer) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF8F4;font-family:'Georgia',serif;">
  <div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #E8E3DC;border-radius:12px;overflow:hidden;">
    <div style="background:#1A1714;padding:28px 32px;text-align:center;">
      <div style="font-family:'Georgia',serif;font-size:24px;color:#FAF8F4;letter-spacing:0.05em;">${SALON_NAME}</div>
      <div style="font-size:11px;color:#A09890;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px;">${SALON_ADDRESS}</div>
    </div>
    ${inner}
    <div style="background:#FAF8F4;border-top:1px solid #E8E3DC;padding:16px 32px;text-align:center;font-size:11px;color:#A09890;">
      ${footer}
    </div>
  </div></body></html>`;
}

const CONTACT_FOOTER = `${SALON_PHONE} · ${SALON_EMAIL}`;

function confirmationEmail({ booking, manageUrl }) {
  const dateStr = fmtChicago(booking.start_at);
  const total = booking.service.price + booking.addons.reduce((s, a) => s + a.price, 0);
  const svcPriceText = booking.service.priceDisplay || "$" + (booking.service.price / 100).toFixed(0);
  const isRange = svcPriceText.includes("–");   // ranged services show "from" pricing
  const inner = `<div style="padding:32px;">
      <div style="font-size:22px;margin-bottom:6px;">You're all booked, ${esc(firstNameOf(booking.name))}! ✓</div>
      <div style="font-size:14px;color:#6B6560;margin-bottom:24px;">We look forward to seeing you. Here are your appointment details.</div>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
        <tr style="border-bottom:1px solid #E8E3DC;">
          <td style="padding:10px 0;color:#6B6560;width:110px;">Date & Time</td>
          <td style="padding:10px 0;font-weight:600;">${dateStr}</td>
        </tr>
        <tr style="border-bottom:1px solid #E8E3DC;">
          <td style="padding:10px 0;color:#6B6560;">Service</td>
          <td style="padding:10px 0;font-weight:500;">${esc(booking.service.name)}<span style="float:right;color:#6B6560;">${esc(svcPriceText)}</span></td>
        </tr>
        ${booking.addons.map(a => `<tr style="border-bottom:1px solid #E8E3DC;">
          <td style="padding:10px 0;color:#6B6560;">Add-On</td>
          <td style="padding:10px 0;color:#C4956A;">+ ${esc(a.name)}<span style="float:right;">+$${(a.price / 100).toFixed(0)}</span></td>
        </tr>`).join("")}
        <tr style="border-bottom:1px solid #E8E3DC;">
          <td style="padding:10px 0;color:#6B6560;">Duration</td>
          <td style="padding:10px 0;">${booking.duration_minutes} min</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#6B6560;font-weight:600;">Total</td>
          <td style="padding:10px 0;font-weight:600;">$${(total / 100).toFixed(0)}${isRange ? "+" : ""}</td>
        </tr>
      </table>

      <div style="background:#FAF8F4;border:1px solid #E8E3DC;border-radius:8px;padding:16px;margin-bottom:24px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#A09890;margin-bottom:12px;">Manage your appointment</div>
        <a href="${manageUrl}" style="display:block;background:#1A1714;color:#fff;text-align:center;padding:12px;border-radius:6px;text-decoration:none;font-size:14px;margin-bottom:8px;">Cancel or Reschedule</a>
        <div style="font-size:12px;color:#A09890;text-align:center;">Link valid for 30 days · Must cancel 24+ hours in advance</div>
      </div>

      <div style="font-size:12px;color:#A09890;border-top:1px solid #E8E3DC;padding-top:16px;line-height:1.7;">
        <strong style="color:#6B6560;">Cancellation policy:</strong> We ask that you reschedule or cancel at least 1 day before your appointment.
        Cancellations or no-shows within 24 hours will be charged 50% of the service cost.<br><br>
        Questions? Call <a href="tel:7735436527" style="color:#6B6560;">${SALON_PHONE}</a> or reply to this email.
      </div>
    </div>`;
  return emailShell(inner, `${SALON_NAME} · 25 N Bishop St Apt 2, Chicago IL 60607`);
}

function cancellationEmail({ booking, byStaff, siteUrl }) {
  const inner = `<div style="padding:32px;">
      <div style="font-size:22px;margin-bottom:8px;">Appointment Cancelled</div>
      <p style="font-size:14px;color:#6B6560;">Hi ${esc(firstNameOf(booking.name))}, your appointment on <strong style="color:#1A1714;">${fmtChicago(booking.start_at)}</strong> has been cancelled${byStaff ? " by the salon" : ""}.</p>
      <p style="font-size:14px;color:#6B6560;">${byStaff ? "We apologize for any inconvenience. " : ""}We hope to see you again soon!</p>
      <a href="${siteUrl}" style="display:inline-block;background:#1A1714;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;margin-top:8px;">Book a new appointment</a>
    </div>`;
  return emailShell(inner, CONTACT_FOOTER);
}

function rescheduleEmail({ booking, manageUrl, byStaff }) {
  const inner = `<div style="padding:32px;">
      <div style="font-size:22px;margin-bottom:8px;">Appointment Rescheduled ✓</div>
      <p style="font-size:14px;color:#6B6560;">Hi ${esc(firstNameOf(booking.name))}, your appointment has been moved to:</p>
      <p style="font-size:18px;font-weight:600;color:#1A1714;margin:12px 0;">${fmtChicago(booking.start_at)}</p>
      <div style="background:#FAF8F4;border:1px solid #E8E3DC;border-radius:8px;padding:16px;margin:16px 0;">
        <a href="${manageUrl}" style="display:block;background:#1A1714;color:#fff;text-align:center;padding:12px;border-radius:6px;text-decoration:none;font-size:14px;">Cancel or Reschedule${byStaff ? "" : " Again"}</a>
        <div style="font-size:12px;color:#A09890;text-align:center;margin-top:8px;">Link valid for 30 days${byStaff ? "" : " · Must cancel 24+ hours in advance"}</div>
      </div>
      ${byStaff ? "" : `<p style="font-size:12px;color:#A09890;">Cancellations within 24 hours will be charged 50% of the service cost.</p>`}
    </div>`;
  return emailShell(inner, CONTACT_FOOTER);
}

// ── Twilio SMS helpers ───────────────────────────────────────────────────────

async function sendSMS(to, body) {
  const SID   = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM  = process.env.TWILIO_FROM_NUMBER;
  if (!SID || !TOKEN || !FROM) { console.error("Twilio not configured"); return null; }
  const digits = digitsOnly(to);
  if (digits.length < 10) return null;
  const phone = digits.length === 10 ? "+1" + digits : "+" + digits;
  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": "Basic " + Buffer.from(SID + ":" + TOKEN).toString("base64"),
          "Content-Type":  "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: FROM, To: phone, Body: body }).toString(),
      }
    );
    const result = await r.json();
    if (result.error_code) console.error("Twilio error:", result.message);
    return result;
  } catch (e) {
    console.error("SMS send error:", e.message);
    return null;
  }
}

function smsConfirmationText(dateStr, service) {
  return `${SALON_NAME}: Appt confirmed!\n📅 ${dateStr}\n💅 ${service}`;
}

function smsCancelText(dateStr, siteUrl) {
  return `${SALON_NAME}: Your appt on ${dateStr} has been cancelled. Book at ${siteUrl}`;
}

function smsRescheduleText(newDateStr, manageUrl) {
  return `${SALON_NAME}: Appt rescheduled to ${newDateStr}. Manage: ${manageUrl}`;
}

function ownerSummary(booking) {
  const addons = booking.addons.length ? " + " + booking.addons.map(a => a.name).join(", ") : "";
  return `${booking.name} · ${booking.service.name}${addons} · ${booking.phone}`;
}

async function textOwner(text) {
  if (!NOTIFY_PHONE) return;
  try { await sendSMS(NOTIFY_PHONE, `${SALON_NAME}: ${text}`); }
  catch (e) { console.error("Owner SMS failed (non-fatal):", e.message); }
}

function smsReminderText(customerName, dateStr, manageUrl) {
  return `Hi ${firstNameOf(customerName)}! ${SALON_NAME}\n📅 ${dateStr}\n\nReply YES to confirm.\nManage/Cancel: ${manageUrl}`;
}

// ── Response + validation helpers ────────────────────────────────────────────

const JSON_HEADERS = { "Content-Type": "application/json" };
function json(obj, statusCode = 200) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}
// Expected failures return { error } so the front end can show the message
function fail(message, statusCode = 200) { return json({ error: message }, statusCode); }

function parseJson(raw) {
  try { return JSON.parse(raw || "{}"); } catch (e) { return null; }
}

function cleanItem(x) {
  if (!x || typeof x.id !== "string" || typeof x.name !== "string") return null;
  if (!Number.isInteger(x.price) || x.price < 0 || x.price > 1000000) return null;
  const item = { id: x.id.slice(0, 64), name: x.name.slice(0, 100), price: x.price };
  // Optional display text for ranged prices, e.g. "$100–$120"
  if (typeof x.priceDisplay === "string") item.priceDisplay = x.priceDisplay.slice(0, 20);
  return item;
}

function validateNewBooking(p) {
  const name  = typeof p.name  === "string" ? p.name.trim()  : "";
  const email = typeof p.email === "string" ? p.email.trim() : "";
  const phone = typeof p.phone === "string" ? p.phone.trim() : "";
  if (!name || name.length > 100) return { error: "Please enter your full name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { error: "Please enter a valid email address." };
  if (digitsOnly(phone).length < 10 || phone.length > 30) return { error: "Please enter a valid phone number." };
  const dur = p.durationMinutes;
  if (!Number.isInteger(dur) || dur < 5 || dur > 480) return { error: "Invalid appointment length." };
  const service = cleanItem(p.service);
  if (!service) return { error: "Please choose a service." };
  const addons = Array.isArray(p.addons) && p.addons.length <= 10 ? p.addons.map(cleanItem) : null;
  if (!addons || addons.includes(null)) return { error: "Invalid add-ons." };
  return { value: {
    name, email, phone, dur, service, addons,
    smsOptIn: p.smsOptIn !== false,
    startMs: Date.parse(p.startAt),
  } };
}

function wildcardRegex(pattern) {
  const body = pattern.trim().split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + body + "$", "i");
}

function dashboardRow(b) {
  return {
    bookingId: b.id, name: b.name, email: b.email, phone: b.phone,
    smsOptIn: b.smsOptIn === false ? "NO" : "YES",
    service: b.service.name,
    addons: b.addons.map(a => a.name).join(", "),
    appointmentDate: fmtChicago(b.start_at),
    start_at: b.start_at, status: b.status,
    confirmed: !!b.confirmed, reminderSent: b.reminderSent || null,
  };
}

// ── Booking operations ───────────────────────────────────────────────────────

async function moveBooking(store, existing, newStartAt) {
  const startMs = Date.parse(newStartAt);
  const err = await checkSlot(store, startMs, existing.duration_minutes, existing.id);
  if (err) return { error: err };
  const previousDay = chicagoDateStr(Date.parse(existing.start_at));
  const updated = {
    ...existing,
    start_at: new Date(startMs).toISOString(),
    confirmed: false, reminderSent: null,
    seq: (existing.seq || 0) + 1,
    updated_at: new Date().toISOString(),
  };
  await saveBooking(store, updated, previousDay);
  return { booking: updated };
}

async function cancelBooking(store, existing, status) {
  const updated = { ...existing, status, seq: (existing.seq || 0) + 1, updated_at: new Date().toISOString() };
  await saveBooking(store, updated, null);
  return updated;
}

// `notifyCustomer: false` (staff change with the notify box unchecked) skips the customer's
// email and text; Liza's copy and text always go out.
async function notifyCancelled(booking, byStaff, ctx, notifyCustomer = true) {
  const dateStr = fmtChicago(booking.start_at);
  if (notifyCustomer && booking.phone) {
    await sendSMS(booking.phone, smsCancelText(dateStr, ctx.siteUrl))
      .catch(e => console.error("Cancel SMS failed:", e.message));
  }
  await Promise.all([
    sendEmailWithCopy(ctx, booking, {
      subject: "Appointment Cancelled – " + SALON_NAME,
      html: cancellationEmail({ booking, byStaff, siteUrl: ctx.siteUrl }),
      method: "CANCEL", toCustomer: notifyCustomer,
    }).catch(e => console.error("Cancel email failed:", e.message)),
    textOwner(`Appointment cancelled${byStaff ? " (by staff)" : " (by customer)"}\n${dateStr}\n${ownerSummary(booking)}`),
  ]);
}

async function notifyRescheduled(booking, byStaff, ctx, { notifyCustomer = true, previousStartAt } = {}) {
  const dateStr = fmtChicago(booking.start_at);
  const manageUrl = ctx.siteUrl + "?manage=" + makeManageToken(booking.id, ctx.secret);
  if (notifyCustomer && booking.phone) {
    await sendSMS(booking.phone, smsRescheduleText(dateStr, manageUrl))
      .catch(e => console.error("Reschedule SMS failed:", e.message));
  }
  await Promise.all([
    sendEmailWithCopy(ctx, booking, {
      subject: "Appointment Rescheduled – " + SALON_NAME,
      html: rescheduleEmail({ booking, manageUrl, byStaff }),
      method: "REQUEST", manageUrl, toCustomer: notifyCustomer,
    }).catch(e => console.error("Reschedule email failed:", e.message)),
    textOwner(`Appointment changed${byStaff ? " (by staff)" : " (by customer)"}\n` +
      (previousStartAt ? `Was: ${fmtChicago(previousStartAt)}\n` : "") +
      `Now: ${dateStr}\n${ownerSummary(booking)}`),
  ]);
}

async function createBooking(store, payload, ctx) {
  const v = validateNewBooking(payload);
  if (v.error) return fail(v.error);
  const val = v.value;

  const slotErr = await checkSlot(store, val.startMs, val.dur, null);
  if (slotErr) return fail(slotErr);

  const nowIso = new Date().toISOString();
  const booking = {
    id: crypto.randomBytes(5).toString("hex"),
    status: "BOOKED",
    start_at: new Date(val.startMs).toISOString(),
    duration_minutes: val.dur,
    service: val.service,
    addons: val.addons,
    name: val.name, email: val.email, phone: val.phone,
    smsOptIn: val.smsOptIn,
    confirmed: false, reminderSent: null, seq: 0,
    created_at: nowIso, updated_at: nowIso,
  };
  await saveBooking(store, booking, null);

  // Two people can grab the same slot at the same moment: re-check after writing
  // and let the earlier booking win.
  const day = chicagoDateStr(val.startMs);
  const sameDay = await loadDay(store, day);
  const earlier = sameDay.filter(o =>
    o.id !== booking.id && o.status === "BOOKED" &&
    overlaps(val.startMs, val.dur, Date.parse(o.start_at), o.duration_minutes) &&
    (o.created_at < booking.created_at || (o.created_at === booking.created_at && o.id < booking.id)));
  if (earlier.length >= MAX_CONCURRENT) {
    await store.delete("day/" + day + "/" + booking.id);
    await store.delete("idx/" + booking.id);
    return fail("Sorry, that time was just booked. Please choose another.");
  }

  const dateStr   = fmtChicago(booking.start_at);
  const manageUrl = ctx.siteUrl + "?manage=" + makeManageToken(booking.id, ctx.secret);
  const addonList = booking.addons.map(a => a.name).join(", ");

  // 1. Confirmation email to the customer, plus Liza's own copy (both with a calendar invite),
  //    and a text to Liza. Run together so the customer isn't kept waiting.
  await Promise.all([
    sendEmailWithCopy(ctx, booking, {
      subject: "Appointment Confirmed – " + SALON_NAME,
      html: confirmationEmail({ booking, manageUrl }),
      method: "REQUEST", manageUrl, toCustomer: true,
    }).catch(e => console.error("Email error:", e.message)),
    textOwner(`New appointment\n${dateStr}\n${ownerSummary(booking)}`),
  ]);

  // 2. Optional log to Google Sheet
  if (ctx.scriptUrl) {
    await Promise.all([
      writeToSheet(ctx.scriptUrl, {
        sheet: "Customers", name: booking.name, email: booking.email, phone: booking.phone,
        smsOptIn: booking.smsOptIn ? "YES" : "NO", forceUpdateOptIn: true,
        createdAt: booking.created_at,
      }),
      writeToSheet(ctx.scriptUrl, {
        sheet: "Appointments", bookingId: booking.id,
        name: booking.name, email: booking.email, service: booking.service.name,
        addons: addonList, appointmentDate: dateStr,
        status: "Confirmed", bookedAt: booking.created_at,
      }),
    ]);
  }

  // 3. SMS confirmation to the customer (never blocks or fails the booking)
  if (booking.smsOptIn && booking.phone) {
    try {
      await sendSMS(booking.phone, smsConfirmationText(dateStr, booking.service.name));
    } catch (e) { console.error("SMS confirmation failed (non-fatal):", e.message); }
  }

  return json({ booking });
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleEvent(event) {
  const SECRET = process.env.MANAGE_TOKEN_SECRET;
  const earlyPath = (event.queryStringParameters?.path || "").replace(/^\/v2(?=\/)/, "");
  // Browsing open times and the staff password check don't use the signing secret;
  // everything else (bookings, manage links, reminders) does.
  if (!SECRET && earlyPath !== "/availability" && earlyPath !== "/staff/auth-check") {
    return fail("Booking isn't set up yet: add the MANAGE_TOKEN_SECRET environment variable in Netlify and redeploy.", 500);
  }

  const ctx = {
    secret:    SECRET,
    siteUrl:   process.env.SITE_URL || "https://monalizanails.netlify.app",
    resendKey: process.env.RESEND_API_KEY,
    scriptUrl: process.env.GOOGLE_SCRIPT_URL,
  };
  const method = event.httpMethod;
  const path   = (event.queryStringParameters?.path || "").replace(/^\/v2(?=\/)/, "");
  const store  = await storeFactory(event);

  const isSms = path.startsWith("/sms/");
  if (!isSms && method !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  // ── SMS: inbound reply from Twilio (YES = confirm, STOP = unsubscribe) ─────
  if (path === "/sms/inbound") {
    const params = new URLSearchParams(event.body || "");
    const digits = digitsOnly(params.get("From") || "").slice(-10);
    const reply  = (params.get("Body") || "").trim().toUpperCase();
    const today  = chicagoDateStr(Date.now());
    const upcoming = digits.length === 10
      ? (await loadRange(store, today, addDaysStr(today, SEARCH_WINDOW_DAYS)))
          .filter(b => b.status === "BOOKED" && digitsOnly(b.phone).slice(-10) === digits)
      : [];
    const xml = body => ({ statusCode: 200, headers: { "Content-Type": "text/xml" },
      body: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>` });

    if (reply === "YES" || reply === "Y") {
      if (upcoming[0]) {
        const b = upcoming[0];
        await saveBooking(store, { ...b, confirmed: true, updated_at: new Date().toISOString() }, null);
        await writeToSheet(ctx.scriptUrl, { sheet: "Appointments", action: "update", bookingId: b.id, confirmed: true });
      }
      return xml(`<Message>You're confirmed! See you soon at ${SALON_NAME}. Reply STOP to unsubscribe.</Message>`);
    }
    if (reply === "STOP" || reply === "UNSUBSCRIBE") {
      for (const b of upcoming) {
        await saveBooking(store, { ...b, smsOptIn: false, updated_at: new Date().toISOString() }, null);
      }
      return xml("");
    }
    return xml(`<Message>Thanks! To manage your appointment visit ${ctx.siteUrl}. Reply STOP to unsubscribe.</Message>`);
  }

  // ── SMS: daily reminder job (called by cron-job.org) ───────────────────────
  if (path === "/sms/reminders") {
    const cronSecret = event.headers?.["x-cron-secret"] || event.headers?.["X-Cron-Secret"] || "";
    if (!process.env.CRON_SECRET || !safeEqual(cronSecret, process.env.CRON_SECRET)) {
      return fail("Unauthorized", 403);
    }
    // Appointments 2 days from now (Chicago time)
    const target = chicagoDateStr(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const appts  = await loadDay(store, target);
    let sent = 0, skipped = 0;
    for (const b of appts) {
      if (b.status !== "BOOKED" || !b.phone || b.smsOptIn === false || b.reminderSent) { skipped++; continue; }
      const manageUrl = ctx.siteUrl + "?manage=" + makeManageToken(b.id, SECRET);
      const result = await sendSMS(b.phone, smsReminderText(b.name, fmtChicago(b.start_at), manageUrl));
      if (result && !result.error_code) {
        const stamp = new Date().toISOString();
        await saveBooking(store, { ...b, reminderSent: stamp, updated_at: stamp }, null);
        await writeToSheet(ctx.scriptUrl, { sheet: "Appointments", action: "update", bookingId: b.id, reminderSent: stamp });
        sent++;
      } else { skipped++; }
    }
    return json({ success: true, sent, skipped });
  }

  const body = parseJson(event.body);
  if (body === null) return fail("Invalid JSON", 400);

  // ── Availability for a date (used by booking, manage and staff pages) ──────
  if (path === "/availability") {
    const dur = body.durationMinutes;
    if (!isValidDateStr(body.date) || !Number.isInteger(dur) || dur < 5 || dur > 480) {
      return fail("Invalid request", 400);
    }
    const exclude = typeof body.excludeBookingId === "string" ? body.excludeBookingId : null;
    return json({ slots: await availableSlots(store, body.date, dur, exclude) });
  }

  // ── Create booking ─────────────────────────────────────────────────────────
  if (path === "/bookings") return createBooking(store, body, ctx);

  // ── Customer manage page ───────────────────────────────────────────────────
  if (path === "/bookings/verify-token") {
    const id = verifyManageToken(body.token, SECRET);
    if (!id) return json({ valid: false, error: "Invalid or expired link" });
    const b = await getBooking(store, id);
    if (!b) return json({ valid: false, error: "Booking not found" });
    if (b.status !== "BOOKED") {
      return json({ valid: false, error: "This appointment has been cancelled and can no longer be managed." });
    }
    return json({ valid: true, booking: b });
  }

  if (path === "/bookings/cancel") {
    const verifiedId = verifyManageToken(body.token, SECRET);
    if (!verifiedId || verifiedId !== body.bookingId) return fail("Invalid token", 403);
    const existing = await getBooking(store, verifiedId);
    if (!existing) return fail("Booking not found", 404);
    if (existing.status !== "BOOKED") return fail("This appointment has already been cancelled.");
    if (within24h(existing.start_at)) {
      return json({ error: "within24h", message: "This appointment cannot be cancelled — it starts within 24 hours." });
    }
    const updated = await cancelBooking(store, existing, "CANCELLED_BY_CUSTOMER");
    await notifyCancelled(updated, false, ctx);
    await writeToSheet(ctx.scriptUrl, { sheet: "Appointments", action: "update", bookingId: updated.id, status: "Cancelled" });
    return json({ success: true, booking: updated });
  }

  if (path === "/bookings/reschedule") {
    const verifiedId = verifyManageToken(body.token, SECRET);
    if (!verifiedId || verifiedId !== body.bookingId) return fail("Invalid token", 403);
    const existing = await getBooking(store, verifiedId);
    if (!existing) return fail("Booking not found", 404);
    if (existing.status !== "BOOKED") return fail("This appointment has been cancelled.");
    if (within24h(existing.start_at)) {
      return json({ error: "within24h", message: "This appointment cannot be rescheduled — it starts within 24 hours." });
    }
    const moved = await moveBooking(store, existing, body.newStartAt);
    if (moved.error) return fail(moved.error);
    await notifyRescheduled(moved.booking, false, ctx, { previousStartAt: existing.start_at });
    await writeToSheet(ctx.scriptUrl, {
      sheet: "Appointments", action: "update", bookingId: moved.booking.id,
      status: "Rescheduled", appointmentDate: fmtChicago(moved.booking.start_at),
    });
    return json({ success: true, booking: moved.booking });
  }

  // ── Staff ──────────────────────────────────────────────────────────────────
  if (path === "/staff/auth-check") {
    const pw = process.env.STAFF_PASSWORD;
    const valid = !!pw && typeof body.staffPassword === "string" && safeEqual(body.staffPassword, pw);
    return json({ valid });
  }

  if (path.startsWith("/staff/") || path.startsWith("/bookings/staff-")) {
    const pw = process.env.STAFF_PASSWORD;
    if (!pw || typeof body.staffPassword !== "string" || !safeEqual(body.staffPassword, pw)) {
      return fail("Invalid staff password", 403);
    }
  }

  if (path === "/bookings/staff-lookup") {
    if (!body.bookingId) return fail("bookingId required", 400);
    const b = await getBooking(store, String(body.bookingId));
    if (!b) return fail("Booking not found");
    return json({ booking: b, token: makeManageToken(b.id, SECRET) });
  }

  if (path === "/bookings/staff-search") {
    const { firstName, lastName, phone, includeCancelled } = body;
    const phoneDigits = digitsOnly(phone);
    if (phone && phoneDigits.length < 7) return fail("Enter at least 7 digits of the phone number.");
    const firstRe = firstName && firstName.trim() ? wildcardRegex(firstName) : null;
    const lastRe  = lastName  && lastName.trim()  ? wildcardRegex(lastName)  : null;
    if (!phoneDigits && !firstRe && !lastRe) return fail("Enter a name or phone number.");

    const today = chicagoDateStr(Date.now());
    const all = await loadRange(store, today, addDaysStr(today, SEARCH_WINDOW_DAYS));
    const matched = all.filter(b => {
      if (!includeCancelled && b.status !== "BOOKED") return false;
      if (phoneDigits) return digitsOnly(b.phone).endsWith(phoneDigits);
      const parts = (b.name || "").trim().split(/\s+/);
      const first = parts[0] || "";
      const last  = parts.length > 1 ? parts[parts.length - 1] : "";
      return (!firstRe || firstRe.test(first)) && (!lastRe || lastRe.test(last));
    }).map(b => ({ ...b, _token: makeManageToken(b.id, SECRET) }));
    return json({ bookings: matched });
  }

  if (path === "/bookings/staff-cancel") {
    const existing = await getBooking(store, String(body.bookingId || ""));
    if (!existing) return fail("Booking not found");
    if (existing.status !== "BOOKED") return fail("This appointment is already cancelled.");
    const updated = await cancelBooking(store, existing, "CANCELLED_BY_SELLER");
    await writeToSheet(ctx.scriptUrl, { sheet: "Appointments", action: "update", bookingId: updated.id, status: "Cancelled (Staff)" });
    await notifyCancelled(updated, true, ctx, !!body.notifyCustomer);
    return json({ success: true });
  }

  if (path === "/bookings/staff-reschedule") {
    const existing = await getBooking(store, String(body.bookingId || ""));
    if (!existing) return fail("Booking not found");
    if (existing.status !== "BOOKED") return fail("This appointment has been cancelled.");
    const moved = await moveBooking(store, existing, body.newStartAt);
    if (moved.error) return fail(moved.error);
    await writeToSheet(ctx.scriptUrl, {
      sheet: "Appointments", action: "update", bookingId: moved.booking.id,
      status: "Rescheduled (Staff)", appointmentDate: fmtChicago(moved.booking.start_at),
    });
    await notifyRescheduled(moved.booking, true, ctx, { notifyCustomer: !!body.notifyCustomer, previousStartAt: existing.start_at });
    return json({ success: true, booking: moved.booking });
  }

  if (path === "/staff/confirm") {
    const existing = await getBooking(store, String(body.bookingId || ""));
    if (!existing) return fail("Booking not found");
    await saveBooking(store, { ...existing, confirmed: true, updated_at: new Date().toISOString() }, null);
    await writeToSheet(ctx.scriptUrl, { sheet: "Appointments", action: "update", bookingId: existing.id, confirmed: true });
    return json({ success: true });
  }

  if (path === "/staff/send-reminder") {
    const existing = await getBooking(store, String(body.bookingId || ""));
    if (!existing) return fail("Booking not found");
    if (!existing.phone) return fail("No phone number");
    const manageUrl = ctx.siteUrl + "?manage=" + makeManageToken(existing.id, SECRET);
    const result = await sendSMS(existing.phone, smsReminderText(existing.name, fmtChicago(existing.start_at), manageUrl));
    if (result && !result.error_code) {
      const stamp = new Date().toISOString();
      await saveBooking(store, { ...existing, reminderSent: stamp, updated_at: stamp }, null);
      await writeToSheet(ctx.scriptUrl, { sheet: "Appointments", action: "update", bookingId: existing.id, reminderSent: stamp });
      return json({ success: true });
    }
    return fail(result?.message || "SMS failed");
  }

  if (path === "/staff/dashboard") {
    const { startDate, endDate } = body;
    if (!isValidDateStr(startDate) || !isValidDateStr(endDate) || endDate < startDate) {
      return json({ error: "Invalid date range", appointments: [] });
    }
    const end = endDate > addDaysStr(startDate, 62) ? addDaysStr(startDate, 62) : endDate;
    const all = await loadRange(store, startDate, end);
    return json({ appointments: all.filter(b => b.status === "BOOKED").map(dashboardRow) });
  }

  return fail("Not found", 404);
}

// Netlify Functions entry point (modern Request/Response signature)
export default async (req) => {
  const url = new URL(req.url);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const result = await handleEvent({
    httpMethod: req.method,
    queryStringParameters: { path: url.searchParams.get("path") || "" },
    headers: Object.fromEntries(req.headers),
    body: hasBody ? await req.text() : null,
  });
  return new Response(result.body, { status: result.statusCode, headers: result.headers });
};

// Exposed for tests only
export const _internals = {
  setStoreFactory(fn) { storeFactory = fn; },
  chicagoToUtcMs, chicagoDateStr, slotStartsForDate, isSlotFree, buildIcs, icsFold,
};
