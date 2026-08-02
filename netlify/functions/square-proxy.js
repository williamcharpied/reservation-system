const crypto = require("crypto");

// ── Helpers ──────────────────────────────────────────────────────────────────

function squareHeaders(token) {
  return {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "Square-Version": "2024-01-18",
  };
}

async function squareFetch(token, method, path, body) {
  const r = await fetch("https://connect.squareup.com" + path, {
    method,
    headers: squareHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// Simple HMAC token: bookingId + expiry, signed with SQUARE_TOKEN as secret
// This doesn't need a separate secret — the Square token is never exposed client-side
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
  } catch(e) { return null; }
}

function fmtChicago(isoStr) {
  return new Date(isoStr).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }) + " CDT";
}

function within24h(startAt) {
  return (new Date(startAt).getTime() - Date.now()) < 24 * 60 * 60 * 1000;
}

// Parse email and name from seller note format:
// "Booked via custom booking page. Name | email | phone | Add-ons: ..."
function parseSellerNote(note) {
  const result = { name: null, email: null, phone: null, addons: null };
  if (!note) return result;
  const addonMatch = (note || "").match(/Add-ons: (.+)/);
  if (addonMatch) result.addons = addonMatch[1];
  // Extract the "Name | email | phone" part after "booking page. "
  const contactMatch = note.match(/(?:booking page\.\s*)?(.+?)(?:\s*\|?\s*Add-ons:|$)/);
  if (contactMatch) {
    const parts = contactMatch[1].split("|").map(s => s.trim());
    if (parts[0]) result.name  = parts[0];
    if (parts[1]) result.email = parts[1];
    if (parts[2]) result.phone = parts[2];
  }
  return result;
}

async function sendEmail(resendKey, { from, to, subject, html }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  return r.json();
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
  } catch(e) {
    if (e.name === "AbortError") {
      console.error("Sheet write timed out (>4s):", data.sheet);
    } else {
      console.error("Sheet write error:", e.message);
    }
  }
}

