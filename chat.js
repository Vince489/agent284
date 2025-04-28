import { Agent } from './agent.js';
import readline from 'readline';
import { config } from 'dotenv';

// Load environment variables first
config();

async function startChat(useMongoDb = true) {
  const sessionId = `chat_${Date.now()}`;
  console.log(`Starting new chat session: ${sessionId}`);
  
  // Create agent with MongoDB option and wait for connection to complete
  const agent = new Agent(sessionId, { useMongoDb });
  
  // Wait for MongoDB connection to complete before starting chat
  if (useMongoDb) {
    await agent.waitForMongoConnection();
  }
  
  console.log("Chat started. Type 'exit' to end the conversation.");
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const promptAI = () => {
    rl.question('You: ', async (input) => {
      if (input.toLowerCase() === 'exit') {
        console.log('Chat ended.');
        rl.close();
        // Close MongoDB connection when exiting
        await agent.closeMongoConnection();
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
        promptAI();
      } catch (error) {
        console.error('Error:', error);
        promptAI();
      }
    });
  };

  promptAI();
}

// Run the chat - pass true to use MongoDB
startChat(true);











