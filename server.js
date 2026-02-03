const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
app.use(express.json());

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 8080;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const SPREADSHEET_ID = '1HC91zPEdEzUq1rajAhQbzcwSgOnQSOULYaM9LYlvhb4';

// Google Auth
let googleAuth = null;
let sheetsClient = null;
let calendarClient = null;

async function initGoogleClients() {
  if (!GOOGLE_CREDENTIALS) {
    console.log('⚠️ No Google credentials');
    return;
  }
  
  try {
    const credentials = JSON.parse(GOOGLE_CREDENTIALS);
    googleAuth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar'
      ],
    });
    
    sheetsClient = google.sheets({ version: 'v4', auth: googleAuth });
    calendarClient = google.calendar({ version: 'v3', auth: googleAuth });
    
    console.log('✅ Google Sheets & Calendar connected');
  } catch (error) {
    console.error('❌ Google init error:', error.message);
  }
}

// ==================== LOGGING FUNCTIONS ====================

// Log a call to Google Sheets
async function logCall(callData) {
  if (!sheetsClient) return;
  
  try {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const values = [[
      timestamp,
      callData.phone || 'Unknown',
      callData.duration || '0',
      callData.type || 'General',
      callData.summary || '',
      callData.outcome || 'Completed'
    ]];
    
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'CallLogs!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    
    console.log('📞 Call logged');
  } catch (error) {
    console.error('Log call error:', error.message);
  }
}

// Save a lead to Google Sheets
async function saveLead(leadData) {
  if (!sheetsClient) return;
  
  try {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const values = [[
      timestamp,
      leadData.name || '',
      leadData.phone || '',
      leadData.email || '',
      leadData.interest || '',
      leadData.property || '',
      leadData.budget || '',
      leadData.notes || '',
      leadData.status || 'New Lead'
    ]];
    
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Leads!A:I',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    
    console.log('👤 Lead saved:', leadData.name);
  } catch (error) {
    console.error('Save lead error:', error.message);
  }
}

// Save scheduled visit to Google Sheets
async function saveVisit(visitData) {
  if (!sheetsClient) return;
  
  try {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const values = [[
      timestamp,
      visitData.visitDate || '',
      visitData.visitTime || '',
      visitData.name || '',
      visitData.phone || '',
      visitData.property || '',
      visitData.propertyAddress || '',
      visitData.notes || '',
      'Scheduled'
    ]];
    
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Visits!A:I',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    
    console.log('📅 Visit saved:', visitData.visitDate, visitData.visitTime);
  } catch (error) {
    console.error('Save visit error:', error.message);
  }
}

// Create Google Calendar Event
async function createCalendarEvent(visitData) {
  if (!calendarClient) return;
  
  try {
    // Parse date and time
    const dateStr = visitData.visitDate || '';
    const timeStr = visitData.visitTime || '10:00 AM';
    
    // Create event datetime (simplified - assumes current/next week)
    const now = new Date();
    let eventDate = new Date();
    
    // Try to parse the day
    const dayMap = {
      'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4,
      'friday': 5, 'saturday': 6, 'sunday': 0
    };
    
    const dayLower = dateStr.toLowerCase();
    for (const [day, num] of Object.entries(dayMap)) {
      if (dayLower.includes(day)) {
        const currentDay = now.getDay();
        let daysUntil = num - currentDay;
        if (daysUntil <= 0) daysUntil += 7;
        eventDate.setDate(now.getDate() + daysUntil);
        break;
      }
    }
    
    // Parse time
    let hours = 10;
    let minutes = 0;
    const timeMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
      hours = parseInt(timeMatch[1]);
      minutes = parseInt(timeMatch[2] || '0');
      if (timeMatch[3] && timeMatch[3].toLowerCase() === 'pm' && hours < 12) {
        hours += 12;
      }
      if (timeMatch[3] && timeMatch[3].toLowerCase() === 'am' && hours === 12) {
        hours = 0;
      }
    }
    
    eventDate.setHours(hours, minutes, 0, 0);
    const endDate = new Date(eventDate.getTime() + 60 * 60 * 1000); // 1 hour duration
    
    const event = {
      summary: `🏠 Property Viewing - ${visitData.name || 'Client'}`,
      description: `Property: ${visitData.property || 'TBD'}
Phone: ${visitData.phone || 'N/A'}
Notes: ${visitData.notes || 'None'}

Booked via Petrona Voice AI`,
      location: visitData.propertyAddress || '',
      start: {
        dateTime: eventDate.toISOString(),
        timeZone: 'America/New_York',
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'America/New_York',
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 15 },
        ],
      },
    };
    
    const response = await calendarClient.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });
    
    console.log('📅 Calendar event created:', response.data.htmlLink);
    return response.data;
  } catch (error) {
    console.error('Calendar error:', error.message);
  }
}

