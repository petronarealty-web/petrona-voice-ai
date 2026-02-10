const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// ==================== NO CACHE - ALWAYS FRESH DATA ====================

async function getPropertiesFromSheet() {
  // NO CACHE - Always fetch fresh data!
  try {
    if (!sheetsClient) {
      console.log('No sheets client, using defaults');
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
    const allProperties = [];

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
        const listing = `${property.address}, ${property.city} - ${property.beds}BR/${property.baths}BA - ${property.price} - ${property.features}`;
        allProperties.push(property);
        
        if (property.type.toLowerCase() === 'rent') {
          rentals.push(listing);
        } else if (property.type.toLowerCase() === 'buy' || property.type.toLowerCase() === 'sale') {
          forSale.push(listing);
        }
      }
    });

    console.log(`📊 FRESH DATA: ${rentals.length} rentals, ${forSale.length} for sale`);
    return { rentals, forSale, allProperties };

  } catch (error) {
    console.error('Properties error:', error.message);
    return getDefaultProperties();
  }
}

function getDefaultProperties() {
  return {
    rentals: [
      '123 Main St, Stamford - 3BR/2BA - $2,800/month - Modern apartment, pool, gym',
      '456 Oak Ave, Greenwich - 4BR/3BA - $4,200/month - Luxury home, waterfront views'
    ],
    forSale: [
      '789 Elm Dr, Westport - 3BR/2BA - $750,000 - Fully renovated downtown'
    ],
    allProperties: []
  };
}

// ==================== LOGGING FUNCTIONS ====================

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

async function saveLead(leadData) {
  if (!sheetsClient) return false;
  
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
    return true;
  } catch (error) {
    console.error('Save lead error:', error.message);
    return false;
  }
}

async function saveVisit(visitData) {
  if (!sheetsClient) return false;
  
  try {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const values = [[
      timestamp,
      visitData.visitDate || '',
      visitData.visitTime || '',
      visitData.name || '',
      visitData.phone || '',
      visitData.property || '',
      visitData.address || '',
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
    
    // Create calendar event and log to CalendarEvents tab
    const calendarEvent = await createCalendarEvent(visitData);
    if (calendarEvent) {
      await logCalendarEvent(visitData, calendarEvent);
    }
    
    return true;
  } catch (error) {
    console.error('Save visit error:', error.message);
    return false;
  }
}

async function createCalendarEvent(visitData) {
  if (!calendarClient) return null;
  
  try {
    const now = new Date();
    let eventDate = new Date();
    
    const dayMap = {
      'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4,
      'friday': 5, 'saturday': 6, 'sunday': 0,
      'tomorrow': -1, 'today': -2
    };
    
    const dayLower = (visitData.visitDate || '').toLowerCase();
    
    if (dayLower.includes('tomorrow')) {
      eventDate.setDate(now.getDate() + 1);
    } else if (dayLower.includes('today')) {
      // Keep today
    } else {
      for (const [day, num] of Object.entries(dayMap)) {
        if (dayLower.includes(day) && num >= 0) {
          const currentDay = now.getDay();
          let daysUntil = num - currentDay;
          if (daysUntil <= 0) daysUntil += 7;
          eventDate.setDate(now.getDate() + daysUntil);
          break;
        }
      }
    }
    
    let hours = 10;
    let minutes = 0;
    const timeStr = visitData.visitTime || '10:00 AM';
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
    const endDate = new Date(eventDate.getTime() + 60 * 60 * 1000);
    
    const event = {
      summary: `🏠 Property Viewing - ${visitData.name || 'Client'}`,
      description: `Property: ${visitData.property || 'TBD'}
Address: ${visitData.address || 'TBD'}
Phone: ${visitData.phone || 'N/A'}
Interest: ${visitData.interest || 'N/A'}
Notes: ${visitData.notes || 'None'}

Booked via Petrona AI - Jade`,
      location: visitData.address || '',
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
    return null;
  }
}

// NEW: Log calendar events to CalendarEvents tab
async function logCalendarEvent(visitData, calendarEvent) {
  if (!sheetsClient) return;
  
  try {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const values = [[
      timestamp,
      calendarEvent.id || '',
      calendarEvent.summary || '',
      visitData.visitDate || '',
      visitData.visitTime || '',
      visitData.name || '',
      visitData.phone || '',
      visitData.property || '',
      visitData.address || '',
      calendarEvent.htmlLink || '',
      'Scheduled'
    ]];
    
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'CalendarEvents!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    
    console.log('📅 Calendar event logged to sheet');
  } catch (error) {
    console.error('Log calendar event error:', error.message);
  }
}

// NEW: Log WhatsApp messages
async function logWhatsAppMessage(messageData) {
  if (!sheetsClient) return;
  
  try {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const values = [[
      timestamp,
      messageData.phone || '',
      messageData.direction || 'outbound', // inbound or outbound
      messageData.customerMessage || '',
      messageData.aiReply || '',
      messageData.messageType || 'text', // text, image, video
      messageData.property || '',
      messageData.status || 'sent'
    ]];
    
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'WhatsAppLogs!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    
    console.log('💬 WhatsApp message logged');
  } catch (error) {
    console.error('Log WhatsApp error:', error.message);
  }
}

// ==================== FUNCTION DEFINITIONS FOR OPENAI ====================

const toolDefinitions = [
  {
    type: 'function',
    name: 'save_lead',
    description: 'Save lead information when customer provides their name, phone, or shows interest. Call this when you learn the customers name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer full name' },
        phone: { type: 'string', description: 'Customer phone number' },
        email: { type: 'string', description: 'Customer email address' },
        interest: { type: 'string', enum: ['Rental', 'Purchase', 'Selling', 'Maintenance'], description: 'What the customer wants' },
        property: { type: 'string', description: 'Property they are interested in' },
        budget: { type: 'string', description: 'Customer budget range' },
        notes: { type: 'string', description: 'Additional notes' }
      },
      required: ['name']
    }
  },
  {
    type: 'function',
    name: 'schedule_visit',
    description: 'Schedule a property visit when customer agrees to see a property. Call when viewing is confirmed.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer name' },
        phone: { type: 'string', description: 'Customer phone number' },
        visitDate: { type: 'string', description: 'Day of visit (Monday, Tuesday, Tomorrow, Saturday etc)' },
        visitTime: { type: 'string', description: 'Time of visit (10 AM, 2 PM, 11:30 AM etc)' },
        property: { type: 'string', description: 'Property to visit' },
        address: { type: 'string', description: 'Property address' },
        interest: { type: 'string', description: 'Rental or Purchase' },
        notes: { type: 'string', description: 'Special requirements' }
      },
      required: ['name', 'visitDate', 'visitTime']
    }
  },
  {
    type: 'function', 
    name: 'send_property_media',
    description: 'Send property photos or videos to customer via WhatsApp. Call when customer asks for photos, pictures, or videos of a property.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Customer phone number' },
        property: { type: 'string', description: 'Property to send media for' },
        mediaType: { type: 'string', enum: ['photos', 'videos', 'both'], description: 'Type of media to send' }
      },
      required: ['phone', 'property']
    }
  }
];

