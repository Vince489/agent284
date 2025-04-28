import { GoogleGenAI } from "@google/genai";
import { config } from 'dotenv';
import { Memory } from './memory.js';
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

    // Model configuration with defaults
    this.modelConfig = {
      model: options.model || "gemini-1.5-flash",
      temperature: options.temperature !== undefined ? options.temperature : 0.7,
      topP: options.topP !== undefined ? options.topP : 0.95,
      topK: options.topK !== undefined ? options.topK : 40,
      maxOutputTokens: options.maxOutputTokens || 8192,
      systemInstruction: options.systemInstruction || "You are a pirate. Reply in pirate dialect.."
    };

    // Memory configuration
    this.memory = new Memory({
      sessionId: this.sessionId,
      maxMessageCount: options.maxMessageCount || 200,
      useMongoDb: this.useMongoDb
    });

    // Initialize token tracking
    this.tokenStats = {
      totalInput: 0,
      totalOutput: 0,
      currentSession: 0
    };

    // Initialize pricing based on model
    this.pricing = this._getPricingForModel(this.modelConfig.model);
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
      // Ensure text is a string
      const textToCount = typeof text === 'string' ? text : String(text);
      
      const result = await this.genAI.models.countTokens({
        model: "gemini-1.5-flash",
        contents: [{ 
          role: 'user', 
          parts: [{ text: textToCount }] 
        }]
      });
      return result.totalTokens;
    } catch (error) {
      console.error("Error counting tokens:", error);
      return null;
    }
  }
  async analyzeStream(input) {
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
        // Format the context for token counting if it's an array of messages
        let contextText = memoryContext;
        if (Array.isArray(memoryContext)) {
          contextText = memoryContext.map(msg => `${msg.role}: ${msg.text}`).join('\n');
        }
        
        relevantContextTokens = await this.getTokenCount(contextText);
        if (relevantContextTokens) {
          this.tokenStats.totalInput += relevantContextTokens;
          this.tokenStats.totalHistory = relevantContextTokens;
          this.tokenStats.currentSession += relevantContextTokens;
          console.log(`Memory context: ${relevantContextTokens} tokens (included in input)`);
        } else {
          console.log(`Memory context: token count unavailable`);
        }
      } catch (error) {
        console.log("Token counting skipped for memory context:", error.message);
      }
    } else {
      console.log("No relevant conversation context retrieved");
    }

    // Create chat options using the model configuration
    const chatOptions = {
      model: this.modelConfig.model,
      config: {
        temperature: this.modelConfig.temperature,
        topP: this.modelConfig.topP,
        topK: this.modelConfig.topK,
        maxOutputTokens: this.modelConfig.maxOutputTokens,
        systemInstruction: this.modelConfig.systemInstruction // Move this inside config
      }
    };

    // Build the chat history for the Gemini API
    const chatHistory = [];

    // Instead of adding context as a separate message, directly include previous messages
    if (memoryContext && memoryContext.length > 0) {
      console.log(`Including previous conversation context (${relevantContextTokens} tokens)`);
      
      // Get the actual message objects instead of a formatted string
      const previousMessages = this.memory.getAllMessages();
      
      // Add each message to the chat history with proper roles
      for (const msg of previousMessages) {
        // Skip the current user message as it will be added separately
        if (msg.role === 'user' && msg.text === input) continue;
        
        // Map memory roles to Gemini API roles
        const role = msg.role === 'assistant' ? 'model' : 'user';
        chatHistory.push({ 
          role: role, 
          parts: [{ text: msg.text }] 
        });
      }
      
      console.log(`Added ${chatHistory.length} previous messages to chat history`);
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

        // After collecting the full response, save it to memory
        await self.memory.addMessage({ role: 'assistant', text: fullResponse }, input);
        console.log(`Saved assistant response to memory (${fullResponse.length} chars)`);

        // Calculate costs
        const inputTokensInMillions = self.tokenStats.totalInput / 1000000;
        const outputTokensInMillions = self.tokenStats.totalOutput / 1000000;

        // Only calculate costs if we have valid token counts
        if (self.tokenStats.totalInput > 0 && self.tokenStats.totalOutput > 0) {
          const inputCost = inputTokensInMillions *
            (self.tokenStats.totalInput <= 128000 ? self.pricing.input.small : self.pricing.input.standard);
          const outputCost = outputTokensInMillions *
            (self.tokenStats.totalOutput <= 128000 ? self.pricing.output.small : self.pricing.output.standard);
          const totalCost = inputCost + outputCost;
          self.pricing.totalCost = totalCost; // Store the calculated cost
          console.log(`Calculated totalCost: $${totalCost.toFixed(10)}`);
        } else {
          console.log(`Cost calculation skipped due to missing token counts`);
        }
      }
    };

    return responseStream;
  } catch (error) {
    console.error("Error analyzing input (streaming):", error);
    throw error;
  }

  // Method to get current token statistics
  getTokenStats() {
    const formattedCost = this.pricing.totalCost.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 10,
      maximumFractionDigits: 10
    });
    
    return {
      ...this.tokenStats,
      total: this.tokenStats.totalInput + this.tokenStats.totalOutput,
      cost: this.pricing.totalCost,
      formattedCost: formattedCost
    };
  }

  // Helper method to get pricing based on model
  _getPricingForModel(model) {
    // Default to Gemini 1.5 Flash pricing
    const pricingMap = {
      "gemini-1.5-flash": {
        input: {
          small: 0.000075, // $0.075 per 1M tokens for up to 128k tokens
          standard: 0.00015  // $0.15 per 1M tokens for over 128k tokens
        },
        output: {
          small: 0.0003,    // $0.30 per 1M tokens for up to 128k tokens
          standard: 0.0006   // $0.60 per 1M tokens for over 128k tokens
        }
      },
      "gemini-1.5-pro": {
        input: {
          small: 0.00025,   // $0.25 per 1M tokens for up to 128k tokens
          standard: 0.0005   // $0.50 per 1M tokens for over 128k tokens
        },
        output: {
          small: 0.0025,    // $2.50 per 1M tokens for up to 128k tokens
          standard: 0.005    // $5.00 per 1M tokens for over 128k tokens
        }
      }
      // Add more models as needed
    };

    return {
      ...pricingMap[model] || pricingMap["gemini-1.5-flash"],
      totalCost: 0
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
