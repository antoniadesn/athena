# Athena AI Agent — Deployment Guide

## Overview

This package contains everything needed to deploy Athena, your law firm's AI receptionist, using:
- **ElevenLabs** Conversational AI (voice agent)
- **Twilio** (inbound calls + SMS)
- **n8n** (self-hosted middleware, or use the Express webhook server directly)
- **Google Calendar** (appointment booking)
- **Google Sheets** (client records, messages, call log)

---

## Files in this package

| File | Purpose |
|------|---------|
| `1_elevenlabs_tools.json` | Paste into ElevenLabs agent tool definitions |
| `2_n8n_webhook_server.js` | Express server receiving all ElevenLabs tool calls |
| `3_sheets_setup.js` | One-time script to create Google Sheet tabs + headers |
| `4_env_template.env` | Environment variables template |

---

## Step 1 — Google Cloud setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g. "Athena Law Firm")
3. Enable **Google Calendar API** and **Google Sheets API**
4. Create a **Service Account** → download the JSON key → save as `service-account.json`
5. Open your Google Calendar → Settings → Share with the service account email → give **"Make changes to events"** permission
6. Create a new Google Sheet for records → copy the Sheet ID from the URL
7. Share the Google Sheet with the service account email (Editor access)

---

## Step 2 — Set up Google Sheets

```bash
npm install googleapis google-auth-library dotenv
cp 4_env_template.env .env
# Fill in GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID in .env
node 3_sheets_setup.js
```

This creates 4 tabs: **Clients**, **Appointments**, **Messages**, **Call Log** with formatted headers.

---

## Step 3 — Configure Twilio

1. Sign up at [twilio.com](https://twilio.com) and buy a phone number for the firm
2. Note your **Account SID**, **Auth Token**, and **phone number**
3. Add them to your `.env`
4. Under the phone number settings, set the inbound call webhook to your ElevenLabs SIP endpoint (configured in Step 5)

---

## Step 4 — Deploy the webhook server

```bash
npm install express google-auth-library googleapis twilio dotenv
cp 4_env_template.env .env
# Fill in all values
node 2_n8n_webhook_server.js
```

The server runs on port 3000 by default. For production, deploy to a VPS or cloud service (Railway, Render, Fly.io) and ensure it's accessible via HTTPS.

If using **n8n** instead:
- Create one Webhook node per route (`/webhook/athena/book-appointment`, etc.)
- Add a Code node after each webhook and paste the relevant logic from `2_n8n_webhook_server.js`
- Connect to Google Calendar and Sheets nodes as appropriate

---

## Step 5 — Configure ElevenLabs

1. Go to [elevenlabs.io](https://elevenlabs.io) → Conversational AI → Create Agent
2. **System prompt**: Paste your Athena personality prompt
3. **Voice**: Choose a professional female voice (recommended: "Rachel" or "Serena")
4. **Tools**: Open the Tools tab → Add Tool → paste each tool block from `1_elevenlabs_tools.json`
   - Replace `YOUR_N8N_DOMAIN` with your actual server URL in every webhook URL
5. **First message**: `"Thank you for calling [Firm Name]. This is Athena, how may I assist you today?"`
6. **Advanced settings**:
   - Turn-end sensitivity: Medium (legal calls need natural pauses)
   - Interruption sensitivity: Low (clients may pause while thinking)
   - Max call duration: 600 seconds (10 min)
7. **Webhook auth**: Add header `x-webhook-secret: YOUR_SECRET` (must match `.env`)

---

## Step 6 — Connect Twilio to ElevenLabs

In your ElevenLabs agent settings, find the **Phone Numbers** tab and follow the Twilio integration guide. This links your Twilio number directly to the ElevenLabs voice agent so all inbound calls are answered by Athena.

---

## Google Sheets structure

### Clients (A:I)
| Created At | Full Name | Phone | Email | Case Reference | Assigned Lawyer | Matter Type | Status | Notes |

### Appointments (A:J)
| Created At | Client Name | Phone | Email | Appointment Type | Date | Time | Lawyer | Notes | Calendar Event ID |

### Messages (A:G)
| Received At | Caller Name | Caller Phone | Message For | Message Body | Urgency | Status |

### Call Log (A:H)
| Timestamp | Caller Name | Caller Phone | Call Type | Duration (sec) | Outcome | Handled By | Notes |

---

## Employee directory format

In your `.env`, the `EMPLOYEE_DIRECTORY` maps lowercase names/roles to phone numbers:

```json
{
  "john smith": "+35799000001",
  "maria kyriacou": "+35799000002",
  "senior partner": "+35799000002",
  "junior associate": "+35799000003",
  "reception": "+35799000004"
}
```

When a caller says *"Can I speak with Maria?"*, Athena's LLM will call the `forward_call` tool with `target_employee: "maria kyriacou"`, which maps to her number.

---

## Testing checklist

- [ ] `node 3_sheets_setup.js` completes without errors
- [ ] Webhook server starts: `node 2_n8n_webhook_server.js`
- [ ] POST to `/webhook/athena/check-availability` returns available slots
- [ ] POST to `/webhook/athena/book-appointment` creates a calendar event + sheet row
- [ ] POST to `/webhook/athena/take-message` logs to Sheets + sends SMS
- [ ] POST to `/webhook/athena/forward-call` returns the correct employee number
- [ ] ElevenLabs test call books an appointment end-to-end
- [ ] SMS confirmation received after booking

---

## Security notes

- Always use HTTPS for your webhook server in production
- Rotate `WEBHOOK_SECRET` regularly
- The service account JSON key should never be committed to git — add it to `.gitignore`
- Limit the service account's permissions to only Calendar and Sheets APIs
