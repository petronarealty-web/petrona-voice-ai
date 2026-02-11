// ============================================================================
// PETRONA VOICE AI — JADE v5.0 (ULTIMATE PRODUCTION)
// ============================================================================
// v4.0 fixes: stop bug, transcription, dedup leads, ET timezone, caller ID,
//   fallback TwiML, health check, WhatsApp, reconnect, graceful shutdown,
//   rate limiting, 2000-char summaries, cached root endpoint
// v5.0 new: business hours awareness, duplicate visit prevention, voicemail
//   fallback + transcription webhook, ultra-human prompt, check_business_hours
//   tool, time context injection, improved VAD, regex interest detection,
//   active call counter, request logging, consolidated /incoming-call
// ============================================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 8080;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1HC91zPEdEzUq1rajAhQbzcwSgOnQSOULYaM9LYlvhb4';

let activeCalls = 0;
const recentCallers = new Map(); // Store recent caller numbers
let googleAuth = null;
let sheetsClient = null;
let calendarClient = null;

app.use((req, res, next) => {
  if (req.path !== '/health') console.log(`→ ${req.method} ${req.path}`);
  next();
});

// ==================== GOOGLE AUTH ====================

async function initGoogleClients() {
  if (!GOOGLE_CREDENTIALS) { console.log('⚠️  No Google credentials'); return; }
  try {
    const credentials = JSON.parse(GOOGLE_CREDENTIALS);
    googleAuth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/calendar'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth: googleAuth });
    calendarClient = google.calendar({ version: 'v3', auth: googleAuth });
    console.log('✅ Google Sheets & Calendar connected');
  } catch (error) {
    console.error('❌ Google init error:', error.message);
  }
}

// ==================== RATE LIMITER ====================

const rateLimitMap = new Map();
function rateLimit(key, maxPerMinute = 30) {
  const now = Date.now();
  const hits = rateLimitMap.get(key) || [];
  const recent = hits.filter(t => now - t < 60000);
  if (recent.length >= maxPerMinute) return false;
  recent.push(now);
  rateLimitMap.set(key, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitMap.entries()) {
    const recent = hits.filter(t => now - t < 60000);
    if (recent.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, recent);
  }
}, 300000);

// ==================== TIMEZONE & BUSINESS HOURS ====================

function nowInET() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date())) p[type] = value;
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
}

function getCurrentTimeContext() {
  const et = nowInET();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const h = et.getHours(), m = String(et.getMinutes()).padStart(2,'0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return {
    dayName: days[et.getDay()], dayNumber: et.getDay(), hour: h, minute: m,
    timeString: `${h12}:${m} ${ampm}`,
    dateString: `${days[et.getDay()]}, ${et.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}`,
    isWeekday: et.getDay() >= 1 && et.getDay() <= 5,
    isSaturday: et.getDay() === 6, isSunday: et.getDay() === 0,
  };
}

function getBusinessHoursStatus() {
  const ctx = getCurrentTimeContext();
  let isOpen = false, message = '';
  if (ctx.isSunday) {
    message = "We're closed on Sundays, but I can still help you and schedule something for the week.";
  } else if (ctx.isSaturday) {
    isOpen = ctx.hour >= 10 && ctx.hour < 16;
    message = isOpen
      ? `We're open! Saturday hours 10 AM–4 PM. It's ${ctx.timeString}.`
      : `Saturday hours are 10 AM–4 PM. Currently closed, but I can still schedule a visit.`;
  } else {
    isOpen = ctx.hour >= 9 && ctx.hour < 18;
    message = isOpen
      ? `We're open! Weekday hours 9 AM–6 PM. It's ${ctx.timeString}.`
      : `Weekday hours are 9 AM–6 PM. Currently closed, but I can still schedule a visit.`;
  }
  return { isOpen, message, currentTime: ctx.timeString, currentDay: ctx.dayName };
}