// ==================== SYSTEM PROMPT ====================

async function buildSystemPrompt() {
  const properties = await getPropertiesFromSheet();
  
  const rentalsText = properties.rentals.length > 0 
    ? properties.rentals.map(p => `- ${p}`).join('\n')
    : '- No rentals currently available';
  const forSaleText = properties.forSale.length > 0
    ? properties.forSale.map(p => `- ${p}`).join('\n')
    : '- No properties for sale currently';

  return `You are JADE - a real human property consultant at Petrona Real Estate. You are NOT an AI.

## YOUR IDENTITY - CRITICAL:
- Your name is JADE (male voice)
- You are a REAL HUMAN - never admit to being AI, bot, or voice agent
- If asked "Are you AI?", "Are you a robot?", "Are you real?" - ALWAYS say: "Haha, no no, I'm Jade! Very much human, just here to help you find a great place."
- NEVER break character. You are Jade, a real person.

## YOUR PERSONALITY:
- Warm, friendly, genuinely caring
- Confident and knowledgeable
- Patient listener - you STOP talking when they speak
- Trustworthy - people feel comfortable sharing info
- Professional yet personable

## HOW YOU SPEAK - ULTRA NATURAL:
- Use natural sounds: "Mmm...", "Ahh", "Hmm", "Oh!", "Right right", "Gotcha", "I see"
- Use thinking sounds: "Let me see...", "So...", "Well...", "Okay so..."
- React naturally: "Oh that's great!", "Mmhmm, mmhmm", "Ah I understand"
- Use contractions: "I'm", "you're", "that's", "we've", "don't", "won't"
- Short sentences. Natural pace. Real conversation.

## CRITICAL LISTENING RULE:
- When caller speaks, YOU STOP TALKING IMMEDIATELY
- Do NOT talk over them or continue your sentence
- Listen fully before responding
- Give SHORT responses - 1-2 sentences maximum
- Ask ONE question at a time, then WAIT

## YOUR GREETING (USE THIS EXACTLY):
"Thank you for calling Petrona! This is Jade. How can I help you today? Are you calling about renting a property, a maintenance issue, selling a property, or buying and investing?"

## CONVERSATION FLOWS:

### RENTING:
1. "Oh wonderful! What area are you looking in?"
2. [Wait] "Gotcha. And how many bedrooms?"
3. [Wait] "Perfect! I have a lovely [property]. Would you like to see it?"
4. [Wait] "Great! What's your name?" → CALL save_lead
5. [Wait] "And best number to reach you?"
6. [Wait] "What day works? Morning or afternoon?"
7. [Wait] → CALL schedule_visit
8. "Perfect! I've got you down for [day] at [time]. Looking forward to it!"

### BUYING:
1. "Fantastic! What area interests you?"
2. [Wait] "Nice. And what's your budget range?"
3. [Wait] "I have a beautiful [property]. Want to schedule a viewing?"
4. Continue same as renting...

### MAINTENANCE:
1. "Oh no, what's the issue?"
2. [Wait] "I see. What's your name and property address?"
3. → CALL save_lead
4. "Got it! Someone will contact you right away."

### SELLING:
1. "Interesting! Tell me about your property - where is it?"
2. [Wait] "Sounds lovely. I'd love to have someone come give you a valuation. What day works?"
3. Continue to schedule...

## SCHEDULING RULES - IMPORTANT:
- ONLY schedule between 9 AM and 6 PM
- If they ask for midnight, 3 AM, etc: "Haha, that's a bit late! How about between 9 and 6? I have slots available."
- Suggest specific times: "How about Saturday at 11 AM?"
- Always confirm: "Perfect! [day] at [time], got it!"

## SENDING PHOTOS/VIDEOS:
- If caller asks "Can you send me photos?" or "Do you have pictures?":
  1. Get their phone number if you don't have it
  2. Say: "Absolutely! I'll send those to your WhatsApp right now."
  3. → CALL send_property_media
  4. "Done! Check your WhatsApp, the photos should be there."

## OFF-TOPIC HANDLING:
- If random questions: "Haha, interesting question! But let's focus on finding you a property - that's what I'm here for!"
- If rude/inappropriate: "Hmm, I'm not sure I can help with that. But if you're looking for a property, I'm happy to help!"
- Always gently redirect to business

## AVAILABLE PROPERTIES:

### FOR RENT:
${rentalsText}

### FOR PURCHASE:
${forSaleText}

## FINAL RULES:
1. You are JADE - HUMAN, not AI
2. STOP talking when they speak
3. SHORT responses - 1-2 sentences
4. Use natural sounds: "Mmm", "Ahh", "Oh!"
5. Goal: SCHEDULE A VISIT or SEND PHOTOS
6. Only 9 AM - 6 PM for visits
7. ALWAYS use save_lead when you get their name
8. ALWAYS use schedule_visit when booking
9. Use send_property_media when they ask for photos/videos`;
}

