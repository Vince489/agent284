import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { Agent } from './agent.js';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection string from .env
const MONGO_URI = process.env.MONGO_URI 

// Configure middleware
app.use(express.json());

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB successfully');
    return true;
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    return false;
  }
}

// Initialize MongoDB connection
const mongoConnected = await connectToMongoDB();

// Configure session middleware with MongoDB store
if (mongoConnected) {
  app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    store: MongoStore.create({
      mongoUrl: MONGO_URI,
      collectionName: 'sessions',
      ttl: 14 * 24 * 60 * 60, // 14 days
    }),
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 14 * 24 * 60 * 60 * 1000 // 14 days
    },
    name: 'agent.sid' // Custom session name
  }));
  console.log('Session management with MongoDB store initialized');
} else {
  console.warn('Using in-memory session store as MongoDB connection failed');
  app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day
  }));
}

// Agent instance map to store active agents
const agentInstances = new Map();

// Middleware to initialize or retrieve agent for the session
app.use(async (req, res, next) => {
  if (!req.session.id) {
    return next();
  }
  
  // Get or create agent for this session
  if (!agentInstances.has(req.session.id)) {
    const agent = new Agent(req.session.id, {
      useMongoDb: mongoConnected
    });
    
    // Wait for MongoDB connection if using MongoDB
    if (mongoConnected) {
      await agent.waitForMongoConnection();
    }
    agentInstances.set(req.session.id, agent);
  }
  
  // Attach agent to request
  req.agent = agentInstances.get(req.session.id);
  next();
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Stream response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const responseStream = await req.agent.analyzeStream(message);
    
    // Send response chunks as they arrive
    for await (const chunk of responseStream) {
      if (chunk.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
      }
    }
    
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat request' });
  }
});

// Simple HTML interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>AI Chat</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        #chat { height: 400px; border: 1px solid #ccc; overflow-y: auto; padding: 10px; margin-bottom: 10px; }
        #input { width: 80%; padding: 8px; }
        button { padding: 8px 15px; }
        .user { color: blue; }
        .agent { color: green; }
      </style>
    </head>
    <body>
      <h1>AI Chat</h1>
      <div id="chat"></div>
      <input id="input" type="text" placeholder="Type your message...">
      <button onclick="sendMessage()">Send</button>
      
      <script>
        const chatDiv = document.getElementById('chat');
        const inputField = document.getElementById('input');
        
        function addMessage(role, text) {
          const div = document.createElement('div');
          div.className = role;
          div.textContent = role === 'user' ? 'You: ' + text : 'AI: ' + text;
          chatDiv.appendChild(div);
          chatDiv.scrollTop = chatDiv.scrollHeight;
        }
        
        async function sendMessage() {
          const message = inputField.value.trim();
          if (!message) return;
          
          addMessage('user', message);
          inputField.value = '';
          
          const responseDiv = document.createElement('div');
          responseDiv.className = 'agent';
          responseDiv.textContent = 'AI: ';
          chatDiv.appendChild(responseDiv);
          
          try {
            const response = await fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message })
            });
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              
              const chunk = decoder.decode(value);
              const lines = chunk.split('\\n\\n');
              
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = JSON.parse(line.substring(6));
                  if (data.text) {
                    responseDiv.textContent += data.text;
                    chatDiv.scrollTop = chatDiv.scrollHeight;
                  }
                }
              }
            }
          } catch (error) {
            console.error('Error:', error);
            responseDiv.textContent += 'Error: Failed to get response';
          }
        }
        
        inputField.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') sendMessage();
        });
      </script>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  
  // Close all agent connections
  for (const agent of agentInstances.values()) {
    await agent.closeMongoConnection();
  }
  
  // Close MongoDB connection
  if (mongoConnected) {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
  
  process.exit(0);
});
