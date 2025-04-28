import { GoogleGenAI } from "@google/genai";
import { config } from 'dotenv';
import { Memory } from './memory.js';

config();

class Agent {
  constructor(sessionId) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY environment variable not set.");
    }
    this.genAI = new GoogleGenAI({ apiKey });
    this.sessionId = sessionId || `session_${Date.now()}`;
    this.memory = new Memory({ 
      sessionId: this.sessionId,
      maxMessageCount: 200
    });
    
    // Initialize token tracking
    this.tokenStats = {
      totalInput: 0,
      totalOutput: 0,
      totalHistory: 0,
      currentSession: 0
    };
    
    // Initialize custom tools
    this.tools = {
      calculate: this.calculateTool.bind(this),
      getWeather: this.getWeatherTool.bind(this)
    };
  }
  
  // Custom calculate tool
  async calculateTool(expression) {
    try {
      // Simple and safe evaluation using Function constructor
      const result = new Function(`return ${expression}`)();
      return { expression, result };
    } catch (error) {
      return { expression, error: error.message };
    }
  }
  
  // Custom weather tool
  async getWeatherTool(location) {
    // Mock implementation - in a real app, you'd call a weather API
    return {
      location,
      temperature: "22°C",
      condition: "Sunny",
      humidity: "45%"
    };
  }

  async getTokenCount(text) {
    try {
      const result = await this.genAI.models.countTokens({
        model: "gemini-1.5-flash",
        contents: [{ role: 'user', parts: [{ text }] }]
      });
      return result.totalTokens;
    } catch (error) {
      console.error("Error counting tokens:", error);
      return null;
    }
  }
  
  async analyzeStream(input, context = {}) {
    // Count tokens in user input
    const inputTokens = await this.getTokenCount(input);
    if (inputTokens) {
      this.tokenStats.totalInput += inputTokens;
      this.tokenStats.currentSession += inputTokens;
      console.log(`User input: ${inputTokens} tokens`);
    }
    
    // Add user message to memory
    await this.memory.addMessage({ role: 'user', text: input }, input);
    
    // Get conversation history from memory
    const memoryContext = await this.memory.getRelevantContext(input);
    
    // Count tokens in memory context if available
    if (memoryContext && memoryContext.length > 0) {
      const contextTokens = await this.getTokenCount(memoryContext);
      if (contextTokens) {
        this.tokenStats.totalHistory = contextTokens;
        console.log(`Memory context: ${contextTokens} tokens`);
      }
    }
    
    // System instruction with tool usage instructions
    const systemInstruction = `You are a helpful AI assistant. You have access to the following tools:
1. calculate - Evaluates mathematical expressions. Usage: When a user asks for a calculation, respond with: "I'll calculate that for you: [expression]"
2. getWeather - Gets weather information. Usage: When a user asks about weather, respond with: "I'll check the weather in [location]"

Only use these tools when explicitly asked. For general questions, respond conversationally.`;
    
    try {
      // Create chat options
      const chatOptions = {
        model: "gemini-1.5-flash",
        config: {
          temperature: 0.7,
          maxOutputTokens: 8192
        },
        systemInstruction: systemInstruction
      };
      
      // Build the chat history for the Gemini API
      const chatHistory = [];
      
      // Add memory context if available
      if (memoryContext && memoryContext.length > 0) {
        console.log(`Including previous conversation context (${memoryContext.length} characters)`);
        chatHistory.push({ role: 'user', parts: [{ text: `PREVIOUS CONVERSATION CONTEXT:\n${memoryContext}` }] });
        chatHistory.push({ role: 'model', parts: [{ text: "Noted." }] });
      } else {
        console.log("No previous conversation context available");
      }
      
      chatOptions.history = chatHistory;
      
      // Create a chat session
      const chat = this.genAI.chats.create(chatOptions);
      
      // Send the message and get a streaming response
      const response = await chat.sendMessageStream({
        message: input
      });
      
      // Collect the full response to save to memory
      let fullResponse = '';
      const self = this;
      
      const responseStream = {
        [Symbol.asyncIterator]: async function* () {
          for await (const chunk of response) {
            if (chunk.text) {
              // Check for tool usage patterns in the response
              const calculateMatch = chunk.text.match(/I'll calculate that for you: (.+)/i);
              const weatherMatch = chunk.text.match(/I'll check the weather in (.+)/i);
              
              if (calculateMatch) {
                const expression = calculateMatch[1].trim();
                console.log(`Detected calculation request: ${expression}`);
                
                try {
                  const result = await self.tools.calculate(expression);
                  const resultText = `\nCalculation result: ${expression} = ${result.result}`;
                  fullResponse += chunk.text + resultText;
                  yield { text: chunk.text };
                  yield { text: resultText };
                } catch (error) {
                  const errorText = `\nError in calculation: ${error.message}`;
                  fullResponse += chunk.text + errorText;
                  yield { text: chunk.text };
                  yield { text: errorText };
                }
              } else if (weatherMatch) {
                const location = weatherMatch[1].trim();
                console.log(`Detected weather request for: ${location}`);
                
                try {
                  const weather = await self.tools.getWeather(location);
                  const weatherText = `\nWeather in ${location}: ${weather.temperature}, ${weather.condition}, Humidity: ${weather.humidity}`;
                  fullResponse += chunk.text + weatherText;
                  yield { text: chunk.text };
                  yield { text: weatherText };
                } catch (error) {
                  const errorText = `\nError getting weather: ${error.message}`;
                  fullResponse += chunk.text + errorText;
                  yield { text: chunk.text };
                  yield { text: errorText };
                }
              } else {
                fullResponse += chunk.text;
                yield { text: chunk.text };
              }
            }
          }
          
          // Count tokens in the response
          const responseTokens = await self.getTokenCount(fullResponse);
          if (responseTokens) {
            self.tokenStats.totalOutput += responseTokens;
            self.tokenStats.currentSession += responseTokens;
            console.log(`Assistant response: ${responseTokens} tokens`);
          }
          
          // After collecting the full response, save it to memory
          await self.memory.addMessage({ role: 'assistant', text: fullResponse }, input);
          console.log(`Saved assistant response to memory (${fullResponse.length} chars)`);
          
          // Log token statistics
          console.log(`Token stats - Session: ${self.tokenStats.currentSession}, Total input: ${self.tokenStats.totalInput}, Total output: ${self.tokenStats.totalOutput}, History size: ${self.tokenStats.totalHistory}`);
        }
      };
      
      return responseStream;
    } catch (error) {
      console.error("Error analyzing input (streaming):", error);
      throw error;
    }
  }
  
  // Method to get current token statistics
  getTokenStats() {
    return {
      ...this.tokenStats,
      total: this.tokenStats.totalInput + this.tokenStats.totalOutput
    };
  }
}

async function runAgentStream(userInput, sessionId) {
  const agent = new Agent(sessionId);
  
  try {
    const responseStream = await agent.analyzeStream(userInput);
    for await (const chunk of responseStream) {
      process.stdout.write(chunk.text || "");
    }
    console.log();
  } catch (error) {
    console.error("Error in runAgentStream:", error);
  }
}

export { Agent, runAgentStream };
