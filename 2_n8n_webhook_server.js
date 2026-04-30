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
 *   GOOGLE_SERVICE_ACCOUNT_CREDENTIALS – GCP service account JSON (stringified)
 *   GOOGLE_CALENDAR_ID                 – the firm's calendar ID (e.g. firm@gmail.com)
 *   GOOGLE_SHEET_ID                    – Google Sheets ID for client records
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER                 – your Twilio phone number
 *   TWILIO_DEFAULT_NOTIFY_NUMBER       – fallback SMS number for notifications
 *   WEBHOOK_SECRET                     – shared secret to validate ElevenLabs requests
 *
 *   EMPLOYEE_DIRECTORY  – JSON string mapping names/roles to phone numbers:
 *     e.g. '{"john smith":"+35799000001","senior partner":"+35799000002","reception":"+35799000003"}'
 *
 * ─── Routes ──────────────────────────────────────────────────────────────────
 *
 *  Athena (Law Firm) Agent — /webhook/athena/*
 *    POST /webhook/athena/check-availability
 *    POST /webhook/athena/book-appointment
 *    POST /webhook/athena/forward-call
 *    POST /webhook/athena/take-message
 *    POST /webhook/athena/lookup-client
 *    POST /webhook/athena/send-confirmation
 *
 *  Customer Support Agent — /webhook/support/*
 *    POST /webhook/support/get-customer-info
 *    POST /webhook/support/get-order-status
 *    POST /webhook/support/create-support-ticket
 *    POST /webhook/support/schedule-followup
 */

require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");
const twilio = require("twilio");

const app = express();
app.use(express.json());

// ─── Auth ────────────────────────────────────────────────────────────────────

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

// ─── Middleware: validate ElevenLabs webhook secret ───────────────────────────
// Applied to ALL /webhook/* routes (both agents share the same secret)

app.use("/webhook", (req, res, next) => {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});


