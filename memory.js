/**
 * Memory Service
 *
 * Provides a hybrid conversation memory system that combines:
 * - In-memory storage for recent messages
 * - MongoDB persistence for long-term storage
 * - Relevance-based pruning to maintain context
 * - Optional embedding-based similarity for better context retrieval
 * - Batch processing for efficient database operations
 */

import mongoose from 'mongoose';
import Conversation from './models/conversation.js';
import { model as embeddingModel } from './embed.js';

/**
 * Memory class for managing conversation history
 * with intelligent pruning and context retrieval
 * and MongoDB persistence with batch processing
 */
export class Memory {
    /**
     * Create a new Memory instance
     * @param {Object} options - Configuration options
     * @param {number} options.maxSizeBytes - Maximum memory size in bytes (default: 5MB)
     * @param {number} options.maxMessageCount - Maximum number of messages to store (default: 20)
     * @param {Object} options.embeddingModel - Optional embedding model for semantic similarity
     * @param {string} options.sessionId - Session ID for MongoDB persistence (default: 'default-session')
     * @param {number} options.batchSaveDelay - Milliseconds to wait before executing batch save (default: 2000)
     * @param {number} options.maxBatchSize - Maximum number of operations to queue before forcing a save (default: 10)
     */
    constructor(options = {}) {
        this.maxSizeBytes = options.maxSizeBytes || 1 * 1024 * 1024; // 1MB default
        this.maxMessageCount = options.maxMessageCount || 300; // Limit total messages
        this.messages = [];
        this.embeddingModel = options.embeddingModel || embeddingModel; // Use imported model as default
        this.sessionId = options.sessionId || 'default-session';
        this.useMongoDb = options.useMongoDb !== undefined ? options.useMongoDb : false;

        // Batch processing properties
        this.pendingOperations = [];
        this.batchSaveTimeout = null;
        this.batchSaveDelay = options.batchSaveDelay || 2000; // ms between batch saves
        this.maxBatchSize = options.maxBatchSize || 10; // max operations per batch
        this.isSaving = false; // Lock to prevent concurrent saves

        // Check MongoDB connection status if MongoDB is enabled
        this.isMongoConnected = this.useMongoDb ? mongoose.connection.readyState === 1 : false;
        
        if (this.useMongoDb) {
            if (this.debug) {
                console.log(`Memory constructor - MongoDB connection status: ${this.isMongoConnected ? 'Connected' : 'Not connected'}`);
                console.log(`MongoDB readyState: ${mongoose.connection.readyState}`);
            } else {
                // Only log minimal connection info
                console.log(`MongoDB ${this.isMongoConnected ? 'connected' : 'not connected'}`);
            }

            // Load conversation history from MongoDB if connected
            if (this.isMongoConnected) {
                this._loadFromMongoDB();
            }
        }
    }

    /**
     * Load conversation history from MongoDB
     * @private
     */
    async _loadFromMongoDB() {
        try {
            const conversation = await Conversation.findOne({ sessionId: this.sessionId });
            if (conversation) {
                if (Array.isArray(conversation.messages)) {
                    // Convert MongoDB documents to plain objects and update timestamps
                    this.messages = conversation.messages.map(msg => ({
                        role: msg.role,
                        text: msg.text,
                        timestamp: msg.timestamp.getTime()
                    }));
                    console.log(`Loaded ${this.messages.length} messages from MongoDB for session ${this.sessionId}`);
                } else {
                    console.warn(`Invalid 'messages' field in MongoDB document for session ${this.sessionId}. Expected an array.`);
                    // Initialize with empty array for safety
                    this.messages = [];
                }
            }
        } catch (error) {
            console.error('Error loading conversation from MongoDB:', error);
            // Continue with empty messages array if there's an error
        }
    }

    /**
     * Queue an operation for batch processing
     * @param {string} operationType - Type of operation ('add', 'prune', etc.)
     * @param {Object} payload - Additional data for the operation
     * @private
     */
    async _queueOperation(operationType, payload = {}) {
        if (!this.isMongoConnected) {
            if (this.debug) console.log(`MongoDB not connected, skipping ${operationType} operation queue`);
            return;
        }

        // Add operation to queue
        this.pendingOperations.push({
            type: operationType,
            payload,
            timestamp: Date.now()
        });

        if (this.debug) console.log(`Queued ${operationType} operation. Queue size: ${this.pendingOperations.length}`);

        // Schedule batch processing
        await this._scheduleBatchProcessing();
    }