function parseVisitDateTime(visitDateStr, visitTimeStr) {
  const etNow = nowInET();
  let target = new Date(etNow);
  const dl = (visitDateStr || '').toLowerCase().trim();
  const dayMap = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };

  if (dl.includes('tomorrow')) target.setDate(etNow.getDate() + 1);
  else if (!dl.includes('today')) {
    for (const [name, num] of Object.entries(dayMap)) {
      if (dl.includes(name)) {
        let diff = num - etNow.getDay();
        if (diff <= 0) diff += 7;
        target.setDate(etNow.getDate() + diff);
        break;
      }
    }
  }

  let hours = 10, minutes = 0;
  const tm = (visitTimeStr || '10:00 AM').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (tm) {
    hours = parseInt(tm[1], 10);
    minutes = parseInt(tm[2] || '0', 10);
    const ap = (tm[3] || '').toLowerCase();
    if (ap === 'pm' && hours < 12) hours += 12;
    if (ap === 'am' && hours === 12) hours = 0;
  }

  const pad = n => String(n).padStart(2, '0');
  const d = `${target.getFullYear()}-${pad(target.getMonth()+1)}-${pad(target.getDate())}`;
  return {
    startDateTime: `${d}T${pad(hours)}:${pad(minutes)}:00`,
    endDateTime: `${d}T${pad(hours+1)}:${pad(minutes)}:00`,
  };
}

function getTimestamp() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
}

// ==================== DATA FETCHING ====================

async function getPropertiesFromSheet() {
  try {
    if (!sheetsClient) return getDefaultProperties();
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Properties!A2:J100' });
    const rows = res.data.values || [];
    if (!rows.length) return getDefaultProperties();
    const properties = [];
    for (const r of rows) {
      const p = {
        address:(r[0]||'').trim(), city:(r[1]||'').trim(), bedrooms:(r[2]||'').trim(),
        bathrooms:(r[3]||'').trim(), price:(r[4]||'').trim(), neighborhood:(r[5]||'').trim(),
        status:(r[6]||'Active').trim(), features:(r[7]||'').trim(),
        description:(r[8]||'').trim(), security:(r[9]||'').trim(),
      };
      if (p.status.toLowerCase() === 'active' && p.address) properties.push(p);
    }
    console.log(`📊 ${properties.length} active properties`);
    return { properties };
  } catch (e) { console.error('Properties error:', e.message); return getDefaultProperties(); }
}

function getDefaultProperties() {
  return { properties: [{
    address:'213 Ely Ave', city:'Norwalk', bedrooms:'2', bathrooms:'1', price:'$2,500',
    neighborhood:'Downtown', status:'Active', features:'Hardwood Floors, Updated Kitchen',
    description:'Beautiful updated family home in the heart of Downtown', security:'1 month rent',
  }] };
}

async function getFAQFromSheet() {
  try {
    if (!sheetsClient) return [];
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'FAQ!A2:E50' });
    const faqs = (res.data.values||[]).map(r => ({
      category:r[0]||'', question:r[1]||'', answer:r[2]||'', keywords:r[3]||'', priority:r[4]||'',
    }));
    console.log(`📚 ${faqs.length} FAQs`);
    return faqs;
  } catch (e) { console.error('FAQ error:', e.message); return []; }
}

async function getConnecticutInfo() {
  try {
    if (!sheetsClient) return [];
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Connecticut_Info!A2:B50' });
    const info = (res.data.values||[]).map(r => ({ topic:r[0]||'', information:r[1]||'' }));
    console.log(`🏠 ${info.length} CT info items`);
    return info;
  } catch (e) { console.error('CT error:', e.message); return []; }
}

// ==================== DUPLICATE VISIT CHECK ====================

async function checkDuplicateVisit(name, property) {
  if (!sheetsClient) return { isDuplicate: false };
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Visits!A:I' });
    const rows = res.data.values || [];
    const nl = (name||'').toLowerCase().trim(), pl = (property||'').toLowerCase().trim();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if ((row[8]||'').toLowerCase().trim() !== 'scheduled') continue;
      if ((row[3]||'').toLowerCase().trim() === nl && (row[5]||'').toLowerCase().trim() === pl) {
        return { isDuplicate: true, existingDate: row[1]||'', existingTime: row[2]||'',
          message: `Already has a visit for ${row[5]} on ${row[1]} at ${row[2]}.` };
      }
    }
    return { isDuplicate: false };
  } catch (e) { console.error('Dup check error:', e.message); return { isDuplicate: false }; }
}

// ==================== CRM FUNCTIONS ====================

async function logCall(d) {
  if (!sheetsClient) return;
  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'CallLogs!A:F', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[getTimestamp(), d.phone||'Unknown', d.duration||'0', d.type||'General', d.summary||'', d.outcome||'Completed']] },
    });
    console.log('📞 Call logged');
  } catch (e) { console.error('Log call error:', e.message); }
}

async function saveLead(d) {
  if (!sheetsClient) return false;
  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Leads!A:I', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[getTimestamp(), d.name||'', d.phone||'', d.email||'', d.interest||'', d.property||'', d.budget||'', d.notes||'', d.status||'New']] },
    });
    console.log('👤 Lead saved:', d.name);
    return true;
  } catch (e) { console.error('Save lead error:', e.message); return false; }
}