// ==================== PROPERTIES ====================

let cachedProperties = null;
let lastFetch = 0;
const CACHE_DURATION = 60000;

async function getPropertiesFromSheet() {
  const now = Date.now();
  
  if (cachedProperties && (now - lastFetch) < CACHE_DURATION) {
    return cachedProperties;
  }

  try {
    if (!sheetsClient) {
      return getDefaultProperties();
    }
    
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Properties!A2:H100',
    });

    const rows = response.data.values || [];
    
    if (rows.length === 0) {
      return getDefaultProperties();
    }

    const rentals = [];
    const forSale = [];

    rows.forEach(row => {
      const property = {
        type: row[0] || '',
        address: row[1] || '',
        city: row[2] || '',
        beds: row[3] || '',
        baths: row[4] || '',
        price: row[5] || '',
        features: row[6] || '',
        status: row[7] || 'Available'
      };

      if (property.status.toLowerCase() === 'available') {
        const listing = `${property.city} - ${property.beds}BR/${property.baths}BA - ${property.price} - ${property.features}`;
        
        if (property.type.toLowerCase() === 'rent') {
          rentals.push(listing);
        } else if (property.type.toLowerCase() === 'buy' || property.type.toLowerCase() === 'sale') {
          forSale.push(listing);
        }
      }
    });

    cachedProperties = { rentals, forSale };
    lastFetch = now;
    
    console.log(`📊 Loaded ${rentals.length} rentals, ${forSale.length} for sale`);
    return cachedProperties;

  } catch (error) {
    console.error('Properties error:', error.message);
    return getDefaultProperties();
  }
}

function getDefaultProperties() {
  return {
    rentals: [
      'Stamford - 3BR/2BA - $2,800/month - Modern apartment, pool, gym',
      'Greenwich - 4BR/3BA - $4,200/month - Luxury home, waterfront views',
      'Westport - 2BR/2BA - $2,200/month - Cozy place, near beach',
      'Norwalk - 2BR/1BA - $1,800/month - Great starter, affordable',
      'Fairfield - 3BR/2BA - $2,500/month - Family friendly area',
      'Darien - 3BR/2.5BA - $3,200/month - Near train, easy NYC commute'
    ],
    forSale: [
      'Stamford - 3BR/2BA - $750,000 - Fully renovated downtown',
      'Greenwich - 4BR/3.5BA - $1,250,000 - Waterfront estate',
      'Westport - 5BR/4BA - $1,850,000 - Beach access, pool',
      'Norwalk - 2BR/2BA - $550,000 - Perfect starter home',
      'Fairfield - 3BR/2.5BA - $875,000 - Beach rights included'
    ]
  };
}

// ==================== SYSTEM PROMPT ====================

// Pre-cached system prompt
let cachedSystemPrompt = null;

