/**
 * Athena — Google Sheets Setup Script
 * ------------------------------------
 * Run this ONCE to create all required tabs and headers in your Google Sheet.
 *
 * Usage:
 *   node 3_sheets_setup.js
 *
 * Prerequisites:
 *   npm install googleapis google-auth-library dotenv
 *   Set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID in your .env
 */

require("dotenv").config();
const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const SHEETS_CONFIG = [
  {
    name: "Clients",
    headers: [
      "Created At",
      "Full Name",
      "Phone",
      "Email",
      "Case Reference",
      "Assigned Lawyer",
      "Matter Type",
      "Status",
      "Notes",
    ],
    color: { red: 0.27, green: 0.51, blue: 0.71 }, // blue header
  },
  {
    name: "Appointments",
    headers: [
      "Created At",
      "Client Name",
      "Phone",
      "Email",
      "Appointment Type",
      "Date",
      "Time",
      "Lawyer",
      "Notes",
      "Calendar Event ID",
    ],
    color: { red: 0.2, green: 0.63, blue: 0.47 }, // green header
  },
  {
    name: "Messages",
    headers: [
      "Received At",
      "Caller Name",
      "Caller Phone",
      "Message For",
      "Message Body",
      "Urgency",
      "Status",
    ],
    color: { red: 0.85, green: 0.53, blue: 0.2 }, // amber header
  },
  {
    name: "Call Log",
    headers: [
      "Timestamp",
      "Caller Name",
      "Caller Phone",
      "Call Type",
      "Duration (sec)",
      "Outcome",
      "Handled By",
      "Notes",
    ],
    color: { red: 0.58, green: 0.29, blue: 0.71 }, // purple header
  },
];

async function setupSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // Get existing sheets
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = meta.data.sheets.map((s) => s.properties.title);

  const requests = [];

  for (const config of SHEETS_CONFIG) {
    if (!existing.includes(config.name)) {
      // Add sheet
      requests.push({
        addSheet: {
          properties: {
            title: config.name,
            gridProperties: { rowCount: 1000, columnCount: config.headers.length },
          },
        },
      });
    }
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });
    console.log(`Created ${requests.length} new sheet(s).`);
  }

  // Re-fetch to get sheet IDs
  const updated = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMap = Object.fromEntries(
    updated.data.sheets.map((s) => [s.properties.title, s.properties.sheetId])
  );

  // Write headers and format each sheet
  for (const config of SHEETS_CONFIG) {
    const sheetId = sheetMap[config.name];

    // Write headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${config.name}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [config.headers] },
    });

    // Format header row
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: config.color,
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: config.headers.length },
            },
          },
        ],
      },
    });

    console.log(`✅ Sheet "${config.name}" configured.`);
  }

  console.log("\n✅ All sheets ready. Your Google Sheet is configured for Athena.");
  console.log(`\nOpen your sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}`);
}

setupSheets().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