    /**
     * Schedule batch processing with debounce
     * @private
     */
    async _scheduleBatchProcessing() {
        // Clear any existing timeout
        if (this.batchSaveTimeout) {
            clearTimeout(this.batchSaveTimeout);
        }

        // If we've reached max batch size, process immediately
        if (this.pendingOperations.length >= this.maxBatchSize) {
            await this._processBatch();
            return;
        }

        // Otherwise, set a timeout to process soon
        this.batchSaveTimeout = setTimeout(async () => {
            await this._processBatch();
        }, this.batchSaveDelay);
    }

    /**
     * Process queued operations in a batch
     * @private
     */
    async _processBatch() {
        if (this.isSaving || this.pendingOperations.length === 0) {
            return;
        }
        
        this.isSaving = true;
        
        try {
            const operationsToProcess = [...this.pendingOperations];
            this.pendingOperations = [];
            
            if (this.debug) {
                console.log(`Processing batch of ${operationsToProcess.length} operations`);
            }
            
            // Process all operations
            await this._saveToMongoDB();
            
            if (this.debug) {
                console.log(`Successfully processed ${operationsToProcess.length} operations`);
            }
        } catch (error) {
            console.error('Error processing batch operations:', error);
            // Re-queue failed operations
            this.pendingOperations = [...this.pendingOperations];
        } finally {
            this.isSaving = false;
        }
    }