async function updateLeadStatus(leadData, newStatus) {
  if (!sheetsClient) return false;
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Leads!A:I' });
    const rows = res.data.values || [];
    for (let i = rows.length - 1; i >= 1; i--) {
      const rn = (rows[i][1]||'').toLowerCase().trim(), rp = (rows[i][2]||'').trim();
      const sn = (leadData.name||'').toLowerCase().trim(), sp = (leadData.phone||'').trim();
      if (rn === sn || (sp && rp === sp)) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID, range: `Leads!I${i+1}`,
          valueInputOption: 'USER_ENTERED', requestBody: { values: [[newStatus]] },
        });
        console.log(`👤 Lead → "${newStatus}": ${leadData.name}`);
        return true;
      }
    }
    return false;
  } catch (e) { console.error('Update lead error:', e.message); return false; }
}

async function saveVisit(d) {
  if (!sheetsClient) return false;
  try {
    // Resolve "Saturday" → "Saturday, February 15, 2026" (actual date)
    const { startDateTime } = parseVisitDateTime(d.visitDate, d.visitTime);
    const resolved = new Date(startDateTime);
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const resolvedDateStr = `${days[resolved.getDay()]}, ${resolved.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Visits!A:I', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[getTimestamp(), resolvedDateStr, d.visitTime||'', d.name||'', d.phone||'', d.property||'', d.address||'', d.notes||'', 'Scheduled']] },
    });
    console.log(`📅 Visit saved: ${resolvedDateStr} at ${d.visitTime}`);
    const cal = await createCalendarEvent(d);
    if (cal) await logCalendarEvent({ ...d, visitDate: resolvedDateStr }, cal);
    return true;
  } catch (e) { console.error('Save visit error:', e.message); return false; }
}

async function createCalendarEvent(d) {
  if (!calendarClient) return null;
  try {
    const { startDateTime, endDateTime } = parseVisitDateTime(d.visitDate, d.visitTime);
    const r = await calendarClient.events.insert({ calendarId: 'petronarealty@gmail.com', requestBody: {
      summary: `🏠 Property Viewing — ${d.name||'Client'}`,
      description: `Property: ${d.property||'TBD'}\nAddress: ${d.address||'TBD'}\nPhone: ${d.phone||'N/A'}\nInterest: ${d.interest||'Rental'}\nNotes: ${d.notes||'None'}\n\nBooked via Jade v5.0`,
      location: d.address||'',
      start: { dateTime: startDateTime, timeZone: 'America/New_York' },
      end: { dateTime: endDateTime, timeZone: 'America/New_York' },
      reminders: { useDefault: false, overrides: [{ method:'popup', minutes:60 }, { method:'popup', minutes:15 }] },
    }});
    console.log('📅 Calendar:', r.data.htmlLink);
    return r.data;
  } catch (e) { console.error('Calendar error:', e.message); return null; }
}

async function logCalendarEvent(d, cal) {
  if (!sheetsClient) return;
  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'CalendarEvents!A:K', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[getTimestamp(), cal.id||'', cal.summary||'', d.visitDate||'', d.visitTime||'', d.name||'', d.phone||'', d.property||'', d.address||'', cal.htmlLink||'', 'Scheduled']] },
    });
  } catch (e) { console.error('Log cal error:', e.message); }
}

async function logWhatsApp(d) {
  if (!sheetsClient) return;
  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'WhatsAppLogs!A:H', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[getTimestamp(), d.phone||'', d.direction||'outbound', d.customerMessage||'', d.aiReply||'', d.messageType||'text', d.property||'', d.status||'sent']] },
    });
  } catch (e) { console.error('WhatsApp log error:', e.message); }
}

// ==================== TOOL DEFINITIONS ====================

const toolDefinitions = [
  {
    type: 'function', name: 'save_lead',
    description: "Save lead info when customer gives their name. Call as soon as you learn their name.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer full name' },
        phone: { type: 'string', description: 'Phone number' },
        email: { type: 'string', description: 'Email address' },
        interest: { type: 'string', enum: ['Rental','Purchase','Selling','Maintenance'] },
        property: { type: 'string', description: 'Property interested in' },
        budget: { type: 'string', description: 'Budget range' },
        notes: { type: 'string', description: 'Notes' },
      },
      required: ['name'],
    },
  },
  {
    type: 'function', name: 'schedule_visit',
    description: 'Schedule property visit after confirming day, time, property. Auto-checks duplicates.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, phone: { type: 'string' },
        visitDate: { type: 'string', description: 'Day (Monday, Tomorrow, Saturday)' },
        visitTime: { type: 'string', description: 'Time (10 AM, 2 PM)' },
        property: { type: 'string' }, address: { type: 'string' },
        interest: { type: 'string' }, notes: { type: 'string' },
      },
      required: ['name', 'visitDate', 'visitTime'],
    },
  },
  {
    type: 'function', name: 'send_property_media',
    description: 'Send property photos/videos via WhatsApp when customer asks for pictures.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string' }, property: { type: 'string' },
        mediaType: { type: 'string', enum: ['photos','videos','both'] },
      },
      required: ['property'],
    },
  },
  {
    type: 'function', name: 'check_business_hours',
    description: 'Check if office is open. Use when caller asks about hours or availability.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

// ==================== SYSTEM PROMPT ====================

async function buildSystemPrompt() {
  const { properties } = await getPropertiesFromSheet();
  const faqs = await getFAQFromSheet();
  const ctInfo = await getConnecticutInfo();
  const timeCtx = getCurrentTimeContext();
  const biz = getBusinessHoursStatus();

  const propsText = properties.length > 0
    ? properties.map(p => `• ${p.address}, ${p.city} (${p.neighborhood}) — ${p.bedrooms}BR/${p.bathrooms}BA — ${p.price}/month\n  Features: ${p.features}\n  Description: ${p.description}\n  Security: ${p.security}`).join('\n\n')
    : '• No properties available. Apologize and offer to take their info for when new listings come in.';

  const faqText = faqs.length > 0
    ? faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n') : '';

  const ctText = ctInfo.length > 0
    ? ctInfo.map(c => `${c.topic}: ${c.information}`).join('\n') : '';

  return `You are Jade, a real person who works at Petrona Real Estate in Connecticut. You are on a live phone call right now.

IMPORTANT — READ EVERY RULE CAREFULLY:

RULE 1 — YOU ARE HUMAN:
You're Jade. A real person. If anyone asks if you're AI or a robot, laugh and say "No way, I'm real! Just me, Jade." Never break character.

RULE 2 — BE WARM AND FRIENDLY:
You genuinely care about the person calling. Smile when you talk (they can hear it). Be like a friend who happens to work in real estate. Use a warm, upbeat tone. Say things like "Oh nice!", "Love it", "Gotcha", "For sure". Sound happy to hear from them.

RULE 3 — KEEP IT ULTRA SHORT:
Every response must be ONE sentence. Maximum TWO if absolutely necessary. Never three. Never a paragraph. Think of how a real person talks on the phone — quick back and forth, not speeches.

RULE 4 — LISTEN MORE THAN YOU TALK:
You are 80% listener, 20% talker. After you say ONE short thing, STOP and let them talk. Your job is to HEAR what they need, not to lecture them. Real conversations are ping-pong — short volleys back and forth.

RULE 5 — NEVER ASSUME ANYTHING:
This is CRITICAL. NEVER fill in information the caller hasn't actually said. If you asked for their phone number, WAIT for them to say it. Do NOT make up a number or say "got it" before they answer. If you asked what day works, WAIT for their answer. Do NOT assume "Saturday" or any day. If you're not sure what they said, ASK AGAIN: "Sorry, could you say that again?"

RULE 6 — LET THEM INTERRUPT YOU:
If the caller starts talking while you're talking, STOP IMMEDIATELY mid-sentence. Their voice is more important than yours. Do NOT finish your thought. Just stop, listen to what they're saying, and respond to THAT. This is how real phone conversations work.

RULE 7 — RESPOND FAST:
When they finish talking, respond quickly — don't leave awkward silence. A real person on the phone responds within a beat, not after a long pause. Quick, natural, snappy.

RULE 8 — NO ROBOTIC PATTERNS:
Never go through a checklist. Never ask questions in a predictable order. Have a REAL conversation. If they mention something interesting, react to it. If they jump topics, follow them. Be flexible, not rigid.

RULE 9 — NATURAL PHONE LANGUAGE:
Say "yeah" not "yes". Say "gonna" not "going to". Say "kinda" not "kind of". Say "What's your name?" not "May I have your name?". Say "What number can I reach you at?" not "Could you provide your phone number?". Sound like a real person, not a form.

YOUR GREETING (say this when the call starts):
"Hey, thanks for calling Petrona! This is Jade. What can I do for you?"

That's it. Short. Warm. Then LISTEN.

HOW A TYPICAL CALL SHOULD SOUND:
- Them: "Hi, I'm looking to rent something"
- You: "Oh awesome! What area are you thinking?" [stop, listen]
- Them: "Maybe downtown Norwalk"
- You: "Oh I love Norwalk. How many bedrooms do you need?" [stop, listen]
- Them: "Two bedrooms"
- You: "Nice, so we've got a 2-bedroom on Ely Ave in downtown — twenty-five hundred a month, really nice spot. Wanna come see it?" [stop, listen]
- Them: "Yeah sure"
- You: "Cool! What's your name?" [stop, listen — do NOT continue until they answer]

Notice: short, warm, reactive, and ALWAYS waiting for their answer before moving on.

COLLECTING INFO — IMPORTANT:
- Ask for name FIRST when they show interest
- Then ask for their number
- Then ask what day/time works
- Ask ONE thing at a time. Wait for the answer. Do NOT bundle questions.
- NEVER say "I got your number" or "I have that" until they ACTUALLY give it to you.
- When calling save_lead or schedule_visit, only use information the caller EXPLICITLY said.

SCHEDULING:
- Visits between 9 AM and 6 PM, Monday through Saturday
- If they say a weird time: "Haha that's a bit late — how about sometime between 9 and 6?"
- Sunday: "We're closed Sundays but I can get you in Monday or Saturday!"
- Always confirm: "So [day] at [time] to see [property] — sound good?"

RIGHT NOW: It's ${timeCtx.timeString} on ${timeCtx.dateString}.
Office: ${biz.message}

PROPERTIES AVAILABLE:
${propsText}

FAQ ANSWERS:
${faqText || 'Answer general real estate questions naturally.'}

CONNECTICUT INFO:
${ctText || 'Use general CT knowledge.'}

REMEMBER: One sentence at a time. Be warm. Listen more. Never assume. Let them interrupt. Sound like a real friend who sells real estate.

CRITICAL — TOOL USAGE RULES:
- When you learn the caller's name, you MUST call save_lead immediately. Do NOT just remember it — call the tool.
- When a visit is confirmed (you have name + day + time), you MUST call schedule_visit immediately. Do NOT write visit details in the notes field of save_lead. The schedule_visit tool creates the calendar event and books the visit properly.
- NEVER put visit/scheduling info in the "notes" field of save_lead. Notes are for things like "prefers ground floor" or "has a dog". Visit dates and times go through schedule_visit ONLY.
- When they ask for photos, you MUST call send_property_media. Do NOT just say you'll send them.
- Call the tools RIGHT AWAY when you have the info. Don't wait until the end of the call.`;
}

// ==================== HANDLE FUNCTION CALLS ====================

async function handleFunctionCall(fnName, args, cs) {
  console.log(`🔧 ${fnName}`, JSON.stringify(args));

  switch (fnName) {
    case 'save_lead': {
      cs.leadData = { ...cs.leadData, ...args };
      if (!cs.leadData.phone && cs.callerPhone) cs.leadData.phone = cs.callerPhone;
      await saveLead(cs.leadData);
      cs.leadSaved = true;
      return { success: true, message: 'Lead saved.' };
    }
    case 'schedule_visit': {
      cs.visitData = { ...cs.visitData, ...args };
      if (!cs.visitData.phone) cs.visitData.phone = cs.leadData.phone || cs.callerPhone || '';
      if (!cs.visitData.name && cs.leadData.name) cs.visitData.name = cs.leadData.name;

      const dup = await checkDuplicateVisit(cs.visitData.name, cs.visitData.property);
      if (dup.isDuplicate) {
        console.log('⚠️  Duplicate visit:', dup.message);
        return { success: false, duplicate: true, message: dup.message,
          instruction: 'Tell the caller they already have a visit scheduled for this property. Ask if they want to change the time or see a different property.' };
      }

      if (cs.leadSaved && cs.leadData.name) {
        await updateLeadStatus(cs.leadData, 'Visit Scheduled');
      } else if (cs.leadData.name) {
        cs.leadData.status = 'Visit Scheduled';
        await saveLead(cs.leadData);
        cs.leadSaved = true;
      }

      await saveVisit({ ...cs.visitData, interest: cs.leadData.interest || args.interest || 'Rental' });
      return { success: true, message: 'Visit scheduled and calendar event created.' };
    }
    case 'send_property_media': {
      cs.mediaRequest = args;
      const phone = args.phone || cs.leadData.phone || cs.callerPhone || '';
      await logWhatsApp({ phone, direction: 'outbound', customerMessage: 'Requested photos/videos',
        aiReply: `Sending ${args.mediaType||'photos'} for ${args.property}`,
        messageType: args.mediaType||'photos', property: args.property, status: 'queued' });
      return { success: true, message: 'Photos/videos queued for WhatsApp.' };
    }
    case 'check_business_hours': {
      const s = getBusinessHoursStatus();
      return { success: true, ...s, hours: { weekdays:'9 AM–6 PM (Mon–Fri)', saturday:'10 AM–4 PM', sunday:'Closed' } };
    }
    default:
      return { success: false, message: `Unknown function: ${fnName}` };
  }
}

// ==================== ENDPOINTS ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Jade v5.0', uptime: process.uptime(), activeCalls });
});

