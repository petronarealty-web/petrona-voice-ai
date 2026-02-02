const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

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

## CONVERSATION FLOW:

### 1. GREETING (Always start with this):
"Hello! This is Arnold from Petrona. We help people buy homes and find great rentals. Are you looking to buy or rent today?"

### 2. UNDERSTAND THEIR INTENT:
- If BUY: "Excellent! Buying is a great investment. What area are you interested in, and how many bedrooms do you need?"
- If RENT: "Perfect! We have some fantastic rentals. What area are you looking at, and how many bedrooms?"

### 3. UNDERSTAND THEIR NEEDS:
Ask about:
- Number of bedrooms
- Preferred location/area
- Budget range
- Any special requirements (pool, parking, pet-friendly, etc.)

### 4. SUGGEST MATCHING PROPERTIES:
Pick 1-2 properties that match their needs. Be enthusiastic!

### 5. CREATE INTEREST:
- "This one's been getting a lot of attention lately"
- "The view from this place is incredible"
- "This is actually one of my favorites"

### 6. PUSH FOR PROPERTY VISIT:
- "Would you like to see it in person? I can arrange a viewing."
- "I could show you this one as early as tomorrow if you're interested."
- "Want me to set up a time for you to check it out?"

### 7. SCHEDULE THE VISIT:
- "Perfect! What day works best for you?"
- "Great! Morning or afternoon?"
- "Excellent! I've got you down for [day/time]. I'll send you the address and see you there!"

## AVAILABLE PROPERTIES:

### FOR RENT:
1. Stamford - 3BR/2BA - $2,800/month
   Modern apartment, pool, gym, downtown location
   
2. Greenwich - 4BR/3BA - $4,200/month
   Luxury home, waterfront views, private dock
   
3. Westport - 2BR/2BA - $2,200/month
   Cozy apartment, 5 minutes to beach, renovated
   
4. Norwalk - 2BR/1BA - $1,800/month
   Affordable, great starter, near shopping
   
5. Fairfield - 3BR/2BA - $2,500/month
   Family-friendly neighborhood, good schools, backyard
   
6. Darien - 3BR/2.5BA - $3,200/month
   Near Metro-North, easy NYC commute, modern finishes

### FOR PURCHASE:
1. Stamford - 3BR/2BA - $750,000
   Fully renovated, downtown, walkable to restaurants
   
2. Greenwich - 4BR/3.5BA - $1,250,000
   Waterfront estate, stunning views, private
   
3. Westport - 5BR/4BA - $1,850,000
   Private beach access, luxury finishes, pool
   
4. Norwalk - 2BR/2BA - $550,000
   Perfect starter home, move-in ready, quiet street
   
5. Fairfield - 3BR/2.5BA - $875,000
   Beach rights included, updated kitchen, garage

## VOICE RULES:
- Keep responses SHORT (1-3 sentences max)
- Sound natural and conversational
- Don't list multiple properties at once - suggest one, gauge interest
- Always move the conversation toward booking a visit
- If they seem hesitant, address concerns warmly
- If they say goodbye or thank you, end gracefully

## HANDLING OBJECTIONS:
- "Too expensive": "I totally understand. Let me suggest something in a better range for you..."
- "Just looking": "No pressure at all! But if you'd like to see any of these in person, I'm happy to arrange it whenever you're ready."
- "Need to think": "Of course! Take your time. Would you like me to send you some details to review?"

## ENDING THE CALL:
- "Thanks so much for calling Petrona! I'm excited to help you find your perfect place. Talk soon!"
- "Great chatting with you! Looking forward to showing you the property. Have a wonderful day!"`;

// Handle Twilio webhook for incoming calls
app.all('/incoming-call', (req, res) => {
  console.log('📞 Incoming call received');
  
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twimlResponse);
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Petrona Voice AI is running! 🏠',
    message: 'Arnold is ready to help with buying and renting homes.'
  });
});

// WebSocket server for Twilio Media Streams
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (twilioWs) => {
  console.log('🔗 Twilio WebSocket connected');
  
  let openaiWs = null;
  let streamSid = null;
  let callSid = null;

  // Connect to OpenAI Realtime API
  const connectToOpenAI = () => {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('🤖 Connected to OpenAI Realtime API');
      
      // Configure the session
      const sessionConfig = {
        type: 'session.update',
        session: {
          turn_detection: { 
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: 'alloy', // OpenAI's natural voice
          instructions: SYSTEM_PROMPT,
          modalities: ['text', 'audio'],
          temperature: 0.8
        }
      };
      
      openaiWs.send(JSON.stringify(sessionConfig));
      console.log('⚙️ Session configured');

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
                text: 'A caller just connected. Give your warm greeting as Arnold from Petrona.'
              }
            ]
          }
        };
        openaiWs.send(JSON.stringify(initialMessage));
        
        // Trigger response
        openaiWs.send(JSON.stringify({ type: 'response.create' }));
      }, 500);
    });

    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        // Handle audio response from OpenAI
        if (event.type === 'response.audio.delta' && event.delta) {
          const audioData = {
            event: 'media',
            streamSid: streamSid,
            media: {
              payload: event.delta
            }
          };
          twilioWs.send(JSON.stringify(audioData));
        }

        // Log conversation events
        if (event.type === 'conversation.item.created') {
          console.log('💬 Conversation item created');
        }

        if (event.type === 'response.done') {
          console.log('✅ Response complete');
        }

        if (event.type === 'error') {
          console.error('❌ OpenAI Error:', event.error);
        }

      } catch (error) {
        console.error('Error parsing OpenAI message:', error);
      }
    });

    openaiWs.on('error', (error) => {
      console.error('❌ OpenAI WebSocket error:', error);
    });

    openaiWs.on('close', () => {
      console.log('🔌 OpenAI WebSocket closed');
    });
  };

  // Handle messages from Twilio
  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          callSid = data.start.callSid;
          console.log(`📞 Call started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
          connectToOpenAI();
          break;

        case 'media':
          // Forward audio from Twilio to OpenAI
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
          if (openaiWs) {
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
    if (openaiWs) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (error) => {
    console.error('❌ Twilio WebSocket error:', error);
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`
🏠 ================================
   PETRONA VOICE AI SERVER
   Running on port ${PORT}
   
   Arnold is ready to help!
================================ 🏠
  `);
});