function confirmationEmail({ booking, customerName, customerEmail, addons, service, staffName, manageUrl, siteUrl }) {
  const dateStr = fmtChicago(booking.start_at);
  const seg = booking.appointment_segments?.[0];
  const totalPrice = (service ? service.price : 0) + (addons ? addons.reduce((s,a)=>s+a.price,0) : 0);

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF8F4;font-family:'Georgia',serif;">
  <div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #E8E3DC;border-radius:12px;overflow:hidden;">
    <div style="background:#1A1714;padding:28px 32px;text-align:center;">
      <div style="font-family:'Georgia',serif;font-size:24px;color:#FAF8F4;letter-spacing:0.05em;">Mona Liza Nails</div>
      <div style="font-size:11px;color:#A09890;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px;">1514 W Ardmore Ave · Chicago, IL</div>
    </div>
    <div style="padding:32px;">
      <div style="font-size:22px;margin-bottom:6px;">You're all booked, ${customerName.split(" ")[0]}! ✓</div>
      <div style="font-size:14px;color:#6B6560;margin-bottom:24px;">We look forward to seeing you. Here are your appointment details.</div>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
        <tr style="border-bottom:1px solid #E8E3DC;">
          <td style="padding:10px 0;color:#6B6560;width:110px;">Date & Time</td>
          <td style="padding:10px 0;font-weight:600;">${dateStr}</td>
        </tr>
        ${service ? `<tr style="border-bottom:1px solid #E8E3DC;">
          <td style="padding:10px 0;color:#6B6560;">Service</td>
          <td style="padding:10px 0;font-weight:500;">${service.name}<span style="float:right;color:#6B6560;">$${(service.price/100).toFixed(0)}</span></td>
        </tr>` : ""}
        ${addons && addons.length ? addons.map(a => `<tr style="border-bottom:1px solid #E8E3DC;">
          <td style="padding:10px 0;color:#6B6560;">Add-On</td>
          <td style="padding:10px 0;color:#C4956A;">+ ${a.name}<span style="float:right;">+$${(a.price/100).toFixed(0)}</span></td>
        </tr>`).join("") : ""}
        <tr style="border-bottom:1px solid #E8E3DC;">
          <td style="padding:10px 0;color:#6B6560;">Duration</td>
          <td style="padding:10px 0;">${seg ? seg.duration_minutes + " min" : ""}</td>
        </tr>
        ${staffName ? `<tr style="border-bottom:1px solid #E8E3DC;">
          <td style="padding:10px 0;color:#6B6560;">Nail Tech</td>
          <td style="padding:10px 0;">${staffName}</td>
        </tr>` : ""}
        <tr>
          <td style="padding:10px 0;color:#6B6560;font-weight:600;">Total</td>
          <td style="padding:10px 0;font-weight:600;">$${(totalPrice/100).toFixed(0)}</td>
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
        Questions? Call <a href="tel:7735436527" style="color:#6B6560;">(773) 543-6527</a> or reply to this email.
      </div>
    </div>
    <div style="background:#FAF8F4;border-top:1px solid #E8E3DC;padding:16px 32px;text-align:center;font-size:11px;color:#A09890;">
      Mona Liza Nails · 1514 W Ardmore Ave, Chicago IL 60660
    </div>
  </div>
  </body></html>`;
}

function addonAlertEmail({ booking, addonList, dateStr }) {
  return `<div style="font-family:sans-serif;max-width:480px;color:#1A1714;">
    <h2 style="margin-bottom:4px;">📋 Add-On Booking Alert</h2>
    <p style="color:#6B6560;margin-top:0;">Please update the pricing in Square.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
      <tr><td style="padding:8px 0;border-bottom:1px solid #E8E3DC;color:#6B6560;width:120px;">Booking ID</td><td style="padding:8px 0;border-bottom:1px solid #E8E3DC;">${booking.id}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #E8E3DC;color:#6B6560;">Date & Time</td><td style="padding:8px 0;border-bottom:1px solid #E8E3DC;">${dateStr}</td></tr>
      <tr><td style="padding:8px 0;color:#6B6560;">Add-Ons</td><td style="padding:8px 0;font-weight:600;color:#C4956A;">${addonList}</td></tr>
    </table>
  </div>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  const SQUARE_TOKEN  = process.env.SQUARE_TOKEN;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const SITE_URL      = process.env.SITE_URL || "https://monalizanails.netlify.app";

  if (!SQUARE_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "SQUARE_TOKEN not configured" }) };
  }

  const method = event.httpMethod;
  const path   = event.queryStringParameters?.path || "";

  // Resolve tech name from team member ID via Square API (cached per request)
  let _teamMapCache = null;
  async function resolveTech(teamMemberId) {
    if (!teamMemberId) return null;
    if (!_teamMapCache) {
      try {
        const r = await squareFetch(SQUARE_TOKEN, "GET",
          "/v2/bookings/team-member-booking-profiles?bookable_only=false&limit=100"
        );
        _teamMapCache = {};
        for (const p of (r.team_member_booking_profiles || [])) {
          _teamMapCache[p.team_member_id] = p.display_name || null;
        }
      } catch(e) { _teamMapCache = {}; }
    }
    return _teamMapCache[teamMemberId] || null;
  }

  // ── GET: fetch bookable team members ─────────────────────────────────────────
  if (method === "GET" && path === "/v2/bookings/team-members") {
    const r = await squareFetch(SQUARE_TOKEN, "GET",
      "/v2/bookings/team-member-booking-profiles?bookable_only=true&limit=100"
    );
    const members = (r.team_member_booking_profiles || [])
      .filter(p => p.is_bookable)
      .map(p => ({
        id:   p.team_member_id,
        name: p.display_name || "Staff",
      }));
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members }),
    };
  }

  // ── GET: retrieve booking by ID (for manage page) ────────────────────────
  if (method === "GET" && path.startsWith("/v2/bookings/")) {
    const data = await squareFetch(SQUARE_TOKEN, "GET", path);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
  }

  // ── POST: verify manage token ─────────────────────────────────────────────
  if (method === "POST" && path === "/v2/bookings/verify-token") {
    const { token } = JSON.parse(event.body || "{}");
    const bookingId = verifyManageToken(token, SQUARE_TOKEN);
    if (!bookingId) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, error: "Invalid or expired link" }) };
    }
    const data = await squareFetch(SQUARE_TOKEN, "GET", "/v2/bookings/" + bookingId);
    if (!data.booking) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, error: "Booking not found" }) };
    }
    // Check booking status — cancelled/no-show bookings are no longer manageable
    const status = data.booking.status;
    if (status === "CANCELLED_BY_CUSTOMER" || status === "CANCELLED_BY_SELLER" || status === "NO_SHOW") {
      return { statusCode: 200, body: JSON.stringify({
        valid: false,
        error: "This appointment has been cancelled and can no longer be managed."
      })};
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ valid: true, booking: data.booking }) };
  }

  // ── POST: cancel booking ──────────────────────────────────────────────────
  if (method === "POST" && path === "/v2/bookings/cancel") {
    const { bookingId, token } = JSON.parse(event.body || "{}");
    // Verify token
    const verifiedId = verifyManageToken(token, SQUARE_TOKEN);
    if (!verifiedId || verifiedId !== bookingId) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invalid token" }) };
    }
    // Fetch booking to check 24h window
    const existing = await squareFetch(SQUARE_TOKEN, "GET", "/v2/bookings/" + bookingId);
    if (!existing.booking) {
      return { statusCode: 404, body: JSON.stringify({ error: "Booking not found" }) };
    }
    if (within24h(existing.booking.start_at)) {
      return { statusCode: 200, body: JSON.stringify({ error: "within24h",
        message: "This appointment cannot be cancelled — it starts within 24 hours." }) };
    }
    // Cancel it
    const result = await squareFetch(SQUARE_TOKEN, "POST", "/v2/bookings/" + bookingId + "/cancel", {
      booking_version: existing.booking.version,
    });
    if (result.errors && result.errors.length > 0) {
      return { statusCode: 200, body: JSON.stringify({ error: result.errors[0].detail || result.errors[0].code }) };
    }
    // Send cancellation SMS + email — parse contact from seller note
    if (RESEND_API_KEY || process.env.TWILIO_ACCOUNT_SID) {
      const contact = parseSellerNote(existing.booking.seller_note);
      const dateStr = fmtChicago(existing.booking.start_at);
      const SITE_URL_C = process.env.SITE_URL || "";
      // SMS
      if (contact.phone) {
        await sendSMS(contact.phone, smsCancelText(contact.name, dateStr, SITE_URL_C)).catch(e => console.error("Cancel SMS failed:", e.message));
      }
      if (contact.email) {
        const firstName = contact.name ? contact.name.split(" ")[0] : "there";
        await sendEmail(RESEND_API_KEY, {
          from: "Mona Liza Nails <bookings@monalizanails.com>",
          to: [contact.email],
          subject: "Appointment Cancelled – Mona Liza Nails",
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF8F4;font-family:'Georgia',serif;">
          <div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #E8E3DC;border-radius:12px;overflow:hidden;">
            <div style="background:#1A1714;padding:28px 32px;text-align:center;">
              <div style="font-size:24px;color:#FAF8F4;letter-spacing:0.05em;">Mona Liza Nails</div>
              <div style="font-size:11px;color:#A09890;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px;">1514 W Ardmore Ave · Chicago, IL</div>
            </div>
            <div style="padding:32px;">
              <div style="font-size:22px;margin-bottom:8px;">Appointment Cancelled</div>
              <p style="font-size:14px;color:#6B6560;">Hi ${firstName}, your appointment on <strong style="color:#1A1714;">${dateStr}</strong> has been cancelled.</p>
              <p style="font-size:14px;color:#6B6560;">We hope to see you again soon!</p>
              <a href="${SITE_URL}" style="display:inline-block;background:#1A1714;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;margin-top:8px;">Book a new appointment</a>
            </div>
            <div style="background:#FAF8F4;border-top:1px solid #E8E3DC;padding:16px 32px;text-align:center;font-size:11px;color:#A09890;">
              (773) 543-6527 · bookings@monalizanails.com
            </div>
          </div></body></html>`,
        }).catch(()=>{});
      }
    }
    // Update Appointments sheet status to Cancelled
    const SCRIPT_URL_C = process.env.GOOGLE_SCRIPT_URL;
    if (SCRIPT_URL_C) {
      await writeToSheet(SCRIPT_URL_C, {
        sheet:     "Appointments",
        action:    "update",
        bookingId: bookingId,
        status:    "Cancelled",
      });
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, booking: result.booking }) };
  }

  // ── POST: reschedule booking (date/time only) ─────────────────────────────
  if (method === "POST" && path === "/v2/bookings/reschedule") {
    const { bookingId, token, newStartAt, newTeamMemberId } = JSON.parse(event.body || "{}");
    const verifiedId = verifyManageToken(token, SQUARE_TOKEN);
    if (!verifiedId || verifiedId !== bookingId) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invalid token" }) };
    }
    const existing = await squareFetch(SQUARE_TOKEN, "GET", "/v2/bookings/" + bookingId);
    if (!existing.booking) {
      return { statusCode: 404, body: JSON.stringify({ error: "Booking not found" }) };
    }
    if (within24h(existing.booking.start_at)) {
      return { statusCode: 200, body: JSON.stringify({ error: "within24h",
        message: "This appointment cannot be rescheduled — it starts within 24 hours." }) };
    }
    // Update only start_at — keep everything else identical
    // Build updated appointment_segments — update team member if specified
    const existingSeg = existing.booking.appointment_segments?.[0] || {};
    const updatedSeg = {
      ...existingSeg,
      team_member_id: newTeamMemberId || existingSeg.team_member_id,
    };

    const result = await squareFetch(SQUARE_TOKEN, "PUT", "/v2/bookings/" + bookingId, {
      idempotency_key: "reschedule-" + bookingId + "-" + Date.now(),
      booking: {
        version: existing.booking.version,
        start_at: newStartAt,
        appointment_segments: [updatedSeg],
      }
    });
    if (result.errors && result.errors.length > 0) {
      return { statusCode: 200, body: JSON.stringify({ error: result.errors[0].detail || result.errors[0].code }) };
    }
    // Send reschedule SMS + email — parse contact from seller note
    if (RESEND_API_KEY || process.env.TWILIO_ACCOUNT_SID) {
      const contact = parseSellerNote(existing.booking.seller_note);
      const newDateStr = fmtChicago(newStartAt);
      const manageUrl  = SITE_URL + "?manage=" + makeManageToken(bookingId, SQUARE_TOKEN);
      // SMS
      if (contact.phone) {
        await sendSMS(contact.phone, smsRescheduleText(contact.name, newDateStr, manageUrl)).catch(e => console.error("Reschedule SMS failed:", e.message));
      }
      if (contact.email) {
        const firstName = contact.name ? contact.name.split(" ")[0] : "there";
        await sendEmail(RESEND_API_KEY, {
          from: "Mona Liza Nails <bookings@monalizanails.com>",
          to: [contact.email],
          subject: "Appointment Rescheduled – Mona Liza Nails",
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF8F4;font-family:'Georgia',serif;">
          <div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #E8E3DC;border-radius:12px;overflow:hidden;">
            <div style="background:#1A1714;padding:28px 32px;text-align:center;">
              <div style="font-size:24px;color:#FAF8F4;letter-spacing:0.05em;">Mona Liza Nails</div>
              <div style="font-size:11px;color:#A09890;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px;">1514 W Ardmore Ave · Chicago, IL</div>
            </div>
            <div style="padding:32px;">
              <div style="font-size:22px;margin-bottom:8px;">Appointment Rescheduled ✓</div>
              <p style="font-size:14px;color:#6B6560;">Hi ${firstName}, your appointment has been moved to:</p>
              <p style="font-size:18px;font-weight:600;color:#1A1714;margin:12px 0;">${newDateStr}</p>
              <div style="background:#FAF8F4;border:1px solid #E8E3DC;border-radius:8px;padding:16px;margin:16px 0;">
                <a href="${manageUrl}" style="display:block;background:#1A1714;color:#fff;text-align:center;padding:12px;border-radius:6px;text-decoration:none;font-size:14px;">Cancel or Reschedule Again</a>
                <div style="font-size:12px;color:#A09890;text-align:center;margin-top:8px;">Link valid for 30 days · Must cancel 24+ hours in advance</div>
              </div>
              <p style="font-size:12px;color:#A09890;">Cancellations within 24 hours will be charged 50% of the service cost.</p>
            </div>
            <div style="background:#FAF8F4;border-top:1px solid #E8E3DC;padding:16px 32px;text-align:center;font-size:11px;color:#A09890;">
              (773) 543-6527 · bookings@monalizanails.com
            </div>
          </div></body></html>`,
        }).catch(()=>{});
      }
    }
    // Update Appointments sheet with new date and status
    const SCRIPT_URL_R = process.env.GOOGLE_SCRIPT_URL;
    if (SCRIPT_URL_R) {
      await writeToSheet(SCRIPT_URL_R, {
        sheet:           "Appointments",
        action:          "update",
        bookingId:       bookingId,
        status:          "Rescheduled",
        appointmentDate: fmtChicago(newStartAt),
      });
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, booking: result.booking }) };
  }

  // ── POST: find-or-create customer (deduplicates via Google Sheet) ───────────
  if (method === "POST" && path === "/v2/customers/find-or-create") {
    const { name, email } = JSON.parse(event.body || "{}");
    const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    let customerId = null;

    // 1. Check Google Sheet for existing Square customer ID
    if (SCRIPT_URL && email) {
      try {
        const lookupUrl = SCRIPT_URL + "?action=lookup&email=" + encodeURIComponent(email);
            const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const r = await fetch(lookupUrl, { signal: controller.signal });
        clearTimeout(timeout);
        const result = await r.json();
            if (result.squareCustomerId) {
          customerId = result.squareCustomerId;
        }
      } catch(e) { console.error("find-or-create lookup error:", e.message); }
    }

    // 2. If not found, create new Square customer (name only — no contact info)
    if (!customerId) {
      const nameParts = (name || "").trim().split(" ");
      const created = await squareFetch(SQUARE_TOKEN, "POST", "/v2/customers", {
        given_name:  nameParts[0] || name,
        family_name: nameParts.slice(1).join(" ") || "",
      });
      if (created.customer) {
        customerId = created.customer.id;
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId }),
    };
  }

  // ── POST: validate staff password ────────────────────────────────────────
  if (method === "POST" && path === "/v2/staff/auth-check") {
    const body = JSON.parse(event.body || "{}");
    const STAFF_PASSWORD = process.env.STAFF_PASSWORD;
    const valid = STAFF_PASSWORD && body.staffPassword === STAFF_PASSWORD;
    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ valid }) };
  }

  // ── Staff auth helper ────────────────────────────────────────────────────
  function checkStaffAuth(body) {
    const STAFF_PASSWORD = process.env.STAFF_PASSWORD;
    if (!STAFF_PASSWORD) return false;
    const { staffPassword } = JSON.parse(body || "{}");
    return staffPassword === STAFF_PASSWORD;
  }

  // ── POST: staff lookup booking by ID ──────────────────────────────────────
  if (method === "POST" && path === "/v2/bookings/staff-lookup") {
    if (!checkStaffAuth(event.body)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invalid staff password" }) };
    }
    const { bookingId } = JSON.parse(event.body || "{}");
    if (!bookingId) {
      return { statusCode: 400, body: JSON.stringify({ error: "bookingId required" }) };
    }
    const data = await squareFetch(SQUARE_TOKEN, "GET", "/v2/bookings/" + bookingId.trim());
    if (!data.booking) {
      return { statusCode: 200, body: JSON.stringify({ error: "Booking not found" }) };
    }
    // Return booking with a staff manage token
    const staffToken = makeManageToken(data.booking.id, SQUARE_TOKEN);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking: data.booking, token: staffToken }),
    };
  }

  // ── POST: staff search by name or phone (via Google Sheet) ──────────────────
  if (method === "POST" && path === "/v2/bookings/staff-search") {
    if (!checkStaffAuth(event.body)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invalid staff password" }) };
    }
    const { firstName, lastName, phone, includeCancelled } = JSON.parse(event.body || "{}");
    console.log("staff-search called, firstName:", firstName, "lastName:", lastName, "phone:", phone);
    const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    if (!SCRIPT_URL) {
      return { statusCode: 200, body: JSON.stringify({ error: "Google Sheet not configured" }) };
    }

    // Normalise phone — strip everything except digits
    function digitsOnly(s) { return (s||"").replace(/\D/g, ""); }

    // Query Google Sheet for matching customers
    let searchUrl = SCRIPT_URL + "?action=search";
    if (phone) {
      searchUrl += "&phone=" + encodeURIComponent(digitsOnly(phone));
    } else {
      if (firstName) searchUrl += "&firstName=" + encodeURIComponent(firstName.trim());
      if (lastName)  searchUrl += "&lastName="  + encodeURIComponent(lastName.trim());
    }

    let matchingEmails = [];
    try {
      console.log("Fetching sheet:", searchUrl);
      const r = await fetch(searchUrl, { redirect: "follow" });
      console.log("Sheet status:", r.status);
      const sheetText = await r.text();
      console.log("Sheet response:", sheetText.slice(0, 200));
      const result = JSON.parse(sheetText);
      matchingEmails = result.emails || [];
    } catch(e) {
      console.error("Sheet fetch error:", e.message);
      return { statusCode: 200, body: JSON.stringify({ error: "Sheet search failed: " + e.message }) };
    }

    if (matchingEmails.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ bookings: [] }) };
    }

    // Fetch upcoming bookings in 30-day chunks (Square max window = 31 days)
    const LOC = "L3KS6XGBN12GV";
    let allBookings = [];
    try {
      const chunkMs = 30 * 24 * 60 * 60 * 1000;
      const numChunks = 2; // covers ~2 months (max booking window)
      for (let i = 0; i < numChunks; i++) {
        const start = new Date(Date.now() + i * chunkMs).toISOString();
        const end   = new Date(Date.now() + (i + 1) * chunkMs).toISOString();
        const bResult = await squareFetch(SQUARE_TOKEN, "GET",
          "/v2/bookings?location_id=" + LOC +
          "&start_at_min=" + encodeURIComponent(start) +
          "&start_at_max=" + encodeURIComponent(end) +
          "&limit=100"
        );
        if (bResult.bookings) allBookings = allBookings.concat(bResult.bookings);
      }
    } catch(e) {
      return { statusCode: 200, body: JSON.stringify({ error: "Booking fetch failed: " + e.message }) };
    }

    const CANCELLED = ["CANCELLED_BY_CUSTOMER","CANCELLED_BY_SELLER","NO_SHOW"];
    const matched = allBookings.filter(b => {
      // Filter cancelled unless explicitly included
      if (!includeCancelled && CANCELLED.includes(b.status)) return false;
      const note = (b.seller_note || "").toLowerCase();
      return matchingEmails.some(email => note.includes(email.toLowerCase()));
    }).map(b => ({
      ...b,
      _token: makeManageToken(b.id, SQUARE_TOKEN),
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookings: matched }),
    };
  }

  // ── POST: staff cancel (bypasses 24h window check) ───────────────────────
  if (method === "POST" && path === "/v2/bookings/staff-cancel") {
    if (!checkStaffAuth(event.body)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invalid staff password" }) };
    }
    const { bookingId, notifyCustomer } = JSON.parse(event.body || "{}");
    const existing = await squareFetch(SQUARE_TOKEN, "GET", "/v2/bookings/" + bookingId);
    if (!existing.booking) {
      return { statusCode: 200, body: JSON.stringify({ error: "Booking not found" }) };
    }
    const result = await squareFetch(SQUARE_TOKEN, "POST", "/v2/bookings/" + bookingId + "/cancel", {
      booking_version: existing.booking.version,
    });
    if (result.errors && result.errors.length > 0) {
      return { statusCode: 200, body: JSON.stringify({ error: result.errors[0].detail || result.errors[0].code }) };
    }
    // Update sheet
    const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    if (SCRIPT_URL) {
      await writeToSheet(SCRIPT_URL, {
        sheet: "Appointments", action: "update",
        bookingId, status: "Cancelled (Staff)",
      });
    }
    // Optionally notify customer (email + SMS)
    if (notifyCustomer) {
      const contact = parseSellerNote(existing.booking.seller_note);
      const staffCancelDateStr = fmtChicago(existing.booking.start_at);
      // SMS — Twilio silently drops delivery to numbers that replied STOP
      if (contact.phone) {
        await sendSMS(contact.phone, smsCancelText(contact.name, staffCancelDateStr, SITE_URL)).catch(e => console.error("Staff cancel SMS failed:", e.message));
      }
      if (RESEND_API_KEY && contact.email) {
        const firstName = contact.name ? contact.name.split(" ")[0] : "there";
        const dateStr = staffCancelDateStr;
        await sendEmail(RESEND_API_KEY, {
          from: "Mona Liza Nails <bookings@monalizanails.com>",
          to: [contact.email],
          subject: "Appointment Cancelled – Mona Liza Nails",
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF8F4;font-family:'Georgia',serif;">
          <div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #E8E3DC;border-radius:12px;overflow:hidden;">
            <div style="background:#1A1714;padding:28px 32px;text-align:center;">
              <div style="font-size:24px;color:#FAF8F4;letter-spacing:0.05em;">Mona Liza Nails</div>
              <div style="font-size:11px;color:#A09890;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px;">1514 W Ardmore Ave · Chicago, IL</div>
            </div>
            <div style="padding:32px;">
              <div style="font-size:22px;margin-bottom:8px;">Appointment Cancelled</div>
              <p style="font-size:14px;color:#6B6560;">Hi ${firstName}, your appointment on <strong style="color:#1A1714;">${dateStr}</strong> has been cancelled by the salon.</p>
              <p style="font-size:14px;color:#6B6560;">We apologize for any inconvenience. We hope to see you again soon!</p>
              <a href="${SITE_URL}" style="display:inline-block;background:#1A1714;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;margin-top:8px;">Book a new appointment</a>
            </div>
            <div style="background:#FAF8F4;border-top:1px solid #E8E3DC;padding:16px 32px;text-align:center;font-size:11px;color:#A09890;">
              (773) 543-6527 · bookings@monalizanails.com
            </div>
          </div></body></html>`,
        }).catch(()=>{});
      }
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true }) };
  }

  // ── POST: staff reschedule (bypasses 24h window check) ───────────────────
  if (method === "POST" && path === "/v2/bookings/staff-reschedule") {
    if (!checkStaffAuth(event.body)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invalid staff password" }) };
    }
    const { bookingId, newStartAt, newTeamMemberId, notifyCustomer } = JSON.parse(event.body || "{}");
    const existing = await squareFetch(SQUARE_TOKEN, "GET", "/v2/bookings/" + bookingId);
    if (!existing.booking) {
      return { statusCode: 200, body: JSON.stringify({ error: "Booking not found" }) };
    }
    const existingSeg = existing.booking.appointment_segments?.[0] || {};
    const updatedSeg = {
      ...existingSeg,
      team_member_id: newTeamMemberId || existingSeg.team_member_id,
    };
    const result = await squareFetch(SQUARE_TOKEN, "PUT", "/v2/bookings/" + bookingId, {
      idempotency_key: "staff-reschedule-" + bookingId + "-" + Date.now(),
      booking: {
        version: existing.booking.version,
        start_at: newStartAt,
        appointment_segments: [updatedSeg],
      }
    });
    if (result.errors && result.errors.length > 0) {
      return { statusCode: 200, body: JSON.stringify({ error: result.errors[0].detail || result.errors[0].code }) };
    }
    // Update sheet
    const SCRIPT_URL_SR = process.env.GOOGLE_SCRIPT_URL;
    if (SCRIPT_URL_SR) {
      await writeToSheet(SCRIPT_URL_SR, {
        sheet: "Appointments", action: "update",
        bookingId, status: "Rescheduled (Staff)",
        appointmentDate: fmtChicago(newStartAt),
      });
    }
    // Optionally notify customer (email + SMS)
    if (notifyCustomer) {
      const contact = parseSellerNote(existing.booking.seller_note);
      const newDateStr2 = fmtChicago(newStartAt);
      const manageUrl2  = SITE_URL + "?manage=" + makeManageToken(bookingId, SQUARE_TOKEN);
      // SMS — Twilio silently drops delivery to numbers that replied STOP
      if (contact.phone) {
        await sendSMS(contact.phone, smsRescheduleText(contact.name, newDateStr2, manageUrl2)).catch(e => console.error("Staff reschedule SMS failed:", e.message));
      }
      if (RESEND_API_KEY && contact.email) {
        const newDateStr = newDateStr2;
        const firstName = contact.name ? contact.name.split(" ")[0] : "there";
        const manageUrl = manageUrl2;
        await sendEmail(RESEND_API_KEY, {
          from: "Mona Liza Nails <bookings@monalizanails.com>",
          to: [contact.email],
          subject: "Appointment Rescheduled – Mona Liza Nails",
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF8F4;font-family:'Georgia',serif;">
          <div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #E8E3DC;border-radius:12px;overflow:hidden;">
            <div style="background:#1A1714;padding:28px 32px;text-align:center;">
              <div style="font-size:24px;color:#FAF8F4;letter-spacing:0.05em;">Mona Liza Nails</div>
              <div style="font-size:11px;color:#A09890;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px;">1514 W Ardmore Ave · Chicago, IL</div>
            </div>
            <div style="padding:32px;">
              <div style="font-size:22px;margin-bottom:8px;">Appointment Rescheduled ✓</div>
              <p style="font-size:14px;color:#6B6560;">Hi ${firstName}, your appointment has been moved to:</p>
              <p style="font-size:18px;font-weight:600;color:#1A1714;margin:12px 0;">${newDateStr}</p>
              <div style="background:#FAF8F4;border:1px solid #E8E3DC;border-radius:8px;padding:16px;margin:16px 0;">
                <a href="${manageUrl}" style="display:block;background:#1A1714;color:#fff;text-align:center;padding:12px;border-radius:6px;text-decoration:none;font-size:14px;">Cancel or Reschedule</a>
                <div style="font-size:12px;color:#A09890;text-align:center;margin-top:8px;">Link valid for 30 days</div>
              </div>
            </div>
            <div style="background:#FAF8F4;border-top:1px solid #E8E3DC;padding:16px 32px;text-align:center;font-size:11px;color:#A09890;">
              (773) 543-6527 · bookings@monalizanails.com
            </div>
          </div></body></html>`,
        }).catch(()=>{});
      }
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, booking: result.booking }) };
  }

  // ── POST: inbound SMS from Twilio (YES/Y confirmation, STOP unsubscribe) ──
  if (path === "/v2/sms/inbound") {
    const params = new URLSearchParams(event.body || "");
    const from   = params.get("From") || "";
    const body   = (params.get("Body") || "").trim().toUpperCase();
    const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    const SITE_URL   = process.env.SITE_URL || "";

    const digits = from.replace(/\D/g, "");

    if (body === "YES" || body === "Y") {
      if (SCRIPT_URL) {
        await fetch(SCRIPT_URL + "?action=confirm-by-phone&phone=" + encodeURIComponent(digits));
      }
      // Reply confirmation
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>You're confirmed! See you soon at Mona Liza Nails. Reply STOP to unsubscribe.</Message></Response>`;
      return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml };
    }

    if (body === "STOP" || body === "UNSUBSCRIBE") {
      if (SCRIPT_URL) {
        await fetch(SCRIPT_URL + "?action=unsubscribe&phone=" + encodeURIComponent(digits));
      }
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
      return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml };
    }

    // Any other reply — acknowledge
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>Thanks! To manage your appointment visit ${SITE_URL}. Reply STOP to unsubscribe.</Message></Response>`;
    return { statusCode: 200, headers: { "Content-Type": "text/xml" }, body: twiml };
  }

  // ── POST: reminder scheduler (called by cron-job.org daily at 5pm Chicago) ─
  if (path === "/v2/sms/reminders") {
    // Verify cron secret
    const cronSecret = event.headers?.["x-cron-secret"] || event.headers?.["X-Cron-Secret"];
    if (cronSecret !== process.env.CRON_SECRET) {
      return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    const SITE_URL   = process.env.SITE_URL || "";
    if (!SCRIPT_URL) return { statusCode: 200, body: JSON.stringify({ error: "No sheet" }) };

    // Get appointments 2 days from now (Chicago time)
    const now = new Date();
    // Build "Month Day" string for 2 days from now, e.g. "April 13"
    const target = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const targetStr = MONTHS[target.getMonth()] + " " + target.getDate();

    let appointments = [];
    try {
      const r = await fetch(SCRIPT_URL + "?action=upcoming&startDate=" + encodeURIComponent(targetStr));
      const result = await r.json();
      appointments = result.appointments || [];
    } catch(e) {
      return { statusCode: 200, body: JSON.stringify({ error: "Sheet fetch failed: " + e.message }) };
    }

    let sent = 0, skipped = 0;
    for (const appt of appointments) {
      // Skip cancelled appointments (sheet filters too, but double-check)
      const status = (appt.status || "").toString();
      if (status.includes("Cancelled") || status.includes("NO_SHOW")) { skipped++; continue; }
      const optIn = (appt.smsOptIn || "").toString().toUpperCase();
      if (!appt.phone) { skipped++; continue; }
      if (optIn === "NO" || optIn === "FALSE" || optIn === "0") { skipped++; continue; }
      if (appt.reminderSent) { skipped++; continue; } // already sent
      if (!appt.phone) { skipped++; continue; }

      const manageUrl = SITE_URL + "?manage=" + makeManageToken(appt.bookingId, SQUARE_TOKEN);
      const msg = smsReminderText(appt.name, appt.appointmentDate, manageUrl);
      const result = await sendSMS(appt.phone, msg);

      if (result && !result.error_code) {
        // Mark reminder sent in sheet
        await writeToSheet(SCRIPT_URL, {
          sheet: "Appointments", action: "update",
          bookingId: appt.bookingId,
          reminderSent: new Date().toISOString(),
        });
        sent++;
      }
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, sent, skipped }) };
  }

  // ── POST: staff mark appointment confirmed ────────────────────────────────
  if (method === "POST" && path === "/v2/staff/confirm") {
    if (!checkStaffAuth(event.body)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invalid staff password" }) };
    }
    const { bookingId } = JSON.parse(event.body || "{}");
    if (!bookingId) {
      return { statusCode: 200, body: JSON.stringify({ error: "bookingId required" }) };
    }
    const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    if (SCRIPT_URL) {
      await writeToSheet(SCRIPT_URL, {
        sheet: "Appointments", action: "update",
        bookingId, confirmed: true,
      });
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true }) };
  }

  // ── POST: staff send manual reminder ─────────────────────────────────────
  if (method === "POST" && path === "/v2/staff/send-reminder") {
    if (!checkStaffAuth(event.body)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invalid staff password" }) };
    }
    const { bookingId, phone, name, appointmentDate } = JSON.parse(event.body || "{}");
    if (!phone) return { statusCode: 200, body: JSON.stringify({ error: "No phone number" }) };
    const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    const SITE_URL   = process.env.SITE_URL || "";
    const manageUrl  = SITE_URL + "?manage=" + makeManageToken(bookingId, SQUARE_TOKEN);
    const result = await sendSMS(phone, smsReminderText(name, appointmentDate, manageUrl));
    if (result && !result.error_code) {
      // Mark reminder sent in sheet
      if (SCRIPT_URL) {
        await writeToSheet(SCRIPT_URL, {
          sheet: "Appointments", action: "update",
          bookingId, reminderSent: new Date().toISOString(),
        });
      }
      return { statusCode: 200, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true }) };
    }
    return { statusCode: 200, body: JSON.stringify({ error: result?.message || "SMS failed" }) };
  }

  // ── POST: staff confirmation dashboard ───────────────────────────────────
  if (method === "POST" && path === "/v2/staff/dashboard") {
    if (!checkStaffAuth(event.body)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Invalid staff password" }) };
    }
    const { startDate, endDate } = JSON.parse(event.body || "{}");
    const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
    if (!SCRIPT_URL) {
      return { statusCode: 200, body: JSON.stringify({ appointments: [] }) };
    }

    // Convert YYYY-MM-DD to month name + day for sheet matching
    const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    function toMonthDay(iso) {
      const d = new Date(iso + "T00:00:00");
      return MONTHS[d.getMonth()] + " " + d.getDate();
    }

    // Fetch all upcoming appointments from sheet
    // We'll filter by date range client-side since sheet stores human-readable dates
    let appointments = [];
    try {
      // Fetch a broad window and filter
      const r = await fetch(SCRIPT_URL + "?action=upcoming");
      const result = await r.json();
      const all = result.appointments || [];

      // Filter by date range — appointmentDate contains "Month Day" e.g. "April 13"
      // Build set of matching month-day strings for the range
      const start = new Date(startDate + "T00:00:00");
      const end   = new Date(endDate   + "T00:00:00");
      const matchDates = new Set();
      for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
        matchDates.add(MONTHS[d.getMonth()] + " " + d.getDate());
      }
      appointments = all.filter(a => {
        return Array.from(matchDates).some(md => a.appointmentDate.includes(md));
      });
      // Sort chronologically by parsing the human-readable date string
      appointments.sort((a, b) => {
        const parse = s => {
          try {
            return new Date(s.replace(/\s+at\s+/, " ").replace(/ CDT| CST| CT/, ""));
          } catch(e) { return new Date(0); }
        };
        return parse(a.appointmentDate) - parse(b.appointmentDate);
      });
    } catch(e) {
      return { statusCode: 200, body: JSON.stringify({ error: e.message, appointments: [] }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appointments }),
    };
  }

  // ── POST: availability search (for reschedule picker) ────────────────────
  if (method !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const ALLOWED_PATHS = [
    "/v2/bookings/availability/search",
    "/v2/bookings",
    "/v2/customers/search",
    "/v2/customers",
  ];
  if (!ALLOWED_PATHS.some(p => path === p || path.startsWith(p))) {
    return { statusCode: 403, body: JSON.stringify({ error: "Path not allowed" }) };
  }

  // ── POST /v2/bookings — create booking + send confirmation + addon alert ──
  if (path === "/v2/bookings") {
    let payload;
    try { payload = JSON.parse(event.body); } catch(e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    // Strip our extra fields before sending to Square
    const squarePayload = { ...payload };
    delete squarePayload._customerEmail;
    delete squarePayload._customerName;
    delete squarePayload._addons;
    delete squarePayload._service;
    delete squarePayload._staffName;
    delete squarePayload._phone;
    delete squarePayload._smsOptIn;
    // Don't pass customer_id — Square uses it to send their own confirmation
    // email which we can't suppress. Customer profile still gets created/found
    // above so the receptionist can manually link it on the calendar.
    // customer_id is kept — Square requires it for seller-level bookings
    // but customer profile is created WITHOUT email so Square has nowhere to send confirmation


    const br = await fetch("https://connect.squareup.com/v2/bookings", {
      method: "POST",
      headers: squareHeaders(SQUARE_TOKEN),
      body: JSON.stringify(squarePayload),
    });
    const bookingResult = await br.json();

    if (!(bookingResult.errors && bookingResult.errors.length > 0) && bookingResult.booking) {
      const b = bookingResult.booking;
      const sellerNote   = b.seller_note || "";
      const customerNote = b.customer_note || "";
      const hasAddons    = sellerNote.includes("Add-ons:") || customerNote.includes("Add-ons:");
      const addonMatch   = sellerNote.match(/Add-ons: (.+)/) || customerNote.match(/Add-ons: (.+)/);
      const addonList    = addonMatch ? addonMatch[1] : "";
      const dateStr      = fmtChicago(b.start_at);
      const manageToken  = makeManageToken(b.id, SQUARE_TOKEN);
      const manageUrl    = SITE_URL + "?manage=" + manageToken;

      const custEmail   = payload._customerEmail;
      const custName    = payload._customerName;
      const addons      = payload._addons || [];
      const service     = payload._service || null;
      // Resolve actual assigned tech from booking segment (overrides "First available tech")
      const assignedTechId = b.appointment_segments?.[0]?.team_member_id;
      const resolvedTech   = await resolveTech(assignedTechId);
      const staffName      = resolvedTech || (payload._staffName === "First available tech" ? "" : payload._staffName) || "";
      const custPhone   = payload._phone || "";
      const smsOptIn    = payload._smsOptIn !== false;

      // 1. Await email only — fast (~300ms), critical for customer experience
      if (custEmail) {
        try {
          await sendEmail(RESEND_API_KEY, {
            from: "Mona Liza Nails <bookings@monalizanails.com>",
            to: [custEmail],
            subject: "Appointment Confirmed – Mona Liza Nails",
            html: confirmationEmail({ booking: b, customerName: custName, customerEmail: custEmail,
              addons, service, staffName, manageUrl, siteUrl: SITE_URL }),
          });
        } catch(e) { console.error("Email error:", e.message); }
      }

      // 2. Sheet writes — fire-and-forget but use setTimeout(0) to defer past response
      // Apps Script is slow (~3-5s); we return to customer immediately then writes complete
      const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
      if (SCRIPT_URL) {
        const custData = {
          sheet: "Customers", name: custName||"", email: custEmail||"",
          phone: payload._phone||"", squareCustomerId: b.customer_id||"",
          smsOptIn: smsOptIn ? "YES" : "NO", forceUpdateOptIn: true,
          createdAt: new Date().toISOString(),
        };
        const apptData = {
          sheet: "Appointments", bookingId: b.id, squareCustomerId: b.customer_id||"",
          name: custName||"", email: custEmail||"", service: service ? service.name : "",
          addons: addonList||"", appointmentDate: dateStr, tech: staffName||"",
          status: "Confirmed", bookedAt: b.created_at || new Date().toISOString(),
        };
        await Promise.all([
          writeToSheet(SCRIPT_URL, custData),
          writeToSheet(SCRIPT_URL, apptData),
        ]);
      }

      // 3. SMS confirmation — isolated try/catch so errors never affect booking
      // 2. SMS — fire-and-forget (Twilio pending verification, never blocks response)

      if (smsOptIn && custPhone) {
        try {
          const smsManageUrl = (process.env.SITE_URL||"") + "?manage=" + makeManageToken(b.id, SQUARE_TOKEN);
          const svcName = service ? service.name : "your appointment";
          const _smsRes = await sendSMS(custPhone, smsConfirmationText(custName, dateStr, svcName, smsManageUrl, process.env.SITE_URL||""));
          console.log("SMS send result:", JSON.stringify(_smsRes)?.slice(0,150));
        } catch(e) { console.error("SMS confirmation failed (non-fatal):", e.message); }
      }

      // 2. Addon alert to salon
      if (hasAddons) {
            try {
          const r2 = await sendEmail(RESEND_API_KEY, {
            from: "Mona Liza Nails Booking <bookings@monalizanails.com>",
            to: ["bookings@monalizanails.com"],
            subject: `Add-On Booking: ${addonList} — ${dateStr}`,
            html: addonAlertEmail({ booking: b, addonList, dateStr }),
          });
              } catch(e) { console.error("Addon alert error:", e.message); }
      }
    }

    return {
      statusCode: 200, // always 200 — errors are in bookingResult.errors array
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingResult),
    };
  }

  // ── Standard proxy pass-through ──────────────────────────────────────────
  try {
    const response = await fetch("https://connect.squareup.com" + path, {
      method: "POST",
      headers: squareHeaders(SQUARE_TOKEN),
      body: event.body,
    });
    const data = await response.text();
    return {
      statusCode: response.status,
      headers: { "Content-Type": "application/json" },
      body: data,
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: "Proxy error", detail: err.message }) };
  }
};

// ── TWILIO SMS HELPERS ────────────────────────────────────────────────────────

async function sendSMS(to, body) {
  const SID   = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM  = process.env.TWILIO_FROM_NUMBER;
  if (!SID || !TOKEN || !FROM) { console.error("Twilio not configured"); return null; }
  const digits = (to || "").replace(/\D/g, "");
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
  } catch(e) {
    console.error("SMS send error:", e.message);
    return null;
  }
}

function smsConfirmationText(customerName, dateStr, service, manageUrl, siteUrl) {
  return `Mona Liza Nails: Appt confirmed!\n📅 ${dateStr}\n💅 ${service}`;
}

function smsCancelText(customerName, dateStr, siteUrl) {
  return `Mona Liza Nails: Your appt on ${dateStr} has been cancelled. Book at ${siteUrl}`;
}

function smsRescheduleText(customerName, newDateStr, manageUrl) {
  return `Mona Liza Nails: Appt rescheduled to ${newDateStr}. Manage: ${manageUrl}`;
}

function smsReminderText(customerName, dateStr, manageUrl) {
  const first = customerName ? customerName.split(" ")[0] : "there";
  return `Hi ${first}! Mona Liza Nails\n📅 ${dateStr}\n\nReply YES to confirm.\nManage/Cancel: ${manageUrl}`;
}
