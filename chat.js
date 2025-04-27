import { Agent } from './agent.js';
import readline from 'readline';
import { config } from 'dotenv';
import mongoose from 'mongoose';

// Load environment variables first
config();

// Connect to MongoDB using the URI from .env
async function connectToMongoDB() {
  try {
    // Check if MONGODB_URI is defined in .env
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/agent284';
    
    if (!mongoUri) {
      console.warn('MONGODB_URI not found in .env file. Running without MongoDB persistence.');
      return false;
    }
    
    console.log(`Attempting to connect to MongoDB at: ${mongoUri}`);
    
    // Use the same connection options that worked in the test script
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000
    });
    
    // Verify connection was successful
    if (mongoose.connection.readyState === 1) {
      console.log('Connected to MongoDB successfully');
      console.log(`Database name: ${mongoose.connection.db.databaseName}`);
      return true;
    } else {
      console.warn(`Unexpected connection state: ${mongoose.connection.readyState}`);
      return false;
    }
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    console.error('Error name:', error.name);
    console.error('Error stack:', error.stack);
    console.log('Continuing without MongoDB persistence. Make sure:');
    console.log('1. MongoDB server is running');
    console.log('2. Your connection string in .env is correct (MONGODB_URI=mongodb://localhost:27017/agent284)');
    console.log('3. Network allows connection to MongoDB server');
    return false;
  }
}

async function startChat(useMongoDb = true) {
  // Connect to MongoDB before starting chat if requested
  const mongoConnected = useMongoDb ? await connectToMongoDB() : false;
  
  const sessionId = `chat_${Date.now()}`;
  console.log(`Starting new chat session: ${sessionId}`);
  
  const agent = new Agent(sessionId);
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log("Chat started. Type 'exit' to end the conversation.");
  if (!mongoConnected && useMongoDb) {
    console.log("Warning: Running without MongoDB persistence. Chat history won't be saved between sessions.");
  }
  
  const askQuestion = () => {
    rl.question('You: ', async (input) => {
      if (input.toLowerCase() === 'exit') {
        console.log('Chat ended.');
        rl.close();
        // Close MongoDB connection when exiting
        if (mongoose.connection.readyState === 1) {
          await mongoose.connection.close();
          console.log('MongoDB connection closed');
        }
        return;
      }
      
      try {
        console.log('Assistant: ');
        const responseStream = await agent.analyzeStream(input);
        let fullResponse = '';
        
        for await (const chunk of responseStream) {
          if (chunk.text) {
            process.stdout.write(chunk.text);
            fullResponse += chunk.text;
          }
        }
        console.log('\n');
        
        // Continue the conversation
        askQuestion();
      } catch (error) {
        console.error('Error:', error);
        askQuestion();
      }
    });
  };

  askQuestion();
}

// Run the chat - pass false to skip MongoDB connection attempt
startChat(true);

export { startChat };