async function buildSystemPrompt() {
  // Return cached if available
  if (cachedSystemPrompt) {
    return cachedSystemPrompt;
  }
  
  const properties = await getPropertiesFromSheet();
  
  const rentalsText = properties.rentals.map(p => `- ${p}`).join('\n');
  const forSaleText = properties.forSale.map(p => `- ${p}`).join('\n');

  return `You are JADE - a real human property consultant at Petrona Real Estate. You are NOT an AI.

## YOUR IDENTITY - CRITICAL:
- Your name is JADE
- You are a REAL HUMAN - never admit to being AI or a bot
- If asked "Are you AI/robot?": "Haha no, I'm Jade! Very much human, just here to help you."

## YOUR PERSONALITY:
- Warm, friendly, genuinely caring
- Confident and knowledgeable
- Patient - listen more than talk
- Trustworthy - people feel safe with you
- Professional yet personable

## HOW YOU SPEAK - ULTRA NATURAL:
Use natural sounds:
- Thinking: "Hmm...", "Let me see...", "Umm...", "So..."
- Agreement: "Mmhmm", "Aha", "Right, right", "Gotcha"
- Reactions: "Oh!", "Ahh", "Ooh", "Oh nice!"
- Casual: "You know what", "Here's the thing"

Always use contractions: "I'm", "you're", "that's", "we've", "don't", "won't"

## CRITICAL LISTENING RULES:
- When caller speaks, STOP TALKING IMMEDIATELY
- Never talk over them
- Listen fully before responding
- SHORT responses - 1-2 sentences max
- ONE question at a time

## YOUR GREETING:
"Thank you for calling Petrona! This is Jade. How can I help you today? Are you calling about renting a property, a maintenance issue, selling a property, or buying and investing?"

## CONVERSATION FLOWS:

### RENTING:
"Oh wonderful! What area are you looking in?"
[Listen]
"Nice! How many bedrooms do you need?"
[Listen]
"Gotcha. I have a lovely [property]. Want to come see it?"
[Listen - if yes]
"Great! What day works? I have slots this week."
[Listen]
"Perfect! And what's your name?"
[Listen]
"Got it. And best phone number to reach you?"
[Listen]
"Wonderful! I've got you down for [day] at [time]. I'll text you the address. Looking forward to meeting you!"

### MAINTENANCE:
"Oh no, what's the issue?"
[Listen]
"I see. Let me get your details. What's your name?"
[Listen]
"And your property address?"
[Listen]
"Phone number?"
[Listen]
"Got it! Someone will contact you soon."

### SELLING:
"Thinking of selling! Where's your property?"
[Listen]
"Lovely! We can do a free valuation. What day works?"
[Listen]
"And your name?"
[Listen]
"Phone number?"
[Listen]
"Perfect! See you [day]!"

### BUYING:
"Great time to buy! What area interests you?"
[Listen]
"Nice. Budget range?"
[Listen]
"I have a beautiful [property]. Want to schedule a viewing?"
[Listen - if yes, collect name, phone, schedule day/time]

## SCHEDULING RULES:
- ONLY 9 AM to 6 PM
- Weird times (midnight, 3 AM): "Haha that's late! How about between 9 and 6?"
- Suggest specific: "How about Saturday at 11 AM?"
- Always confirm: "Got you down for [day] at [time]!"

## COLLECTING INFO - IMPORTANT:
When booking, ALWAYS get:
1. Name: "What's your name?"
2. Phone: "Best number to reach you?"
3. Day/Time: "What day and time works?"
Then confirm all details back.

## STAYING ON TOPIC:
- Off-topic: "Haha! But let me help with property first - what are you looking for?"
- Rude/inappropriate: "I can't help with that, but happy to help with property!"
- GOAL: Schedule visits or solve maintenance

## AVAILABLE PROPERTIES:

### FOR RENT:
${rentalsText}

### FOR PURCHASE:
${forSaleText}

## EMOTIONAL EXPRESSIONS:
- Happy: "Oh wonderful!", "How exciting!"
- Understanding: "I totally get that", "Mmhmm, makes sense"
- Helpful: "Let me help", "I've got you"
- Warm closing: "Looking forward to meeting you!", "Take care!"

## DATA TO EXTRACT:
During each call, identify and remember:
- Caller type: rent/buy/sell/maintenance
- Name (when given)
- Phone (when given)
- Interest: area, bedrooms, budget
- Scheduled visit: day and time
- Property discussed`;
}