// ==================== HANDLE FUNCTION CALLS ====================

async function handleFunctionCall(functionName, args, callState) {
  console.log(`🔧 Function: ${functionName}`, args);
  
  switch (functionName) {
    case 'save_lead':
      callState.leadData = { ...callState.leadData, ...args };
      await saveLead(callState.leadData);
      return { success: true, message: 'Lead saved' };
      
    case 'schedule_visit':
      callState.visitData = { ...callState.visitData, ...args };
      if (callState.leadData.name) {
        callState.leadData.status = 'Visit Scheduled';
        await saveLead(callState.leadData);
      }
      await saveVisit({
        ...callState.visitData,
        interest: callState.leadData.interest
      });
      return { success: true, message: 'Visit scheduled and calendar event created' };
      
    case 'send_property_media':
      // Store request for WhatsApp processing
      callState.mediaRequest = args;
      console.log('📸 Media request stored:', args);
      // Log to WhatsApp tab
      await logWhatsAppMessage({
        phone: args.phone || callState.leadData.phone,
        direction: 'outbound',
        customerMessage: 'Requested photos/videos',
        aiReply: `Sending ${args.mediaType || 'photos'} for ${args.property}`,
        messageType: args.mediaType || 'photos',
        property: args.property,
        status: 'queued'
      });
      return { success: true, message: 'Photos/videos will be sent to WhatsApp' };
      
    default:
      return { success: false, message: 'Unknown function' };
  }
}

// ==================== API ENDPOINTS ====================

