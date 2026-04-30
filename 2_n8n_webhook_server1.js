/**
 * Athena AI Agent — n8n Webhook Handler
 * --------------------------------------
 * Deploy this as a standalone Express server alongside your n8n instance,
 * OR import each route as an n8n "Webhook" node + "Code" node workflow.
 *
 * Prerequisites:
 *   npm install express google-auth-library googleapis twilio dotenv
 *
 * Environment variables (.env):
 *   GOOGLE_SERVICE_ACCOUNT_JSON   – path to your GCP service account JSON key
 *   GOOGLE_CALENDAR_ID            – the firm's calendar ID (e.g. firm@gmail.com)
 *   GOOGLE_SHEET_ID               – Google Sheets ID for client records
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER            – your Twilio phone number
 *   WEBHOOK_SECRET                – shared secret to validate ElevenLabs requests
 *
 *   EMPLOYEE_DIRECTORY            – JSON string mapping names/roles to phone numbers:
 *     e.g. '{"john smith":"+35799000001","senior partner":"+35799000002","reception":"+35799000003"}'
 */

require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");
const twilio = require("twilio");

const app = express();
app.use(express.json());

// ─── Auth ────────────────────────────────────────────────────────────────────

// function getGoogleAuth() {
//   const auth = new google.auth.GoogleAuth({
//     keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
//     scopes: [
//       "https://www.googleapis.com/auth/calendar",
//       "https://www.googleapis.com/auth/spreadsheets",
//     ],
//   });
//   return auth;
// }

function getGoogleAuth() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS),
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
  return auth;
}

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const employeeDirectory = JSON.parse(process.env.EMPLOYEE_DIRECTORY || "{}");

// ─── Middleware: validate ElevenLabs webhook secret ──────────────────────────

