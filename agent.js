import { GoogleGenAI } from "@google/genai";
import { config } from 'dotenv';
import { HybridConversationMemory } from './memory.js';
import mongoose from 'mongoose';

config();

class Agent {
  constructor(sessionId, options = {}) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY environment variable not set.");
    }

    // MongoDB configuration
    this.useMongoDb = options.useMongoDb !== undefined ? options.useMongoDb : false;
    this.mongoConnected = false;

    // Connect to MongoDB if enabled
    if (this.useMongoDb) {
      this._connectToMongoDB();
    }

    this.genAI = new GoogleGenAI({ apiKey });
    this.sessionId = sessionId || `session_${Date.now()}`;
    this.memory = new HybridConversationMemory({
      sessionId: this.sessionId,
      maxMessageCount: 200,
      useMongoDb: this.useMongoDb
    });

    // Initialize token tracking
    this.tokenStats = {
      totalInput: 0,
      totalOutput: 0,
      totalHistory: 0, // Keep track of total history seen
      currentSession: 0
    };

    // Initialize pricing (Gemini 1.5 Flash)
    this.pricing = {
      input: {
        small: 0.000075, // $0.075 per 1M tokens for up to 128k tokens
        standard: 0.00015  // $0.15 per 1M tokens for over 128k tokens
      },
      output: {
        small: 0.0003,    // $0.30 per 1M tokens for up to 128k tokens
        standard: 0.0006   // $0.60 per 1M tokens for over 128k tokens
      },
      totalCost: 0
    };
  }

  // Private method to connect to MongoDB
  async _connectToMongoDB() {
    try {
      const mongoUri = process.env.MONGO_URI;

      if (!mongoUri) {
        console.warn('MONGO_URI not found in .env file. Running without MongoDB persistence.');
        this.useMongoDb = false;
        return false;
      }

      // Check if already connected
      if (mongoose.connection.readyState === 1) {
        console.log('Already connected to MongoDB');
        this.mongoConnected = true;
        return true;
      }

      console.log(`Connecting to MongoDB...`);

      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000
      });

      if (mongoose.connection.readyState === 1) {
        console.log('Connected to MongoDB successfully');
        this.mongoConnected = true;
        return true;
      } else {
        console.log(`MongoDB connection state: ${mongoose.connection.readyState} (Not connected)`);
        this.useMongoDb = false;
        return false;
      }
    } catch (error) {
      console.error('MongoDB connection error:', error.message);
      console.log('Continuing without MongoDB persistence.');
      this.useMongoDb = false;
      return false;
    }
  }

  // Method to close MongoDB connection
  async closeMongoConnection() {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      console.log('MongoDB connection closed');
      this.mongoConnected = false;
    }
  }

  // Method to wait for MongoDB connection to complete
  async waitForMongoConnection() {
    if (this.useMongoDb) {
      try {
        // If connection is already in progress, wait for it to complete
        if (!this.mongoConnected) {
          const connected = await this._connectToMongoDB();
          // Add a small delay to ensure all console messages are flushed
          await new Promise(resolve => setTimeout(resolve, 100));
          return connected;
        }
        return this.mongoConnected;
      } catch (error) {
        console.error('Error waiting for MongoDB connection:', error.message);
        this.useMongoDb = false;
        return false;
      }
    }
    return false;
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
    try {
      // Try to count tokens, but continue even if it fails
      const inputTokens = await this.getTokenCount(input);
      if (inputTokens) {
        this.tokenStats.totalInput += inputTokens;
        this.tokenStats.currentSession += inputTokens;
        console.log(`User input: ${inputTokens} tokens`);
      }
    } catch (error) {
      console.log("Token counting skipped for user input");
    }

    // Add user message to memory
    await this.memory.addMessage({ role: 'user', text: input }, input);

    // Get conversation history from memory
    const memoryContext = await this.memory.getRelevantContext(input);
    let relevantContextTokens = 0;

    // Try to count tokens in memory context if available
    if (memoryContext && memoryContext.length > 0) {
      try {
        relevantContextTokens = await this.getTokenCount(memoryContext);
        if (relevantContextTokens) {
          this.tokenStats.totalInput += relevantContextTokens; //  add to input
          this.tokenStats.totalHistory = relevantContextTokens; // Track for total history
          this.tokenStats.currentSession += relevantContextTokens;
          console.log(`Memory context: ${relevantContextTokens} tokens (included in input)`);
        }
      } catch (error) {
        // Continue even if token counting fails
        console.log("Token counting skipped for memory context");
      }
    } else {
      console.log("No relevant conversation context retrieved");
    }

    // Minimal system instruction
    const systemInstruction = "You are a helpful AI assistant.";

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
        console.log(`Including previous conversation context (${relevantContextTokens} tokens)`);
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
              fullResponse += chunk.text;
              yield chunk;
            }
          }

          // Count tokens in the response
          const responseTokens = await self.getTokenCount(fullResponse);
          if (responseTokens) {
            self.tokenStats.totalOutput += responseTokens;
            self.tokenStats.currentSession += responseTokens;
            console.log(`Assistant response: ${responseTokens} tokens`);
          }

          // Calculate costs
          const inputTokensInMillions = self.tokenStats.totalInput / 1000000;
          const outputTokensInMillions = self.tokenStats.totalOutput / 1000000;

          const inputCost = inputTokensInMillions *
            (self.tokenStats.totalInput <= 128000 ? self.pricing.input.small : self.pricing.input.standard);
          const outputCost = outputTokensInMillions *
            (self.tokenStats.totalOutput <= 128000 ? self.pricing.output.small : self.pricing.output.standard);
          const totalCost = inputCost + outputCost;
          self.pricing.totalCost = totalCost; // Store the calculated cost
          console.log(`Calculated totalCost: $${totalCost.toFixed(10)}`); // Add this line

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
      total: this.tokenStats.totalInput + this.tokenStats.totalOutput,
      cost: this.pricing.totalCost
    };
  }
}

async function runAgentStream(userInput, sessionId) {
  const agent = new Agent(sessionId);

  try {
    const responseStream = await agent.analyzeStream(userInput);
    for await (const chunk of responseStream) {
      process.stdout.write(chunk.text || "");
      // Remove this line to prevent duplicate message saving
      // if(chunk.text){
      //  await agent.memory.addMessage({role: 'agent', text: chunk.text});
      // }
    }
    console.log();
    const stats = agent.getTokenStats();
    console.log("Final stats:", stats);
    const formattedCost = stats.cost.toLocaleString('en-US', { 
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0, // Ensure at least 0 digits
      maximumFractionDigits: 20, // Allow up to 20 digits if needed
    });
    console.log("Final cost:", formattedCost);
  } catch (error) {
    console.error("Error in runAgentStream:", error);
  }
}

export { Agent, runAgentStream };