// ==================== API ENDPOINTS ====================

// Health check
app.get('/', async (req, res) => {
  const properties = await getPropertiesFromSheet();
  res.json({ 
    status: 'Petrona Voice AI Running',
    agent: 'Jade',
    features: ['Call Logs', 'Leads', 'Visits', 'Calendar'],
    properties: {
      rentals: properties.rentals.length,
      forSale: properties.forSale.length
    },
    timestamp: new Date().toISOString()
  });
});

// Keep server warm - prevents cold start issues
setInterval(async () => {
  try {
    await getPropertiesFromSheet();
    console.log('🔥 Keep-alive ping');
  } catch (e) {}
}, 60000); // Every 60 seconds

// Manual endpoints for testing
app.post('/api/log-call', async (req, res) => {
  await logCall(req.body);
  res.json({ success: true });
});

app.post('/api/save-lead', async (req, res) => {
  await saveLead(req.body);
  res.json({ success: true });
});

app.post('/api/book-visit', async (req, res) => {
  await saveVisit(req.body);
  await createCalendarEvent(req.body);
  res.json({ success: true });
});

// Twilio webhook
app.post('/incoming-call', (req, res) => {
  console.log('📞 Incoming call');
  
  // Respond IMMEDIATELY to Twilio
  const host = req.headers.host;
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twimlResponse);
});

app.get('/incoming-call', (req, res) => {
  res.json({ message: 'POST endpoint for Twilio' });
});

// ==================== WEBSOCKET ====================