app.use("/webhook/athena", (req, res, next) => {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// app.use("/webhook/athena", (req, res, next) => {
//   console.log("Incoming headers:", req.headers);
//   next();
// });



// ─── Tool: check_availability ────────────────────────────────────────────────

app.post("/webhook/athena/check-availability", async (req, res) => {
  const { date, lawyer_name } = req.body;

  try {
    const auth = await getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const startOfDay = new Date(`${date}T08:00:00`);
    const endOfDay = new Date(`${date}T18:00:00`);

    const eventsRes = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const bookedSlots = (eventsRes.data.items || []).map((e) => ({
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      summary: e.summary,
    }));

    // Generate 30-min slots from 09:00–17:00 and mark free ones
    const slots = [];
    for (let hour = 9; hour < 17; hour++) {
      for (let min = 0; min < 60; min += 30) {
        const slotStart = new Date(`${date}T${String(hour).padStart(2,"0")}:${String(min).padStart(2,"0")}:00`);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60000);
        const isBusy = bookedSlots.some((b) => {
          const bs = new Date(b.start);
          const be = new Date(b.end);
          return slotStart < be && slotEnd > bs;
        });
        if (!isBusy) {
          slots.push(`${String(hour).padStart(2,"0")}:${String(min).padStart(2,"0")}`);
        }
      }
    }

    res.json({
      success: true,
      date,
      available_slots: slots,
      message:
        slots.length > 0
          ? `Available times on ${date}: ${slots.join(", ")}`
          : `No availability on ${date}. Please suggest another date.`,
    });
  } catch (err) {
    console.error("check-availability error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tool: book_appointment ──────────────────────────────────────────────────

app.post("/webhook/athena/book-appointment", async (req, res) => {
  const {
    client_name,
    client_phone,
    client_email,
    appointment_type,
    preferred_date,
    preferred_time,
    lawyer_name,
    notes,
  } = req.body;

  try {
    const auth = await getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });

    const startDateTime = new Date(`${preferred_date}T${preferred_time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + 60 * 60000); // 1hr default

    const typeLabels = {
      initial_consultation: "Initial Consultation",
      follow_up: "Follow-Up Meeting",
      hearing_prep: "Hearing Preparation",
      document_review: "Document Review",
      general_meeting: "General Meeting",
    };

    const eventSummary = `${typeLabels[appointment_type] || appointment_type} — ${client_name}`;

    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: eventSummary,
        description: [
          `Client: ${client_name}`,
          `Phone: ${client_phone}`,
          client_email ? `Email: ${client_email}` : "",
          lawyer_name ? `Lawyer: ${lawyer_name}` : "",
          notes ? `Notes: ${notes}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        start: { dateTime: startDateTime.toISOString(), timeZone: "Asia/Nicosia" },
        end: { dateTime: endDateTime.toISOString(), timeZone: "Asia/Nicosia" },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "email", minutes: 24 * 60 },
            { method: "popup", minutes: 60 },
          ],
        },
      },
    });

    // Log to Google Sheets
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Appointments!A:J",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toISOString(),
          client_name,
          client_phone,
          client_email || "",
          appointment_type,
          preferred_date,
          preferred_time,
          lawyer_name || "TBC",
          notes || "",
          event.data.id,
        ]],
      },
    });

    res.json({
      success: true,
      event_id: event.data.id,
      event_link: event.data.htmlLink,
      message: `Appointment confirmed for ${client_name} on ${preferred_date} at ${preferred_time}${lawyer_name ? " with " + lawyer_name : ""}. A confirmation will be sent shortly.`,
    });
  } catch (err) {
    console.error("book-appointment error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tool: forward_call ──────────────────────────────────────────────────────

app.post("/webhook/athena/forward-call", async (req, res) => {
  const { target_employee, reason, caller_name, call_sid } = req.body;

  try {
    const key = target_employee.toLowerCase().trim();
    const targetNumber = employeeDirectory[key];

    if (!targetNumber) {
      return res.json({
        success: false,
        message: `I'm sorry, I was unable to locate ${target_employee} in the directory. I can take a message and have them call you back.`,
      });
    }

    // ElevenLabs will use this response to trigger a Twilio call transfer.
    // The actual TwiML redirect must happen via your Twilio call flow.
    // Return the target number so ElevenLabs/Twilio can execute the transfer.
    res.json({
      success: true,
      target_number: targetNumber,
      target_name: target_employee,
      message: `Please hold while I transfer you to ${target_employee}. I'll let them know you're calling.`,
      twiml_redirect: `<Response><Say voice="Polly.Joanna">Please hold, transferring your call now.</Say><Dial><Number>${targetNumber}</Number></Dial></Response>`,
    });
  } catch (err) {
    console.error("forward-call error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tool: take_message ──────────────────────────────────────────────────────

app.post("/webhook/athena/take-message", async (req, res) => {
  const { caller_name, caller_phone, message_for, message_body, urgency } = req.body;

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // Log message to Google Sheets
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Messages!A:G",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toISOString(),
          caller_name,
          caller_phone,
          message_for || "General",
          message_body,
          urgency,
          "Unread",
        ]],
      },
    });

    // SMS notification to relevant employee
    const recipientKey = (message_for || "").toLowerCase().trim();
    const recipientNumber = employeeDirectory[recipientKey] || process.env.TWILIO_DEFAULT_NOTIFY_NUMBER;

    if (recipientNumber) {
      const urgencyPrefix = urgency === "emergency" ? "🚨 URGENT" : urgency === "urgent" ? "⚠️ Urgent" : "📋";
      await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: recipientNumber,
        body: `${urgencyPrefix} Message via Athena\nFrom: ${caller_name} (${caller_phone})\n"${message_body}"`,
      });
    }

    res.json({
      success: true,
      message: `Thank you, ${caller_name}. Your message has been recorded and ${message_for || "the relevant team member"} will be notified. You can expect a callback within ${urgency === "emergency" ? "30 minutes" : urgency === "urgent" ? "2 hours" : "one business day"}.`,
    });
  } catch (err) {
    console.error("take-message error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tool: lookup_client ─────────────────────────────────────────────────────

app.post("/webhook/athena/lookup-client", async (req, res) => {
  const { client_name, client_phone } = req.body;

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Clients!A:F",
    });

    const rows = response.data.values || [];
    const headers = rows[0] || [];
    const records = rows.slice(1);

    const match = records.find((row) => {
      const nameMatch = client_name && row[1]?.toLowerCase().includes(client_name.toLowerCase());
      const phoneMatch = client_phone && row[2]?.includes(client_phone.replace(/\s/g, ""));
      return nameMatch || phoneMatch;
    });

    if (match) {
      const record = Object.fromEntries(headers.map((h, i) => [h, match[i] || ""]));
      res.json({
        success: true,
        found: true,
        client: record,
        message: `I have your records on file. Your case reference is ${record["Case Reference"] || "on file"}. How can I assist you today?`,
      });
    } else {
      res.json({
        success: true,
        found: false,
        message: "I don't have existing records for you. I'll create a new record as we proceed.",
      });
    }
  } catch (err) {
    console.error("lookup-client error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tool: send_confirmation ─────────────────────────────────────────────────

app.post("/webhook/athena/send-confirmation", async (req, res) => {
  const { recipient_phone, recipient_email, message_type, appointment_details } = req.body;

  try {
    let smsBody = "";

    if (message_type === "appointment_confirmation" && appointment_details) {
      smsBody = [
        `✅ Appointment Confirmed`,
        `Date: ${appointment_details.date}`,
        `Time: ${appointment_details.time}`,
        appointment_details.lawyer ? `With: ${appointment_details.lawyer}` : "",
        `Type: ${appointment_details.type || "Consultation"}`,
        `\nPlease arrive 10 minutes early. To reschedule, call the firm.`,
      ].filter(Boolean).join("\n");
    } else if (message_type === "appointment_reminder") {
      smsBody = [
        `🔔 Reminder: You have an appointment tomorrow`,
        appointment_details ? `at ${appointment_details.time} with ${appointment_details.lawyer || "the firm"}` : "",
        `Please call to reschedule if needed.`,
      ].filter(Boolean).join("\n");
    } else if (message_type === "message_received") {
      smsBody = `📩 Your message has been received by our office. A team member will be in touch shortly.`;
    }

    if (recipient_phone && smsBody) {
      await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: recipient_phone,
        body: smsBody,
      });
    }

    res.json({
      success: true,
      message: "Confirmation sent successfully.",
    });
  } catch (err) {
    console.error("send-confirmation error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Athena webhook server running on port ${PORT}`);
});
