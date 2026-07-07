import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const BASE_ID = "appm1aJQpFMWkNpZp";
const TENANTS_TABLE_ID = "tblGHDOn9oyI75bu0";
const PAYMENTS_TABLE_ID = "tbl17Vw7Cjwcih2oU";
const API_ROOT = `https://api.airtable.com/v0/${BASE_ID}`;

const TENANT_FIELDS = Object.freeze({
  name: "fldWs6XKPqv2fNCW8",
  status: "fldSRjjV7WMnsnwYH",
  ownership: "fldfnqNgyWGDX22qZ",
  monthlyRent: "fldgytfUlcpMMpMxg",
  tenantName: "fld2XyEejgBOyjBsS",
  phone: "fldCLY14XpBga0xPk",
});

const PAYMENT_FIELDS = Object.freeze({
  amount: "fldvoaEA1WNV3sOQP",
  date: "fld0VGwFmp5RKI8aE",
  tenant: "fldRQpETmpUxSOTL9",
  notes: "fldWL20ntawNap52r",
});

const FIELD_NAMES = Object.freeze({
  tenantStatus: "סטטוס לקוח",
  paymentAmount: "סכום",
  paymentDate: "תאריך החשבונית",
});

const ACTIVE_STATUS = "שוכר נכנס";
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const INBOX_DIR = join(DATA_DIR, "inbox");
const STATE_FILE = join(DATA_DIR, "state.json");
const TENANT_CACHE_MS = 5 * 60 * 1000;

let tenantCache = { loadedAt: 0, tenants: [] };

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJsonRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { processed: [], pending: [] };
  }
}

async function writeState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, STATE_FILE);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return `972${digits.slice(1)}`;
  return digits;
}

function escapeFormulaString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function israelDateFromUnix(timestamp) {
  const date = timestamp ? new Date(Number(timestamp) * 1000) : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function airtableRequest(path, params = {}) {
  const url = new URL(`${API_ROOT}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requireEnv("AIRTABLE_TOKEN")}` },
  });
  if (!response.ok) {
    throw new Error(`Airtable read failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function loadActiveTenants() {
  if (Date.now() - tenantCache.loadedAt < TENANT_CACHE_MS) return tenantCache.tenants;

  const formula = `{${FIELD_NAMES.tenantStatus}}='${escapeFormulaString(ACTIVE_STATUS)}'`;
  const data = await airtableRequest(TENANTS_TABLE_ID, {
    filterByFormula: formula,
    maxRecords: 100,
    returnFieldsByFieldId: "true",
  });

  tenantCache = {
    loadedAt: Date.now(),
    tenants: (data.records || []).map((record) => {
      const fields = record.fields || {};
      return {
        id: record.id,
        name: fields[TENANT_FIELDS.name],
        tenantName: fields[TENANT_FIELDS.tenantName],
        phone: fields[TENANT_FIELDS.phone],
        normalizedPhone: normalizePhone(fields[TENANT_FIELDS.phone]),
        ownership: fields[TENANT_FIELDS.ownership],
        monthlyRent: fields[TENANT_FIELDS.monthlyRent],
      };
    }).filter((tenant) => tenant.normalizedPhone),
  };

  return tenantCache.tenants;
}

function getMessageData(payload) {
  const body = payload?.body || payload || {};
  const messageData = body.messageData || {};
  const senderData = body.senderData || {};
  const fileData = messageData.fileMessageData || {};
  const textData = messageData.textMessageData || {};
  const extendedText = messageData.extendedTextMessageData || {};
  const sender = senderData.sender || senderData.chatId || "";

  return {
    webhookType: body.typeWebhook,
    idMessage: body.idMessage || "",
    timestamp: body.timestamp,
    senderPhone: normalizePhone(String(sender).split("@")[0]),
    chatId: sender,
    typeMessage: messageData.typeMessage || "",
    downloadUrl: fileData.downloadUrl || "",
    fileName: fileData.fileName || "",
    mimeType: fileData.mimeType || "",
    caption: fileData.caption || textData.textMessage || extendedText.text || "",
  };
}

function extensionFromMessage(message) {
  const fromName = extname(message.fileName || "").toLowerCase();
  if (fromName) return fromName;
  if (message.mimeType.includes("pdf")) return ".pdf";
  if (message.mimeType.includes("png")) return ".png";
  if (message.mimeType.includes("webp")) return ".webp";
  return ".jpg";
}

function parseAmount(text) {
  const match = String(text || "").match(/(?:₪|ILS)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})(?:\.\d{1,2})?/);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function parseTransferReference(text) {
  const match = String(text || "").match(/(?:אסמכתא|reference|ref)\D*([0-9-]{4,})/i);
  return match ? match[1] : "";
}

async function downloadMedia(message, eventId) {
  await mkdir(INBOX_DIR, { recursive: true });
  const filePath = join(INBOX_DIR, `${eventId}${extensionFromMessage(message)}`);
  const response = await fetch(message.downloadUrl);
  if (!response.ok) throw new Error(`media download failed ${response.status}`);

  await pipeline(response.body, createWriteStream(filePath));
  const bytes = await readFile(filePath);
  const info = await stat(filePath);
  return {
    filePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: info.size,
  };
}

async function findExistingAirtablePayment({ tenantId, amount, date }) {
  if (!tenantId || !amount || !date) return [];

  const formula =
    `AND({${FIELD_NAMES.paymentAmount}}=${Number(amount)},` +
    `DATETIME_FORMAT({${FIELD_NAMES.paymentDate}},'YYYY-MM-DD')='${escapeFormulaString(date)}')`;
  const data = await airtableRequest(PAYMENTS_TABLE_ID, {
    filterByFormula: formula,
    maxRecords: 100,
    returnFieldsByFieldId: "true",
  });

  return (data.records || []).filter((record) =>
    (record.fields?.[PAYMENT_FIELDS.tenant] || []).includes(tenantId),
  );
}

function hasLocalDuplicate(state, item) {
  return [...state.pending, ...state.processed].some((record) =>
    (record.idMessage && record.idMessage === item.idMessage) ||
    (record.tenantId === item.tenantId && record.fileSha256 === item.fileSha256),
  );
}

async function sendGreenMessage(chatId, text) {
  if (!process.env.APPROVAL_CHAT_ID && !chatId) return;
  const targetChatId = process.env.APPROVAL_CHAT_ID || chatId;
  const idInstance = requireEnv("GREEN_API_ID_INSTANCE");
  const token = requireEnv("GREEN_API_TOKEN_INSTANCE");
  const url = `https://api.green-api.com/waInstance${idInstance}/sendMessage/${token}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: targetChatId, message: text }),
  });
}

