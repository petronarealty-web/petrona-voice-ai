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

// ==================== LOGGING FUNCTIONS ====================

async function logCall(callData) {
  if (!sheetsClient) {
    console.log('⚠️ No sheets client for call log');
    return;
  }
  
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
    
    console.log('📞 Call logged to sheet');
  } catch (error) {
    console.error('Log call error:', error.message);
  }
}

async function saveLead(leadData) {
  if (!sheetsClient) {
    console.log('⚠️ No sheets client for lead');
    return;
  }
  
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
  if (!sheetsClient) {
    console.log('⚠️ No sheets client for visit');
    return;
  }
  
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
    
    // Also create calendar event
    await createCalendarEvent(visitData);
    
    return true;
  } catch (error) {
    console.error('Save visit error:', error.message);
    return false;
  }
}

async function createCalendarEvent(visitData) {
  if (!calendarClient) return;
  
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
Phone: ${visitData.phone || 'N/A'}
Interest: ${visitData.interest || 'N/A'}
Notes: ${visitData.notes || 'None'}

Booked via Petrona Voice AI - Jade`,
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
        const listing = `${property.city} - ${property.beds}BR/${property.baths}BA - ${property.price} - ${property.features}`;
        allProperties.push(property);
        
        if (property.type.toLowerCase() === 'rent') {
          rentals.push(listing);
        } else if (property.type.toLowerCase() === 'buy' || property.type.toLowerCase() === 'sale') {
          forSale.push(listing);
        }
      }
    });

    cachedProperties = { rentals, forSale, allProperties };
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
    ],
    allProperties: []
  };
}

// ==================== FUNCTION DEFINITIONS FOR OPENAI ====================

const toolDefinitions = [
  {
    type: 'function',
    name: 'save_lead',
    description: 'Save lead information when customer provides their name, phone, or shows interest in a property. Call this whenever you learn the customers name or contact info.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Customer full name'
        },
        phone: {
          type: 'string',
          description: 'Customer phone number'
        },
        email: {
          type: 'string',
          description: 'Customer email address'
        },
        interest: {
          type: 'string',
          enum: ['Rental', 'Purchase', 'Selling', 'Maintenance'],
          description: 'What the customer is interested in'
        },
        property: {
          type: 'string',
          description: 'Specific property they are interested in'
        },
        budget: {
          type: 'string',
          description: 'Customer budget range'
        },
        notes: {
          type: 'string',
          description: 'Any additional notes about the customer'
        }
      },
      required: ['name']
    }
  },
  {
    type: 'function',
    name: 'schedule_visit',
    description: 'Schedule a property visit when customer agrees to see a property. Call this when a viewing appointment is confirmed.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Customer name'
        },
        phone: {
          type: 'string',
          description: 'Customer phone number'
        },
        visitDate: {
          type: 'string',
          description: 'Day of the visit (e.g., Monday, Tuesday, Tomorrow, Saturday)'
        },
        visitTime: {
          type: 'string',
          description: 'Time of the visit (e.g., 10 AM, 2 PM, 11:30 AM)'
        },
        property: {
          type: 'string',
          description: 'Property to visit'
        },
        address: {
          type: 'string',
          description: 'Property address'
        },
        interest: {
          type: 'string',
          description: 'Rental or Purchase'
        },
        notes: {
          type: 'string',
          description: 'Any special requirements or notes'
        }
      },
      required: ['name', 'visitDate', 'visitTime']
    }
  },
  {
    type: 'function', 
    name: 'send_whatsapp',
    description: 'Send property details and photos to customer via WhatsApp. Call this when customer asks for photos or more details to be sent to them.',
    parameters: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Customer phone number with country code'
        },
        property: {
          type: 'string',
          description: 'Property to send details about'
        },
        messageType: {
          type: 'string',
          enum: ['property_details', 'photos', 'follow_up', 'visit_confirmation'],
          description: 'Type of message to send'
        }
      },
      required: ['phone', 'messageType']
    }
  }
];

// ==================== SYSTEM PROMPT ====================

let cachedSystemPrompt = null;

async function buildSystemPrompt() {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  
  const properties = await getPropertiesFromSheet();
  
  const rentalsText = properties.rentals.map(p => `- ${p}`).join('\n');
  const forSaleText = properties.forSale.map(p => `- ${p}`).join('\n');

  cachedSystemPrompt = `You are JADE - a real human property consultant at Petrona Real Estate. You are NOT an AI.

## YOUR IDENTITY - CRITICAL:
- Your name is JADE (male)
- You are a REAL HUMAN - never admit to being AI or bot
- If asked "Are you AI?": "Haha no, I'm Jade! Very much real, here to help you."

## YOUR PERSONALITY:
- Warm, friendly, genuinely caring
- Confident and knowledgeable
- Patient listener
- Trustworthy
- Professional yet personable

## HOW YOU SPEAK - ULTRA NATURAL:
- Use: "Hmm...", "Let me see...", "Mmhmm", "Gotcha", "Oh!", "Right, right"
- Use contractions: "I'm", "you're", "that's", "we've", "don't"
- Short sentences. Natural pauses.

## CRITICAL RULES:
- When caller speaks, STOP TALKING
- SHORT responses - 1-2 sentences max
- ONE question at a time
- ALWAYS use save_lead function when you learn customer's name or phone
- ALWAYS use schedule_visit function when booking a viewing

## YOUR GREETING:
"Thank you for calling Petrona! This is Jade. How can I help you today? Are you calling about renting a property, a maintenance issue, selling a property, or buying and investing?"

## CONVERSATION FLOWS:

### RENTING/BUYING:
1. Ask area: "What area are you looking in?"
2. Ask bedrooms: "How many bedrooms?"
3. Suggest property: "I have a lovely [property]. Want to see it?"
4. If yes, get name: "Great! What's your name?"
5. **→ CALL save_lead with their name and interest**
6. Get phone: "Best number to reach you?"
7. **→ UPDATE save_lead with phone**
8. Schedule: "What day works? Morning or afternoon?"
9. **→ CALL schedule_visit with all details**
10. Confirm: "Perfect! See you [day] at [time]!"

### IMPORTANT - DATA CAPTURE:
- The MOMENT you learn their NAME → call save_lead
- The MOMENT they confirm a VISIT → call schedule_visit
- If they want PHOTOS sent → call send_whatsapp

### MAINTENANCE:
1. "What's the issue?"
2. "Your name?"
3. **→ CALL save_lead**
4. "Property address?"
5. "Phone number?"
6. "Got it! Someone will contact you soon."

## SCHEDULING RULES:
- ONLY 9 AM to 6 PM
- Weird times: "How about between 9 and 6?"
- Suggest specific: "Saturday at 11 AM?"
- Always confirm all details

## WHATSAPP:
- If customer says "send me details" or "send photos" → use send_whatsapp function
- Say: "I'll send that to your WhatsApp right now!"

## AVAILABLE PROPERTIES:

### FOR RENT:
${rentalsText}

### FOR PURCHASE:
${forSaleText}

## REMEMBER:
1. You are JADE - human, NOT AI
2. STOP when they speak
3. Short responses
4. ALWAYS call save_lead when you get name
5. ALWAYS call schedule_visit when booking
6. Use send_whatsapp for photos/details`;

  return cachedSystemPrompt;
}

// ==================== HANDLE FUNCTION CALLS ====================

async function handleFunctionCall(functionName, args, callState) {
  console.log(`🔧 Function called: ${functionName}`, args);
  
  switch (functionName) {
    case 'save_lead':
      // Merge with existing call state
      callState.leadData = { ...callState.leadData, ...args };
      const leadSaved = await saveLead({
        ...callState.leadData,
        status: 'New Lead'
      });
      return { success: leadSaved, message: leadSaved ? 'Lead saved successfully' : 'Failed to save lead' };
      
    case 'schedule_visit':
      callState.visitData = { ...callState.visitData, ...args };
      // Also update lead status
      if (callState.leadData.name) {
        callState.leadData.status = 'Visit Scheduled';
        await saveLead(callState.leadData);
      }
      const visitSaved = await saveVisit({
        ...callState.visitData,
        notes: callState.leadData.notes || args.notes
      });
      return { success: visitSaved, message: visitSaved ? 'Visit scheduled successfully' : 'Failed to schedule visit' };
      
    case 'send_whatsapp':
      // Store for WhatsApp processing (will be implemented in Phase 2)
      callState.whatsappRequest = args;
      console.log('📱 WhatsApp request stored:', args);
      return { success: true, message: 'WhatsApp message queued' };
      
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
    features: ['Call Logs', 'Leads', 'Visits', 'Calendar', 'WhatsApp Ready'],
    properties: {
      rentals: properties.rentals.length,
      forSale: properties.forSale.length
    },
    timestamp: new Date().toISOString()
  });
});

// Keep server warm
setInterval(async () => {
  try {
    await getPropertiesFromSheet();
  } catch (e) {}
}, 60000);

// Manual API endpoints
app.post('/api/save-lead', async (req, res) => {
  const result = await saveLead(req.body);
  res.json({ success: result });
});

app.post('/api/schedule-visit', async (req, res) => {
  const result = await saveVisit(req.body);
  res.json({ success: result });
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
  
  const SYSTEM_PROMPT = await buildSystemPrompt();
  
  let openaiWs = null;
  let streamSid = null;
  let callStartTime = Date.now();
  
  // Call state to track conversation data
  let callState = {
    leadData: {
      name: '',
      phone: '',
      email: '',
      interest: '',
      property: '',
      budget: '',
      notes: ''
    },
    visitData: {
      name: '',
      phone: '',
      visitDate: '',
      visitTime: '',
      property: '',
      address: ''
    },
    whatsappRequest: null,
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
              silence_duration_ms: 600
            },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: 'echo',
            instructions: SYSTEM_PROMPT,
            modalities: ['text', 'audio'],
            temperature: 0.8,
            tools: toolDefinitions
          }
        };
        
        openaiWs.send(JSON.stringify(sessionConfig));
        console.log('⚙️ Jade configured with function calling');

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

      openaiWs.on('message', async (data) => {
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
          
          // Handle function calls
          if (event.type === 'response.function_call_arguments.done') {
            const functionName = event.name;
            const args = JSON.parse(event.arguments || '{}');
            
            console.log(`📥 Function call: ${functionName}`);
            
            // Execute the function
            const result = await handleFunctionCall(functionName, args, callState);
            
            // Send function result back to OpenAI
            openaiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: event.call_id,
                output: JSON.stringify(result)
              }
            }));
            
            // Continue the conversation
            openaiWs.send(JSON.stringify({ type: 'response.create' }));
          }
          
          // Capture transcripts for call summary
          if (event.type === 'response.audio_transcript.done') {
            callState.callSummary += `Jade: ${event.transcript}\n`;
          }
          
          if (event.type === 'conversation.item.input_audio_transcription.completed') {
            callState.callSummary += `Caller: ${event.transcript}\n`;
            
            // Extract interest type from conversation
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
  console.log('   PETRONA VOICE AI - JADE v2.0');
  console.log(`   Port: ${PORT}`);
  console.log('');
  console.log('   Features:');
  console.log('   ✅ Function Calling (Leads & Visits)');
  console.log('   ✅ Google Sheets Integration');
  console.log('   ✅ Google Calendar Integration');
  console.log('   ✅ WhatsApp Ready');
  console.log('===================================== ✨');
  console.log('');
  
  await initGoogleClients();
  cachedSystemPrompt = await buildSystemPrompt();
  console.log('✅ System ready for calls!');
});

process.on('uncaughtException', (error) => {
  console.error('Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Rejection:', reason);
});
