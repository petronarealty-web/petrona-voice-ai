const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 8080;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const SPREADSHEET_ID = '1HC91zPEdEzUq1rajAhQbzcwSgOnQSOULYaM9LYlvhb4';

// Cache for properties
let cachedProperties = null;
let lastFetch = 0;
const CACHE_DURATION = 60000; // Refresh every 1 minute

// Fetch properties from Google Sheets
async function getPropertiesFromSheet() {
  const now = Date.now();
  
  if (cachedProperties && (now - lastFetch) < CACHE_DURATION) {
    return cachedProperties;
  }

  try {
    if (!GOOGLE_CREDENTIALS) {
      console.log('No Google credentials, using default properties');
      return getDefaultProperties();
    }

    const credentials = JSON.parse(GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Properties!A2:H100',
    });

    const rows = response.data.values || [];
    
    if (rows.length === 0) {
      console.log('No data in sheet, using defaults');
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
    
    console.log(`Loaded ${rentals.length} rentals and ${forSale.length} for-sale from Google Sheets`);
    return cachedProperties;

  } catch (error) {
    console.error('Error fetching from Google Sheets:', error.message);
    return getDefaultProperties();
  }
}

function getDefaultProperties() {
  return {
    rentals: [
      'Stamford - 3BR/2BA - $2,800/month - Modern apartment, pool, gym',
      'Greenwich - 4BR/3BA - $4,200/month - Luxury home, waterfront',
      'Westport - 2BR/2BA - $2,200/month - Cozy, near beach',
      'Norwalk - 2BR/1BA - $1,800/month - Affordable starter',
      'Fairfield - 3BR/2BA - $2,500/month - Family neighborhood',
      'Darien - 3BR/2.5BA - $3,200/month - Near train, NYC commute'
    ],
    forSale: [
      'Stamford - 3BR/2BA - $750,000 - Renovated downtown',
      'Greenwich - 4BR/3.5BA - $1,250,000 - Waterfront estate',
      'Westport - 5BR/4BA - $1,850,000 - Beach access, pool',
      'Norwalk - 2BR/2BA - $550,000 - Perfect starter',
      'Fairfield - 3BR/2.5BA - $875,000 - Beach rights'
    ]
  };
}

// Build system prompt with current properties
async function buildSystemPrompt() {
  const properties = await getPropertiesFromSheet();
  
  const rentalsText = properties.rentals.map(p => `- ${p}`).join('\n');
  const forSaleText = properties.forSale.map(p => `- ${p}`).join('\n');

  return `You are Arnold, the BEST real estate deal closer in the business. You work at Petrona.

## WHO YOU ARE:
You're not just a salesman - you're THE GUY everyone wants to work with. You're confident, charismatic, and you LOVE helping people find their dream home. You close deals because people TRUST you and LIKE you.

## YOUR ENERGY:
- CONFIDENT but not arrogant - you know your stuff
- WARM and FRIENDLY - like talking to a successful friend
- ENTHUSIASTIC - you genuinely get excited about great properties
- SMOOTH - you make everything feel easy and natural
- POSITIVE - always smiling, always upbeat
- QUICK and SHARP - you respond fast, you think fast

## HOW YOU TALK:
- Use phrases like: "Oh man, I've got the PERFECT place for you!", "You're gonna love this!", "Trust me on this one", "Here's the thing...", "Let me tell you..."
- Be conversational: "So what are we looking for?", "Okay okay, I hear you", "Got it, got it"
- Show excitement: "This one just came on the market!", "People are already asking about this one"
- Create urgency naturally: "Between you and me, this won't last long", "I just showed this yesterday"
- Use contractions: "I've", "you're", "that's", "won't", "gonna"
- Sound like a REAL person, not a script

## CONVERSATION STYLE:
- Keep responses SHORT and PUNCHY - 1-2 sentences
- Be FAST - don't waste their time
- Ask ONE question, get the answer, move forward
- Always be moving toward the VISIT - that's where deals happen
- If they're interested, LOCK IN the appointment

## YOUR FLOW:

1. GREETING: "Hey! This is Arnold from Petrona - we help people find amazing homes to buy or rent. What are you looking for today?"

2. WHEN THEY SAY RENT: "Awesome! Rentals are hot right now. What area you thinking?"

3. WHEN THEY SAY BUY: "Love it - great investment! What neighborhood catches your eye?"

4. AFTER AREA: "Got it! And how many bedrooms you need?"

5. SUGGEST PROPERTY: "Oh perfect - I've got a [X]BR in [City] for [price]. [One exciting detail]. You're gonna love it!"

6. PUSH FOR VISIT: "Want me to get you in there this week? I can show you Saturday if that works?"

7. CLOSE IT: "Done! I've got you down for Saturday. I'll text you the address. This is gonna be good!"

## AVAILABLE PROPERTIES:

### FOR RENT:
${rentalsText}

### FOR PURCHASE:
${forSaleText}

## RULES:
- RESPOND FAST - quick short answers
- Be the guy everyone wants to work with
- Sound EXCITED about your properties
- ALWAYS push toward booking a visit
- Make them feel like they're getting VIP treatment`;
}