// ══════════════════════════════════════════════════════════════════════════════
// ATHENA AGENT — Law Firm Tools
// ══════════════════════════════════════════════════════════════════════════════

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
        const slotStart = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60000);
        const isBusy = bookedSlots.some((b) => {
          const bs = new Date(b.start);
          const be = new Date(b.end);
          return slotStart < be && slotEnd > bs;
        });
        if (!isBusy) {
          slots.push(`${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
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


// ══════════════════════════════════════════════════════════════════════════════
// CUSTOMER SUPPORT AGENT — General Support Tools
// ══════════════════════════════════════════════════════════════════════════════

// ─── Tool: get_customer_info ─────────────────────────────────────────────────
// Looks up a customer record by email or phone from the "Customers" sheet.
// Expected sheet columns: ID | Name | Email | Phone | Plan | Status

app.post("/webhook/support/get-customer-info", async (req, res) => {
  const { identifier } = req.body;

  if (!identifier) {
    return res.status(400).json({ success: false, error: "identifier is required (email or phone)" });
  }

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Customers!A:F",
    });

    const rows = response.data.values || [];
    const headers = rows[0] || [];
    const records = rows.slice(1);

    const normalised = identifier.toLowerCase().replace(/\s/g, "");

    const match = records.find((row) => {
      const emailMatch = row[2]?.toLowerCase() === normalised;
      const phoneMatch = row[3]?.replace(/\s/g, "") === identifier.replace(/\s/g, "");
      return emailMatch || phoneMatch;
    });

    if (match) {
      const customer = Object.fromEntries(headers.map((h, i) => [h, match[i] || ""]));
      return res.json({
        success: true,
        found: true,
        customer,
        message: `Welcome back, ${customer["Name"] || "valued customer"}! I can see your account is on the ${customer["Plan"] || "standard"} plan with status: ${customer["Status"] || "active"}. How can I help you today?`,
      });
    }

    res.json({
      success: true,
      found: false,
      message: "I couldn't find an account with that email or phone number. Could you double-check the details?",
    });
  } catch (err) {
    console.error("get-customer-info error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tool: get_order_status ──────────────────────────────────────────────────
// Looks up an order by order ID from the "Orders" sheet.
// Expected sheet columns: Order ID | Customer Name | Status | Item | Date | Tracking

app.post("/webhook/support/get-order-status", async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
    return res.status(400).json({ success: false, error: "order_id is required" });
  }

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Orders!A:F",
    });

    const rows = response.data.values || [];
    const headers = rows[0] || [];
    const records = rows.slice(1);

    const match = records.find(
      (row) => row[0]?.toLowerCase() === order_id.toLowerCase().trim()
    );

    if (match) {
      const order = Object.fromEntries(headers.map((h, i) => [h, match[i] || ""]));
      return res.json({
        success: true,
        found: true,
        order,
        message: `Order ${order_id} is currently ${order["Status"] || "being processed"}${order["Tracking"] ? ". Tracking number: " + order["Tracking"] : ""}. Is there anything else I can help you with?`,
      });
    }

    res.json({
      success: true,
      found: false,
      message: `I couldn't find an order with ID ${order_id}. Please double-check the order number — it's usually found in your confirmation email.`,
    });
  } catch (err) {
    console.error("get-order-status error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tool: create_support_ticket ─────────────────────────────────────────────
// Logs a new support ticket to the "SupportTickets" sheet and SMS-notifies the team.
// Expected sheet columns: Timestamp | Name | Email | Issue | Priority | Status

app.post("/webhook/support/create-support-ticket", async (req, res) => {
  const { customer_email, customer_name, issue_summary, priority } = req.body;

  if (!customer_email || !issue_summary) {
    return res.status(400).json({ success: false, error: "customer_email and issue_summary are required" });
  }

  const validPriorities = ["low", "medium", "high"];
  const ticketPriority = validPriorities.includes(priority) ? priority : "medium";

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const ticketId = `TKT-${Date.now()}`;

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "SupportTickets!A:G",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toISOString(),
          ticketId,
          customer_name || "",
          customer_email,
          issue_summary,
          ticketPriority,
          "Open",
        ]],
      },
    });

    // Notify support team via SMS for high-priority tickets
    if (ticketPriority === "high" && process.env.TWILIO_DEFAULT_NOTIFY_NUMBER) {
      await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: process.env.TWILIO_DEFAULT_NOTIFY_NUMBER,
        body: `🚨 High-Priority Support Ticket\nID: ${ticketId}\nFrom: ${customer_name || customer_email}\nIssue: ${issue_summary}`,
      });
    }

    const eta = ticketPriority === "high" ? "2 hours" : ticketPriority === "medium" ? "within 24 hours" : "within 2 business days";

    res.json({
      success: true,
      ticket_id: ticketId,
      priority: ticketPriority,
      message: `I've created a support ticket for you (${ticketId}). Our team will be in touch ${eta}. Is there anything else I can help you with in the meantime?`,
    });
  } catch (err) {
    console.error("create-support-ticket error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tool: schedule_followup ─────────────────────────────────────────────────
// Logs a callback or follow-up email request to the "Followups" sheet
// and sends an SMS confirmation to the customer.
// Expected sheet columns: Timestamp | Name | Email | Phone | Type | Preferred Time | Notes | Status

app.post("/webhook/support/schedule-followup", async (req, res) => {
  const { customer_email, customer_name, customer_phone, followup_type, preferred_time, notes } = req.body;

  if (!customer_email || !followup_type) {
    return res.status(400).json({ success: false, error: "customer_email and followup_type are required" });
  }

  const validTypes = ["email", "callback"];
  const type = validTypes.includes(followup_type) ? followup_type : "email";

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Followups!A:H",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toISOString(),
          customer_name || "",
          customer_email,
          customer_phone || "",
          type,
          preferred_time || "As soon as possible",
          notes || "",
          "Scheduled",
        ]],
      },
    });

    // SMS confirmation to customer
    if (customer_phone) {
      const smsBody = type === "callback"
        ? `📞 Callback Scheduled\nHi ${customer_name || "there"}, we'll call you back${preferred_time ? " around " + preferred_time : " as soon as possible"}. Thank you for your patience!`
        : `📧 Follow-Up Scheduled\nHi ${customer_name || "there"}, we'll send you a follow-up email shortly. Thank you!`;

      await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: customer_phone,
        body: smsBody,
      });
    }

    res.json({
      success: true,
      followup_type: type,
      preferred_time: preferred_time || "as soon as possible",
      message: type === "callback"
        ? `Perfect! I've scheduled a callback for you${preferred_time ? " around " + preferred_time : ""}. You'll receive an SMS confirmation. Is there anything else I can help with?`
        : `Great! I've scheduled a follow-up email for you. You'll hear from us shortly. Anything else I can help with?`,
    });
  } catch (err) {
    console.error("schedule-followup error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// AI ECOSYSTEM — Business Integration Tools
// ══════════════════════════════════════════════════════════════════════════════

// ─── Tool: get_customer (CRM) ────────────────────────────────────────────────

app.post("/webhook/ecosystem/get-customer", async (req, res) => {
  const { email, customer_id } = req.body;

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Customers!A:F",
    });

    const rows = response.data.values || [];
    const headers = rows[0] || [];
    const records = rows.slice(1);

    const match = records.find((row) =>
      (email && row[2]?.toLowerCase() === email.toLowerCase()) ||
      (customer_id && row[0] === customer_id)
    );

    if (match) {
      const customer = Object.fromEntries(headers.map((h, i) => [h, match[i] || ""]));
      return res.json({ success: true, found: true, customer });
    }

    res.json({ success: true, found: false });
  } catch (err) {
    console.error("get-customer error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── Tool: create_customer (CRM) ─────────────────────────────────────────────

app.post("/webhook/ecosystem/create-customer", async (req, res) => {
  const { name, email, phone } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, error: "name and email required" });
  }

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const customerId = `CUST-${Date.now()}`;

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Customers!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          customerId,
          name,
          email,
          phone || "",
          "Standard",
          "Active"
        ]],
      },
    });

    res.json({
      success: true,
      customer_id: customerId,
      message: `Customer ${name} created successfully.`,
    });
  } catch (err) {
    console.error("create-customer error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── Tool: create_invoice (ERP) ──────────────────────────────────────────────

app.post("/webhook/ecosystem/create-invoice", async (req, res) => {
  const { customer_id, amount, description } = req.body;

  if (!customer_id || !amount) {
    return res.status(400).json({ success: false, error: "customer_id and amount required" });
  }

  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const invoiceId = `INV-${Date.now()}`;

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Invoices!A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          invoiceId,
          customer_id,
          amount,
          description || "",
          new Date().toISOString()
        ]],
      },
    });

    res.json({
      success: true,
      invoice_id: invoiceId,
      message: `Invoice ${invoiceId} created successfully.`,
    });
  } catch (err) {
    console.error("create-invoice error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── Tool: send_email (Email) ────────────────────────────────────────────────

app.post("/webhook/ecosystem/send-email", async (req, res) => {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ success: false, error: "to, subject, body required" });
  }

  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to,
      body: `📧 ${subject}\n\n${body}`,
    });

    res.json({ success: true, message: "Email (SMS proxy) sent successfully." });
  } catch (err) {
    console.error("send-email error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── Tool: create_calendar_event (Calendar) ──────────────────────────────────

app.post("/webhook/ecosystem/create-calendar-event", async (req, res) => {
  const { title, start_time, end_time, attendees } = req.body;

  if (!title || !start_time || !end_time) {
    return res.status(400).json({ success: false, error: "title, start_time, end_time required" });
  }

  try {
    const auth = await getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: title,
        start: { dateTime: new Date(start_time).toISOString() },
        end: { dateTime: new Date(end_time).toISOString() },
        attendees: (attendees || []).map(email => ({ email })),
      },
    });

    res.json({
      success: true,
      event_id: event.data.id,
      link: event.data.htmlLink,
    });
  } catch (err) {
    console.error("create-calendar-event error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
  console.log(`  Athena tools:  /webhook/athena/*`);
  console.log(`  Support tools: /webhook/support/*`);
});