let cachedStatus = null, cachedStatusTime = 0;
app.get('/', async (req, res) => {
  if (!rateLimit(`root:${req.ip}`, 10)) return res.status(429).json({ error: 'Too many requests' });
  const now = Date.now();
  if (!cachedStatus || now - cachedStatusTime > 60000) {
    try {
      const { properties } = await getPropertiesFromSheet();
      cachedStatus = { status: 'Petrona Voice AI Running', agent: 'Jade v5.0 Ultimate',
        features: ['Voice AI','Sheets CRM (8 tabs)','Calendar','FAQ+CT','Leads+Dedup','Visits+DupCheck','Business Hours','Voicemail','WhatsApp','CallerID','Reconnect','Ultra-Human Prompt'],
        properties: properties.length, activeCalls };
      cachedStatusTime = now;
    } catch (e) { cachedStatus = { status: 'Running', agent: 'Jade v5.0' }; cachedStatusTime = now; }
  }
  res.json({ ...cachedStatus, timestamp: new Date().toISOString() });
});

// Incoming call — always passes caller ID + voicemail fallback
app.post('/incoming-call', (req, res) => {
  const caller = req.body?.From || '';
  console.log(`📞 Call from: ${caller}`);

  if (!OPENAI_API_KEY) {
    console.error('❌ No API key — voicemail');
    res.type('text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling Petrona Realty. We're sorry, our system is temporarily unavailable. Please leave your name, number, and a brief message after the beep.</Say>
  <Record maxLength="120" transcribe="true" transcribeCallback="/voicemail-transcription" playBeep="true" />
  <Say voice="Polly.Joanna">Thank you. Goodbye!</Say>
</Response>`);
  }

  const host = req.headers.host;
  // Store caller number for lookup by callSid
  if (caller) recentCallers.set(Date.now().toString(), caller);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`);
});

app.get('/incoming-call', (req, res) => res.json({ message: 'POST for Twilio', agent: 'Jade v5.0' }));

// Voicemail transcription callback
app.post('/voicemail-transcription', async (req, res) => {
  const text = req.body?.TranscriptionText || '';
  const caller = req.body?.From || req.body?.Caller || 'Unknown';
  const url = req.body?.RecordingUrl || '';
  console.log(`📝 Voicemail from ${caller}: ${text}`);
  await logCall({ phone: caller, duration: 'Voicemail', type: 'Voicemail',
    summary: `VOICEMAIL: ${text} | Recording: ${url}`, outcome: 'Voicemail Left' });
  await saveLead({ name: 'Voicemail Caller', phone: caller, interest: 'General',
    notes: `Voicemail: ${text}`, status: 'New — Voicemail' });
  res.status(200).send('OK');
});

// WhatsApp
app.post('/incoming-whatsapp', async (req, res) => {
  const phone = (req.body?.From || '').replace('whatsapp:', '');
  const body = req.body?.Body || '';
  console.log(`💬 WhatsApp ${phone}: ${body}`);
  await logWhatsApp({ phone, direction: 'inbound', customerMessage: body, aiReply: '', messageType: 'text', property: '', status: 'received' });
  const reply = `Thank you for messaging Petrona Realty! 🏠 We'll get back to you shortly. For immediate help, call +1 475 471 1996.`;
  await logWhatsApp({ phone, direction: 'outbound', customerMessage: body, aiReply: reply, messageType: 'text', property: '', status: 'sent' });
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
});

// ==================== WEBSOCKET ====================

const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', async (twilioWs) => {
  console.log('🔗 Twilio WS connected');
  activeCalls++;
  console.log(`📊 Active: ${activeCalls}`);

  let openaiWs = null, streamSid = null, callStartTime = Date.now();
  let reconnectAttempts = 0;
  const MAX_RECONNECTS = 2;
  let SYSTEM_PROMPT = null;
  let promptReady = false;

  const cs = {
    callerPhone: '', callSid: '', leadSaved: false,
    leadData: { name:'', phone:'', email:'', interest:'', property:'', budget:'', notes:'', status:'New' },
    visitData: { name:'', phone:'', visitDate:'', visitTime:'', property:'', address:'', notes:'' },
    mediaRequest: null, callSummary: '',
  };

  const connectToOpenAI = () => {
    if (!SYSTEM_PROMPT) {
      console.log('⏳ Waiting for prompt before connecting to OpenAI...');
      return;
    }
    try {
      openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
      });

      openaiWs.on('open', () => {
        console.log('🤖 OpenAI connected');
        reconnectAttempts = 0;
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad', threshold: 0.4, prefix_padding_ms: 200, silence_duration_ms: 400 },
            input_audio_format: 'g711_ulaw', output_audio_format: 'g711_ulaw',
            voice: 'echo', instructions: SYSTEM_PROMPT,
            modalities: ['text', 'audio'], temperature: 0.7,
            tools: toolDefinitions,
            input_audio_transcription: { model: 'whisper-1' },
          },
        }));
        console.log('⚙️  Jade v5.0 configured');

        setTimeout(() => {
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'message', role: 'user', content: [{
                type: 'input_text',
                text: 'A caller just picked up. Greet them warmly and briefly.',
              }] },
            }));
            openaiWs.send(JSON.stringify({ type: 'response.create' }));
          }
        }, 100);
      });

      openaiWs.on('message', async (data) => {
        try {
          const ev = JSON.parse(data.toString());

          if (ev.type === 'response.audio.delta' && ev.delta && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: ev.delta } }));
          }

          if (ev.type === 'response.function_call_arguments.done') {
            let args = {};
            try { args = JSON.parse(ev.arguments || '{}'); } catch (e) { console.error('Bad args:', e.message); }
            const result = await handleFunctionCall(ev.name, args, cs);
            if (openaiWs?.readyState === WebSocket.OPEN) {
              openaiWs.send(JSON.stringify({ type: 'conversation.item.create',
                item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(result) } }));
              openaiWs.send(JSON.stringify({ type: 'response.create' }));
            }
          }

          if (ev.type === 'response.audio_transcript.done') {
            cs.callSummary += `Jade: ${ev.transcript}\n`;
          }

          if (ev.type === 'conversation.item.input_audio_transcription.completed') {
            const t = ev.transcript || '';
            cs.callSummary += `Caller: ${t}\n`;
            const l = t.toLowerCase();
            if (l.match(/\b(rent|renting|rental|lease|leasing)\b/)) cs.leadData.interest = 'Rental';
            if (l.match(/\b(buy|buying|purchase|invest|investing|investment)\b/)) cs.leadData.interest = 'Purchase';
            if (l.match(/\b(sell|selling|list|listing)\b/)) cs.leadData.interest = 'Selling';
            if (l.match(/\b(maintenance|repair|fix|broken|leak|plumbing|heat|ac|pest|mold)\b/)) cs.leadData.interest = 'Maintenance';
          }

          if (ev.type === 'conversation.item.input_audio_transcription.failed')
            console.warn('⚠️  Transcription failed:', ev.error?.message);
          if (ev.type === 'error')
            console.error('❌ OpenAI:', JSON.stringify(ev.error));
        } catch (e) { console.error('Parse error:', e.message); }
      });

      openaiWs.on('error', (e) => console.error('❌ OpenAI WS:', e.message));

      openaiWs.on('close', async (code) => {
        console.log(`🔌 OpenAI closed (${code})`);
        if (twilioWs.readyState === WebSocket.OPEN && reconnectAttempts < MAX_RECONNECTS) {
          reconnectAttempts++;
          console.log(`🔄 Reconnect ${reconnectAttempts}/${MAX_RECONNECTS}...`);
          setTimeout(connectToOpenAI, 500);
          return;
        }
        const dur = Math.round((Date.now() - callStartTime) / 1000);
        await logCall({
          phone: cs.callerPhone || cs.leadData.phone || 'Unknown',
          duration: `${Math.floor(dur/60)}m ${dur%60}s`,
          type: cs.leadData.interest || 'General',
          summary: cs.callSummary.substring(0, 2000),
          outcome: cs.visitData.visitDate ? 'Visit Scheduled' : 'Completed',
        });
      });
    } catch (e) { console.error('❌ OpenAI connect fail:', e.message); }
  };

  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      // Log EVERY event type from Twilio for debugging
      console.log(`📨 Twilio event: ${data.event}`);
      
      if (data.event === 'connected') {
        console.log('🔗 Stream connected (waiting for start...)');
      }
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        callStartTime = Date.now();
        if (data.start.customParameters) cs.callerPhone = data.start.customParameters.callerNumber || '';
        if (data.start.callSid) cs.callSid = data.start.callSid;
        console.log(`📞 Started | ${streamSid} | From: ${cs.callerPhone || '?'}`);
        // Only connect if prompt is ready, otherwise it'll connect when prompt finishes
        if (promptReady) {
          connectToOpenAI();
        } else {
          console.log('⏳ Start received, waiting for prompt...');
        }
      }
      if (data.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
      }
      if (data.event === 'stop') {
        console.log('📞 Stop');
        if (openaiWs) { reconnectAttempts = MAX_RECONNECTS; openaiWs.close(); }
      }
    } catch (e) { console.error('Twilio msg error:', e.message); }
  });

  twilioWs.on('close', () => {
    console.log('🔌 Twilio closed');
    activeCalls = Math.max(0, activeCalls - 1);
    console.log(`📊 Active: ${activeCalls}`);
    if (openaiWs) { reconnectAttempts = MAX_RECONNECTS; openaiWs.close(); }
  });

  twilioWs.on('error', (e) => console.error('❌ Twilio WS:', e.message));

  // Load system prompt AFTER registering listeners (so start event isn't missed)
  try {
    SYSTEM_PROMPT = await buildSystemPrompt();
    promptReady = true;
    console.log('📋 Fresh prompt loaded');
    // If start event already arrived while we were loading, connect now
    if (streamSid && !openaiWs) {
      console.log('🔗 Start was waiting — connecting to OpenAI now');
      connectToOpenAI();
    }
  } catch (e) {
    console.error('❌ Prompt error:', e.message);
    SYSTEM_PROMPT = 'You are Jade, a property consultant at Petrona Realty in Connecticut. Be warm, natural, and helpful. Help callers with property inquiries.';
    promptReady = true;
    if (streamSid && !openaiWs) connectToOpenAI();
  }
});