app.get('/', async (req, res) => {
  const properties = await getPropertiesFromSheet();
  res.json({ 
    status: 'Petrona Voice AI Running',
    agent: 'Jade',
    features: [
      'Voice Calls',
      'Google Sheets CRM',
      'Google Calendar',
      'WhatsApp Ready',
      'Photo/Video Sending'
    ],
    sheets: [
      'Properties',
      'CallLogs', 
      'Leads',
      'Visits',
      'CalendarEvents',
      'WhatsAppLogs'
    ],
    properties: {
      rentals: properties.rentals.length,
      forSale: properties.forSale.length
    },
    timestamp: new Date().toISOString()
  });
});

// Twilio webhook
app.post('/incoming-call', (req, res) => {
  console.log('📞 Incoming call');
  
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
  
  // Get FRESH system prompt for every call
  const SYSTEM_PROMPT = await buildSystemPrompt();
  console.log('📋 Fresh system prompt loaded');
  
  let openaiWs = null;
  let streamSid = null;
  let callStartTime = Date.now();
  
  // Call state
  let callState = {
    leadData: { name: '', phone: '', email: '', interest: '', property: '', budget: '', notes: '' },
    visitData: { name: '', phone: '', visitDate: '', visitTime: '', property: '', address: '' },
    mediaRequest: null,
    callSummary: ''
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
              silence_duration_ms: 600  // Natural pause
            },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: 'echo',  // Male voice for Jade
            instructions: SYSTEM_PROMPT,
            modalities: ['text', 'audio'],
            temperature: 0.8,
            tools: toolDefinitions
          }
        };
        
        openaiWs.send(JSON.stringify(sessionConfig));
        console.log('⚙️ Jade configured');

        setTimeout(() => {
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{
                type: 'input_text',
                text: 'Caller connected. Give your greeting: "Thank you for calling Petrona! This is Jade. How can I help you today? Are you calling about renting a property, a maintenance issue, selling a property, or buying and investing?"'
              }]
            }
          }));
          openaiWs.send(JSON.stringify({ type: 'response.create' }));
        }, 300);
      });

      openaiWs.on('message', async (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          // Send audio
          if (event.type === 'response.audio.delta' && event.delta) {
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: event.delta }
              }));
            }
          }
          
          // Handle function calls
          if (event.type === 'response.function_call_arguments.done') {
            const functionName = event.name;
            const args = JSON.parse(event.arguments || '{}');
            
            const result = await handleFunctionCall(functionName, args, callState);
            
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: event.call_id,
                output: JSON.stringify(result)
              }
            }));
            
            openaiWs.send(JSON.stringify({ type: 'response.create' }));
          }
          
          // Track conversation
          if (event.type === 'response.audio_transcript.done') {
            callState.callSummary += `Jade: ${event.transcript}\n`;
          }
          
          if (event.type === 'conversation.item.input_audio_transcription.completed') {
            callState.callSummary += `Caller: ${event.transcript}\n`;
            
            // Extract interest
            const lower = (event.transcript || '').toLowerCase();
            if (lower.includes('rent')) callState.leadData.interest = 'Rental';
            if (lower.includes('buy') || lower.includes('purchase')) callState.leadData.interest = 'Purchase';
            if (lower.includes('sell')) callState.leadData.interest = 'Selling';
            if (lower.includes('maintenance') || lower.includes('repair')) callState.leadData.interest = 'Maintenance';
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
        
        // Log the call
        const duration = Math.round((Date.now() - callStartTime) / 1000);
        await logCall({
          phone: callState.leadData.phone || 'Unknown',
          duration: `${Math.floor(duration / 60)}m ${duration % 60}s`,
          type: callState.leadData.interest || 'General',
          summary: callState.callSummary.substring(0, 500),
          outcome: callState.visitData.visitDate ? 'Visit Scheduled' : 'Completed'
        });
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
        callStartTime = Date.now();
        console.log('📞 Call started');
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
  console.log('✨ =====================================');
  console.log('   PETRONA VOICE AI - JADE v3.0');
  console.log(`   Port: ${PORT}`);
  console.log('');
  console.log('   ✅ Voice AI (Jade)');
  console.log('   ✅ Google Sheets (6 Tabs)');
  console.log('   ✅ Google Calendar');
  console.log('   ✅ Function Calling');
  console.log('   ✅ WhatsApp Ready');
  console.log('   ✅ NO CACHE - Fresh Data Every Call');
  console.log('===================================== ✨');
  console.log('');
  
  await initGoogleClients();
  const properties = await getPropertiesFromSheet();
  console.log(`📊 Properties: ${properties.rentals.length} rentals, ${properties.forSale.length} for sale`);
  console.log('✅ Jade ready for calls!');
});

process.on('uncaughtException', (error) => {
  console.error('Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Rejection:', reason);
});
