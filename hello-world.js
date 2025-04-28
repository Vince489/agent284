import { Agent } from './agent.js';

async function helloWorldExample() {
  // Create a new agent with custom configuration
  const agent = new Agent('kenn', {
    // Model configuration
    model: "gemini-1.5-flash", 
    temperature: 0.5,        
    topP: 0.9,              
    topK: 40,                
    maxOutputTokens: 2048,   
    systemInstruction: "You are a friendly AI assistant that responds briefly and helpfully.",
    maxMessageCount: 100,    
    useMongoDb: true         
  });
  
  // Wait for MongoDB connection to complete before proceeding
  await agent.waitForMongoConnection();
  
  // Define a simple input
  const userInput = "Hey Chatbot!";
  
  console.log("User: " + userInput);
  console.log("Agent: ");
  
  try {
    // Get streaming response from the agent
    const responseStream = await agent.analyzeStream(userInput);
    
    // Process the streaming response
    for await (const chunk of responseStream) {
      process.stdout.write(chunk.text || "");
    }
    
    console.log("\n");
    
    // Close MongoDB connection when done
    await agent.closeMongoConnection();
  } catch (error) {
    console.error("Error:", error);
    // Make sure to close MongoDB connection even if there's an error
    await agent.closeMongoConnection();
  }
}

// Run the example
helloWorldExample();