    /**
     * Save conversation to MongoDB with retry logic
     * @private
     * @param {number} retryCount - Current retry attempt (default: 0)
     * @param {number} maxRetries - Maximum number of retries (default: 3)
     * @param {number} baseDelay - Base delay for exponential backoff in ms (default: 300)
     */
    async _saveToMongoDB(retryCount = 0, maxRetries = 3, baseDelay = 300) {
        if (!this.isMongoConnected) {
            if (this.debug) console.log('MongoDB not connected, skipping save');
            return;
        }

        try {
            if (this.debug) console.log(`Attempting to save ${this.messages.length} messages to MongoDB for session ${this.sessionId}`);

            // Find or create conversation document
            const result = await Conversation.findOneAndUpdate(
                { sessionId: this.sessionId },
                {
                    messages: this.messages,
                    lastUpdated: new Date()
                },
                { upsert: true, new: true, lean: true } // Using lean for better performance
            );

            if (this.debug) {
                console.log(`Successfully saved ${this.messages.length} messages to MongoDB for session ${this.sessionId}`);
                console.log(`MongoDB document ID: ${result._id}`);
            }
        } catch (error) {
            console.error(`Error saving conversation to MongoDB (attempt ${retryCount + 1}/${maxRetries + 1}):`, error);
            
            // Implement exponential backoff retry logic
            if (retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                if (this.debug) console.log(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this._saveToMongoDB(retryCount + 1, maxRetries, baseDelay);
            } else {
                console.error(`Failed to save conversation after ${maxRetries + 1} attempts`);
            }
        }
    }

    /**
     * Estimate the size of a message in bytes more accurately
     * @param {Object} message - The message to estimate
     * @returns {number} - Estimated size in bytes
     * @private
     */
    _estimateMessageSize(message) {
        // More accurate byte size calculation for strings with Unicode support
        const stringToBytes = (str) => {
            return new TextEncoder().encode(str).length;
        };
        
        // Convert the message to a string and calculate its byte size
        return stringToBytes(JSON.stringify(message));
    }

    /**
     * Calculate relevance score between a message and current context
     * @param {Object} message - The message to evaluate
     * @param {string} currentContext - The current context to compare against
     * @returns {Promise<number>} - Relevance score (0-1)
     * @private
     */
    async _calculateRelevanceScore(message, currentContext) {
        try {
            if (!this.embeddingModel) {
                const textScore = this._basicTextSimilarity(message.text, currentContext);
                return textScore;
            }

            // If embedding model is available, use it for better similarity
            const messageEmbedding = await this.embeddingModel.embedContent(message.text);
            const contextEmbedding = await this.embeddingModel.embedContent(currentContext);

            return this._cosineSimilarity(
                messageEmbedding.embedding.values,
                contextEmbedding.embedding.values
            );
        } catch (error) {
            console.warn('Relevance calculation error:', error);
            return 0;
        }
    }

    /**
     * Calculate basic text similarity using word overlap
     * @param {string} text1 - First text
     * @param {string} text2 - Second text
     * @returns {number} - Similarity score (0-1)
     * @private
     */
    _basicTextSimilarity(text1, text2) {
        const words1 = new Set(text1.toLowerCase().split(/\W+/));
        const words2 = new Set(text2.toLowerCase().split(/\W+/));

        const intersection = [...words1].filter(word => words2.has(word));
        return intersection.length / Math.sqrt(words1.size * words2.size);
    }

    /**
     * Calculate cosine similarity between two vectors
     * @param {Array<number>} vec1 - First vector
     * @param {Array<number>} vec2 - Second vector
     * @returns {number} - Similarity score (0-1)
     * @private
     */
    _cosineSimilarity(vec1, vec2) {
        if (vec1.length !== vec2.length) return 0;

        let dotProduct = 0;
        let mag1 = 0;
        let mag2 = 0;

        for (let i = 0; i < vec1.length; i++) {
            dotProduct += vec1[i] * vec2[i];
            mag1 += vec1[i] * vec1[i];
            mag2 += vec2[i] * vec2[i];
        }

        return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
    }

    /**
     * Prune the conversation history based on relevance to current context
     * @param {string} currentContext - The current context
     * @returns {Promise<void>}
     */
    async prune(currentContext) {
        if (this.messages.length <= this.maxMessageCount) return;

        // Calculate relevance scores for all messages
        const scoredMessages = await Promise.all(
            this.messages.map(async (message, index) => ({
                index,
                message,
                score: await this._calculateRelevanceScore(message, currentContext)
            }))
        );

        // Sort by relevance (least relevant first)
        const sortedByLeastRelevant = scoredMessages
            .sort((a, b) => a.score - b.score);

        // Determine how many messages to remove
        const messagesToRemoveCount = this.messages.length - this.maxMessageCount;
        
        // Get the indices of messages to remove (least relevant ones)
        const messagesToRemove = sortedByLeastRelevant
            .slice(0, messagesToRemoveCount)
            .map(item => item.index);

        // Create a new array with only the messages we want to keep
        // This is more efficient than using splice multiple times
        const newMessages = [];
        for (let i = 0; i < this.messages.length; i++) {
            if (!messagesToRemove.includes(i)) {
                newMessages.push(this.messages[i]);
            }
        }
        
        this.messages = newMessages;
        console.log(`Pruned ${messagesToRemoveCount} messages, keeping ${this.messages.length} most relevant messages`);

        // Queue prune operation for batch saving instead of immediate save
        await this._queueOperation('prune', { removedCount: messagesToRemoveCount });
    }

    /**
     * Check if MongoDB is connected and update the connection status
     * This should be called before any operation that requires MongoDB
     * @param {number} timeoutMs - Maximum time to wait for connection in ms
     * @returns {Promise<boolean>} - Whether MongoDB is connected
     */
    async checkMongoConnection(timeoutMs = 5000) {
        // Wait for MongoDB connection to be established
        if (mongoose.connection.readyState === 0) {
            if (this.debug) console.log('MongoDB connection not yet established, waiting...');
            // Create a promise that resolves when connection is established or rejects after timeout
            try {
                await Promise.race([
                    // Promise that resolves when connection is established
                    new Promise(resolve => {
                        const checkInterval = setInterval(() => {
                            if (mongoose.connection.readyState === 1) {
                                clearInterval(checkInterval);
                                resolve(true);
                            }
                        }, 100);
                    }),
                    // Promise that rejects after timeout
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('MongoDB connection timeout')), timeoutMs)
                    )
                ]);
            } catch (error) {
                console.warn('MongoDB connection failed:', error.message);
                this._updateMongoConnectionStatus();
                return false;
            }
        }

        // Update the connection status
        this._updateMongoConnectionStatus();
        if (this.debug) console.log(`MongoDB connection check: ${this.isMongoConnected ? 'Connected' : 'Not connected'}`);
        return this.isMongoConnected;
    }

    /**
     * Add a message to the conversation history
     * @param {Object} message - The message to add
     * @param {string} currentContext - The current context
     * @returns {Promise<void>}
     */
    async addMessage(message, currentContext) {
        // Log message with a more sophisticated approach
        const previewLength = 100; 
        const textPreview = message.text.length > previewLength 
            ? `${message.text.substring(0, previewLength)}... (${message.text.length} chars total)`
            : message.text;
        
        if (this.debug) {
            console.log(`Adding message to memory: ${message.role}: ${textPreview}`);
            console.log(`Current session ID: ${this.sessionId}`);
        }

        // Check MongoDB connection before trying to save
        await this.checkMongoConnection();
        if (this.debug) console.log(`MongoDB connected: ${this.isMongoConnected}`);

        // Add timestamp if not already present
        if (!message.timestamp) {
            message.timestamp = Date.now();
        }

        const messageSize = this._estimateMessageSize(message);

        if (this.messages.reduce((sum, m) => sum + this._estimateMessageSize(m), 0) + messageSize > this.maxSizeBytes) {
            await this.prune(currentContext);
        }

        this.messages.push({
            ...message
        });

        if (this.debug) console.log(`Current memory size: ${this.messages.length} messages`);

        // Queue message add operation for batch saving
        if (this.isMongoConnected) {
            await this._queueOperation('add', { messageId: message.timestamp });
            // Force save to ensure messages are persisted immediately
            await this._processBatch();
        }
    }

    /**
     * Get relevant context from conversation history
     * @param {string} currentQuery - The current query
     * @param {number} maxContextSize - Maximum context size in bytes
     * @returns {Promise<Array>} - Array of relevant message objects
     */
    async getRelevantContext(currentQuery, maxContextSize = 1024 * 1024) {
        if (this.messages.length === 0) return [];

        const scoredMessages = await Promise.all(
            this.messages.map(async (message) => ({
                message,
                score: await this._calculateRelevanceScore(message, currentQuery)
            }))
        );

        // Sort by relevance (most relevant first)
        const sortedMessages = scoredMessages
            .sort((a, b) => b.score - a.score)
            .map(item => item.message);

        // Use byte-accurate size calculation
        const stringToBytes = (str) => new TextEncoder().encode(str).length;
        
        let contextSize = 0;
        const contextMessages = [];

        for (let msg of sortedMessages) {
            const msgText = `${msg.role}: ${msg.text}`;
            const msgSize = stringToBytes(msgText + '\n');
            
            if (contextSize + msgSize <= maxContextSize) {
                contextMessages.push(msg);
                contextSize += msgSize;
            } else {
                break;
            }
        }

        return contextMessages;
    }

    /**
     * Get all messages in the conversation history
     * @returns {Array} - All messages
     */
    getAllMessages() {
        return this.messages;
    }

    /**
     * Update MongoDB connection status
     * @private
     * @returns {boolean} - Current connection status
     */
    _updateMongoConnectionStatus() {
        const newConnectionStatus = mongoose.connection.readyState === 1;
        
        // Update connection status without logging the change
        this.isMongoConnected = newConnectionStatus;

        return this.isMongoConnected;
    }

    /**
     * Set the session ID and reload conversation history
     * @param {string} sessionId - The new session ID
     */
    async setSessionId(sessionId) {
        if (this.sessionId === sessionId) return;

        // Flush any pending operations for the current session
        await this.flushPendingOperations();

        console.log(`Set conversation memory session ID to: ${sessionId}`);
        this.sessionId = sessionId;
        this.messages = [];

        // Check MongoDB connection before trying to load
        await this.checkMongoConnection();

        if (this.isMongoConnected) {
            await this._loadFromMongoDB();
        }
    }

    /**
     * Flush all pending operations immediately
     * This is useful before application shutdown or session changes
     * @returns {Promise<void>}
     */
    async flushPendingOperations() {
        if (this.batchSaveTimeout) {
            clearTimeout(this.batchSaveTimeout);
            this.batchSaveTimeout = null;
        }
        
        if (this.pendingOperations.length > 0) {
            console.log(`Flushing ${this.pendingOperations.length} pending operations`);
            await this._processBatch();
        }
    }
}

export default Memory;