const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', async (twilioWs) => {
  console.log('🔗 Twilio connected');
  
  const SYSTEM_PROMPT = await buildSystemPrompt();
  
  let openaiWs = null;
  let streamSid = null;
  let callStartTime = Date.now();
  let callerPhone = 'Unknown';
  let conversationData = {
    type: 'General',
    name: '',
    phone: '',
    interest: '',
    property: '',
    visitDate: '',
    visitTime: '',
    notes: ''
  };

  const connectToOpenAI = () => {
    try {
      openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      openaiWs.on('open', () => {
        console.log('🤖 OpenAI connected');
        
        const sessionConfig = {
          type: 'session.update',
          session: {
            turn_detection: { 
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600
            },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: 'echo',
            instructions: SYSTEM_PROMPT,
            modalities: ['text', 'audio'],
            temperature: 0.8
          }
        };
        
        openaiWs.send(JSON.stringify(sessionConfig));

        setTimeout(() => {
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{
                type: 'input_text',
                text: 'Caller connected. Give greeting: "Thank you for calling Petrona! This is Jade. How can I help you today? Are you calling about renting a property, a maintenance issue, selling a property, or buying and investing?"'
              }]
            }
          }));
          openaiWs.send(JSON.stringify({ type: 'response.create' }));
        }, 300);
      });

      openaiWs.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          // Send audio to Twilio
          if (event.type === 'response.audio.delta' && event.delta) {
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: event.delta }
              }));
            }
          }
          
          // Capture transcript for logging
          if (event.type === 'response.audio_transcript.done') {
            const transcript = event.transcript || '';
            console.log('🎙️ Jade:', transcript.substring(0, 100));
            
            // Extract data from conversation
            if (transcript.toLowerCase().includes('got you down for') || 
                transcript.toLowerCase().includes("i've got you down")) {
              // Visit was scheduled
              conversationData.notes += ' Visit scheduled.';
            }
          }
          
          if (event.type === 'conversation.item.input_audio_transcription.completed') {
            const transcript = event.transcript || '';
            console.log('👤 Caller:', transcript.substring(0, 100));
            
            // Extract caller intent
            const lower = transcript.toLowerCase();
            if (lower.includes('rent')) conversationData.type = 'Rental';
            if (lower.includes('buy') || lower.includes('purchase')) conversationData.type = 'Purchase';
            if (lower.includes('sell')) conversationData.type = 'Selling';
            if (lower.includes('maintenance') || lower.includes('repair')) conversationData.type = 'Maintenance';
            
            conversationData.notes += ' ' + transcript;
          }

          if (event.type === 'error') {
            console.error('❌ OpenAI Error:', event.error);
          }
        } catch (error) {
          console.error('Parse error:', error);
        }
      });

      openaiWs.on('error', (error) => {
        console.error('❌ OpenAI error:', error.message);
      });

      openaiWs.on('close', async () => {
        console.log('🔌 OpenAI closed');
        
        // Log the call when it ends
        const duration = Math.round((Date.now() - callStartTime) / 1000);
        await logCall({
          phone: callerPhone,
          duration: `${Math.floor(duration / 60)}m ${duration % 60}s`,
          type: conversationData.type,
          summary: conversationData.notes.substring(0, 500),
          outcome: 'Completed'
        });
        
        // If we captured lead info, save it
        if (conversationData.name || conversationData.interest) {
          await saveLead({
            name: conversationData.name,
            phone: conversationData.phone || callerPhone,
            interest: conversationData.type,
            property: conversationData.property,
            notes: conversationData.notes.substring(0, 500),
            status: conversationData.visitDate ? 'Visit Scheduled' : 'New Lead'
          });
        }
        
        // If visit was scheduled, save and create calendar event
        if (conversationData.visitDate) {
          const visitData = {
            visitDate: conversationData.visitDate,
            visitTime: conversationData.visitTime,
            name: conversationData.name,
            phone: conversationData.phone || callerPhone,
            property: conversationData.property,
            notes: conversationData.notes.substring(0, 200)
          };
          
          await saveVisit(visitData);
          await createCalendarEvent(visitData);
        }
      });

    } catch (error) {
      console.error('Connection failed:', error);
    }
  };

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        callerPhone = data.start.customParameters?.from || 'Unknown';
        callStartTime = Date.now();
        console.log('📞 Call started from:', callerPhone);
        connectToOpenAI();
      }
      
      if (data.event === 'media' && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: data.media.payload
        }));
      }
      
      if (data.event === 'stop') {
        console.log('📞 Call ended');
        if (openaiWs) openaiWs.close();
      }
    } catch (error) {
      console.error('Message error:', error);
    }
  });

  twilioWs.on('close', () => {
    console.log('🔌 Twilio closed');
    if (openaiWs) openaiWs.close();
  });

  twilioWs.on('error', (error) => {
    console.error('❌ Twilio error:', error.message);
  });
});

// ==================== START SERVER ====================

server.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log('✨ ====================================');
  console.log('   PETRONA VOICE AI - JADE');
  console.log(`   Port: ${PORT}`);
  console.log('   Voice: Echo (natural male)');
  console.log('   Response: 600ms');
  console.log('');
  console.log('   Features:');
  console.log('   ✅ Call Logging');
  console.log('   ✅ Lead Capture');
  console.log('   ✅ Visit Scheduling');
  console.log('   ✅ Google Calendar');
  console.log('==================================== ✨');
  console.log('');
  
  await initGoogleClients();
  const properties = await getPropertiesFromSheet();
  console.log(`📊 ${properties.rentals.length} rentals, ${properties.forSale.length} for sale`);
  
  // Pre-build and cache system prompt
  cachedSystemPrompt = await buildSystemPrompt();
  console.log('✅ System prompt cached - Ready for calls!');
});

process.on('uncaughtException', (error) => {
  console.error('Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Rejection:', reason);
});