async function handleGreenApiWebhook(req, res) {
  const body = await readJsonRequest(req);
  const message = getMessageData(body);

  if (message.webhookType !== "incomingMessageReceived") {
    return jsonResponse(res, 200, { ok: true, status: "ignored", reason: "not incoming message" });
  }
  if (!message.senderPhone) {
    return jsonResponse(res, 200, { ok: true, status: "ignored", reason: "no sender" });
  }

  const tenants = await loadActiveTenants();
  const tenant = tenants.find((item) => item.normalizedPhone === message.senderPhone);
  if (!tenant) {
    return jsonResponse(res, 200, { ok: true, status: "ignored", reason: "not active tenant" });
  }
  if (!message.downloadUrl) {
    return jsonResponse(res, 200, { ok: true, status: "ignored", reason: "no attachment", tenant: tenant.tenantName });
  }

  const eventId = randomUUID();
  const media = await downloadMedia(message, eventId);
  const date = israelDateFromUnix(message.timestamp);
  const amount = parseAmount(message.caption);
  const transferReference = parseTransferReference(message.caption);
  const state = await readState();

  const item = {
    id: eventId,
    createdAt: new Date().toISOString(),
    status: "needs_review",
    source: "green-api",
    idMessage: message.idMessage,
    chatId: message.chatId,
    senderPhone: message.senderPhone,
    tenantId: tenant.id,
    tenantName: tenant.tenantName,
    tenantRecordName: tenant.name,
    ownership: tenant.ownership,
    monthlyRent: tenant.monthlyRent,
    amount,
    date,
    transferReference,
    caption: message.caption,
    filePath: media.filePath,
    fileSha256: media.sha256,
    fileSize: media.size,
  };

  const airtableDuplicates = await findExistingAirtablePayment(item);
  if (hasLocalDuplicate(state, item) || airtableDuplicates.length > 0) {
    return jsonResponse(res, 200, { ok: true, status: "duplicate", tenant: tenant.tenantName });
  }

  state.pending.push(item);
  await writeState(state);

  await sendGreenMessage(null, [
    "התקבל אישור תשלום לבדיקה.",
    `שוכר: ${item.tenantName || item.tenantRecordName}`,
    item.amount ? `סכום: ${item.amount}` : "סכום: לא זוהה",
    `תאריך: ${item.date}`,
    `מזהה: ${item.id}`,
  ].join("\n"));

  return jsonResponse(res, 200, {
    ok: true,
    status: "queued",
    pendingId: item.id,
    tenant: item.tenantName,
    amount: item.amount,
  });
}

async function handlePending(req, res) {
  const state = await readState();
  return jsonResponse(res, 200, {
    pending: state.pending.map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      tenantName: item.tenantName,
      amount: item.amount,
      monthlyRent: item.monthlyRent,
      date: item.date,
      transferReference: item.transferReference,
      filePath: item.filePath,
      status: item.status,
    })),
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/health") return jsonResponse(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/pending") return handlePending(req, res);
    if (req.method === "POST" && url.pathname === "/webhooks/green-api") return handleGreenApiWebhook(req, res);
    return jsonResponse(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return jsonResponse(res, 500, { ok: false, error: error.message });
  }
}

createServer(handleRequest).listen(PORT, () => {
  console.log(`Green API rent webhook listening on ${PORT}`);
});