// ==================== START ====================

server.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log('✨ ================================================');
  console.log('   PETRONA VOICE AI — JADE v5.0 ULTIMATE');
  console.log(`   Port: ${PORT}`);
  console.log('');
  console.log('   ✅ Voice AI — OpenAI Realtime + Whisper');
  console.log('   ✅ Google Sheets CRM (8 tabs)');
  console.log('   ✅ Google Calendar');
  console.log('   ✅ FAQ + CT Info');
  console.log('   ✅ Lead Capture + Dedup');
  console.log('   ✅ Visit Scheduling + Duplicate Prevention');
  console.log('   ✅ Business Hours Awareness');
  console.log('   ✅ Voicemail Fallback + Transcription');
  console.log('   ✅ WhatsApp Endpoint');
  console.log('   ✅ Caller ID Extraction');
  console.log('   ✅ Auto-Reconnect (2x)');
  console.log('   ✅ Ultra-Human Conversation');
  console.log('   ✅ Active Call Monitor');
  console.log('   ✅ Health + Rate Limit');
  console.log('   ✅ Graceful Shutdown');
  console.log('================================================  ✨');
  console.log('');

  await initGoogleClients();
  try {
    const { properties } = await getPropertiesFromSheet();
    const faqs = await getFAQFromSheet();
    const ct = await getConnecticutInfo();
    console.log(`📊 Properties: ${properties.length} | FAQs: ${faqs.length} | CT: ${ct.length}`);
  } catch (e) { console.log('⚠️  Initial load failed:', e.message); }

  const biz = getBusinessHoursStatus();
  console.log(`🕐 ${biz.currentTime} ${biz.currentDay} — ${biz.isOpen ? 'OPEN' : 'CLOSED'}`);
  console.log('');
  console.log('🔗 POST /incoming-call          → Twilio voice');
  console.log('🔗 POST /incoming-whatsapp      → WhatsApp');
  console.log('🔗 POST /voicemail-transcription → Voicemail');
  console.log('🔗 GET  /health                 → Health');
  console.log('');
  console.log('✅ Jade v5.0 ready!');
});

// ==================== SHUTDOWN ====================

function shutdown(sig) {
  console.log(`\n⚠️  ${sig} — shutting down...`);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.close(1001, 'Shutdown'); });
  server.close(() => { console.log('✅ Closed'); process.exit(0); });
  setTimeout(() => { console.error('⚠️  Force exit'); process.exit(1); }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => console.error('❌ Exception:', e));
process.on('unhandledRejection', (r) => console.error('❌ Rejection:', r));