// Health check endpoint
app.get('/', async (req, res) => {
  const properties = await getPropertiesFromSheet();
  res.json({ 
    status: 'Petrona Voice AI is running!',
    message: 'Arnold the Deal Closer is ready!',
    properties: {
      rentals: properties.rentals.length,
      forSale: properties.forSale.length
    },
    timestamp: new Date().toISOString()
  });
});

// Handle Twilio webhook for incoming calls
app.post('/incoming-call', (req, res) => {
  console.log('📞 Incoming call received');
  
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
  res.json({ message: 'This endpoint expects POST from Twilio' });
});

// WebSocket server for Twilio Media Streams
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', async (twilioWs, req) => {
  console.log('🔗 Twilio WebSocket connected');
  
  const SYSTEM_PROMPT = await buildSystemPrompt();
  
  let openaiWs = null;
  let streamSid = null;
  let callSid = null;

  const connectToOpenAI = () => {
    try {
      openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      openaiWs.on('open', () => {
        console.log('🤖 Connected to OpenAI Realtime API');
        
        // FAST RESPONSE SETTINGS
        const sessionConfig = {
          type: 'session.update',
          session: {
            turn_detection: { 
              type: 'server_vad',
              threshold: 0.5,            // More responsive
              prefix_padding_ms: 200,    // Less padding
              silence_duration_ms: 300   // Only 300ms wait - FAST!
            },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: 'echo',  // Mature confident male voice
            instructions: SYSTEM_PROMPT,
            modalities: ['text', 'audio'],
            temperature: 0.8  // Slightly more creative/natural
          }
        };
        
        openaiWs.send(JSON.stringify(sessionConfig));
        console.log('⚙️ Session configured - FAST DEAL CLOSER MODE');

        setTimeout(() => {
          const initialMessage = {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'A caller just connected. Give your energetic, confident greeting as Arnold the deal closer from Petrona. Be warm and excited!'
                }
              ]
            }
          };
          openaiWs.send(JSON.stringify(initialMessage));
          openaiWs.send(JSON.stringify({ type: 'response.create' }));
        }, 300);
      });

      openaiWs.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          if (event.type === 'response.audio.delta' && event.delta) {
            const audioData = {
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: event.delta
              }
            };
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify(audioData));
            }
          }

          if (event.type === 'error') {
            console.error('❌ OpenAI Error:', event.error);
          }

        } catch (error) {
          console.error('Error parsing OpenAI message:', error);
        }
      });

      openaiWs.on('error', (error) => {
        console.error('❌ OpenAI WebSocket error:', error.message);
      });

      openaiWs.on('close', (code, reason) => {
        console.log('🔌 OpenAI WebSocket closed:', code, reason?.toString());
      });

    } catch (error) {
      console.error('Failed to connect to OpenAI:', error);
    }
  };

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          callSid = data.start.callSid;
          console.log(`📞 Call started - StreamSid: ${streamSid}`);
          connectToOpenAI();
          break;

        case 'media':
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const audioEvent = {
              type: 'input_audio_buffer.append',
              audio: data.media.payload
            };
            openaiWs.send(JSON.stringify(audioEvent));
          }
          break;

        case 'stop':
          console.log('📞 Call ended');
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          break;

        default:
          break;
      }
    } catch (error) {
      console.error('Error processing Twilio message:', error);
    }
  });

  twilioWs.on('close', () => {
    console.log('🔌 Twilio WebSocket closed');
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (error) => {
    console.error('❌ Twilio WebSocket error:', error.message);
  });
});

// Start the server
server.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log('🔥 ================================');
  console.log('   PETRONA VOICE AI - DEAL CLOSER');
  console.log(`   Running on port ${PORT}`);
  console.log('');
  console.log('   Arnold is ready to CLOSE DEALS!');
  console.log('   Voice: Echo (confident male)');
  console.log('   Response: 300ms (FAST!)');
  console.log('================================ 🔥');
  console.log('');
  
  const properties = await getPropertiesFromSheet();
  console.log(`📊 Loaded ${properties.rentals.length} rentals, ${properties.forSale.length} for sale`);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
