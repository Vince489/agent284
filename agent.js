import { GoogleGenAI } from "@google/genai";
import { config } from 'dotenv';
import { HybridConversationMemory } from './memory.js';

config();

class Agent {
  constructor(sessionId) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY environment variable not set.");
    }
    this.genAI = new GoogleGenAI({ apiKey });
    this.sessionId = sessionId || `session_${Date.now()}`;
    this.memory = new HybridConversationMemory({ 
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
    
    // Initialize pricing
    this.pricing = {
      input: {
        small: 0.000001, // $0.000001 per token for up to 128,000 tokens
        standard: 0.000002 // $0.000002 per token for over 128,000 tokens
      },
      output: {
        small: 0.000001, // $0.000001 per token for up to 128,000 tokens
        standard: 0.000002 // $0.000002 per token for over 128,000 tokens
      },
      totalCost: 0
    };
  }

  async getTokenCount(text) {
    try {
      // Use the correct method for token counting in @google/genai
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
      console.log("Token counting skipped");
    }
    
    // Add user message to memory
    await this.memory.addMessage({ role: 'user', text: input }, input);
    
    // Get conversation history from memory
    const memoryContext = await this.memory.getRelevantContext(input);
    
    // Try to count tokens in memory context if available
    if (memoryContext && memoryContext.length > 0) {
      try {
        const contextTokens = await this.getTokenCount(memoryContext);
        if (contextTokens) {
          this.tokenStats.totalHistory = contextTokens;
          console.log(`Memory context: ${contextTokens} tokens`);
        }
      } catch (error) {
        // Continue even if token counting fails
      }
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
        console.log(`Including previous conversation context (${this.tokenStats.totalHistory} tokens)`);
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
          
          // After collecting the full response, save it to memory
          await self.memory.addMessage({ role: 'assistant', text: fullResponse }, input);
          console.log(`\n--- Session Summary ---`);
          console.log(`Tokens Used:`);
          console.log(`  • Input:    ${self.tokenStats.totalInput.toString().padStart(6)} tokens`);
          console.log(`  • Output:   ${self.tokenStats.totalOutput.toString().padStart(6)} tokens`);
          console.log(`  • Context:  ${self.tokenStats.totalHistory.toString().padStart(6)} tokens`);
          console.log(`  • Session:  ${self.tokenStats.currentSession.toString().padStart(6)} tokens total`);

          // Calculate costs
          const inputCost = (self.tokenStats.totalInput / 1000000) * (self.tokenStats.totalInput <= 128000 ? self.pricing.input.small : self.pricing.input.standard) * 1000000;
          const outputCost = (self.tokenStats.totalOutput / 1000000) * (self.tokenStats.totalOutput <= 128000 ? self.pricing.output.small : self.pricing.output.standard) * 1000000;
          const contextCost = (self.tokenStats.totalHistory / 1000000) * (self.tokenStats.totalHistory <= 128000 ? self.pricing.input.small : self.pricing.input.standard) * 1000000;
          const totalCost = inputCost + outputCost + contextCost;
          self.pricing.totalCost = totalCost;

          // Display costs in a more readable format
          console.log(`\nCost Breakdown:`);
          console.log(`  • Input:    $${inputCost.toFixed(6)}`);
          console.log(`  • Output:   $${outputCost.toFixed(6)}`);
          console.log(`  • Context:  $${contextCost.toFixed(6)}`);
          console.log(`  • Total:    $${totalCost.toFixed(6)}`);
          console.log(`-------------------\n`);
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
      // Remove this line to prevent duplicate message saving
      // if(chunk.text){
      //    await agent.memory.addMessage({role: 'agent', text: chunk.text});
      // }
    }
    console.log();
  } catch (error) {
    console.error("Error in runAgentStream:", error);
  }
}

export { Agent, runAgentStream };
