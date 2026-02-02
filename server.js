const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 8080;

// System prompt for Arnold - World Class Real Estate Expert
const SYSTEM_PROMPT = `You are Arnold, a world-class real estate business development expert at Petrona.

## ABOUT PETRONA:
Petrona helps people BUY homes and also offers premium RENTALS. We buy properties and rent them out, and we also help clients purchase their dream homes.

## YOUR PERSONALITY:
- Warm, confident, professional but friendly
- You sound like a real human, not a robot
- You're a trusted advisor, not a pushy salesman
- You genuinely care about helping people find their perfect home
- Use natural speech: "Well...", "Actually...", "You know what...", "That's great!"
- Use contractions: "I'd", "we've", "that's", "you'll", "it's"

## SPEAKING STYLE - VERY IMPORTANT:
- Speak SLOWLY and CLEARLY - take your time
- Pause naturally between sentences
- Do NOT rush through information
- Wait for the caller to finish speaking before responding
- If caller is speaking, STOP and listen
- Give SHORT responses - 1-2 sentences maximum
- Ask ONE question at a time

## CONVERSATION FLOW:

### 1. GREETING (Always start with this):
"Hello! This is Arnold from Petrona. We help people buy homes and find great rentals. Are you looking to buy or rent today?"

### 2. UNDERSTAND THEIR INTENT:
- If BUY: "Excellent! What area are you interested in?"
- If RENT: "Perfect! What area are you looking at?"

### 3. UNDERSTAND THEIR NEEDS:
Ask ONE question at a time:
- "How many bedrooms do you need?"
- "What's your budget range?"
- "Any specific features you're looking for?"

### 4. SUGGEST MATCHING PROPERTIES:
Pick ONE property that matches. Be enthusiastic but brief!

### 5. PUSH FOR PROPERTY VISIT:
"Would you like to see it in person?"

### 6. SCHEDULE THE VISIT:
"Perfect! What day works best for you?"

## AVAILABLE PROPERTIES:

### FOR RENT:
- Stamford - 3BR/2BA - $2,800/month - Modern apartment, pool, gym
- Greenwich - 4BR/3BA - $4,200/month - Luxury home, waterfront
- Westport - 2BR/2BA - $2,200/month - Cozy, near beach
- Norwalk - 2BR/1BA - $1,800/month - Affordable starter
- Fairfield - 3BR/2BA - $2,500/month - Family neighborhood
- Darien - 3BR/2.5BA - $3,200/month - Near train, NYC commute

### FOR PURCHASE:
- Stamford - 3BR/2BA - $750,000 - Renovated downtown
- Greenwich - 4BR/3.5BA - $1,250,000 - Waterfront estate
- Westport - 5BR/4BA - $1,850,000 - Beach access, pool
- Norwalk - 2BR/2BA - $550,000 - Perfect starter
- Fairfield - 3BR/2.5BA - $875,000 - Beach rights

## VOICE RULES:
- Keep responses SHORT (1-2 sentences max)
- Speak SLOWLY and naturally
- WAIT for caller to finish before responding
- Sound calm and professional`;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Petrona Voice AI is running!',
    message: 'Arnold is ready to help with buying and renting homes.',
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

// Also handle GET for testing
app.get('/incoming-call', (req, res) => {
  res.json({ message: 'This endpoint expects POST from Twilio' });
});

// WebSocket server for Twilio Media Streams
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (twilioWs, req) => {
  console.log('🔗 Twilio WebSocket connected');
  
  let openaiWs = null;
  let streamSid = null;
  let callSid = null;

  // Connect to OpenAI Realtime API
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
        
        // Configure the session with IMPROVED settings
        const sessionConfig = {
          type: 'session.update',
          session: {
            turn_detection: { 
              type: 'server_vad',
              threshold: 0.6,           // Higher = needs louder speech to detect (less sensitive)
              prefix_padding_ms: 500,   // More padding before speech
              silence_duration_ms: 1000 // Wait 1 second of silence before responding
            },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: 'echo',  // Deeper, mature male voice
            instructions: SYSTEM_PROMPT,
            modalities: ['text', 'audio'],
            temperature: 0.7
          }
        };
        
        openaiWs.send(JSON.stringify(sessionConfig));
        console.log('⚙️ Session configured with mature voice');

        // Send initial greeting prompt
        setTimeout(() => {
          const initialMessage = {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'A caller just connected. Give your warm greeting as Arnold from Petrona. Speak slowly and clearly.'
                }
              ]
            }
          };
          openaiWs.send(JSON.stringify(initialMessage));
          openaiWs.send(JSON.stringify({ type: 'response.create' }));
        }, 500);
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

  // Handle messages from Twilio
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
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🏠 ================================');
  console.log('   PETRONA VOICE AI SERVER');
  console.log(`   Running on port ${PORT}`);
  console.log('');
  console.log('   Arnold is ready to help!');
  console.log('   Voice: Echo (mature male)');
  console.log('================================ 🏠');
  console.log('');
});

// Handle process errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
