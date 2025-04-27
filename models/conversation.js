import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    required: true,
    enum: ['user', 'assistant', 'system']
  },
  text: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const conversationSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    index: true
  },
  messages: [messageSchema],
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

// Create indexes for faster queries
conversationSchema.index({ lastUpdated: -1 });

const Conversation = mongoose.model('Conversation', conversationSchema);

export default Conversation;