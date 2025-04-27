import mongoose from 'mongoose';
import { config } from 'dotenv';

// Load environment variables
config();

async function testMongoConnection() {
  console.log('MongoDB Connection Test');
  console.log('======================');
  
  // Get the MongoDB URI from .env
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  
  if (!mongoUri) {
    console.error('Error: No MongoDB URI found in .env file');
    console.error('Please add MONGODB_URI or MONGO_URI to your .env file');
    console.error('Example: MONGODB_URI=mongodb://localhost:27017/testdb');
    process.exit(1);
  }
  
  console.log(`Attempting to connect to: ${mongoUri}`);
  
  try {
    // Connect to MongoDB with timeout and detailed options
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000, // 5 seconds timeout
      connectTimeoutMS: 10000,        // 10 seconds connection timeout
      socketTimeoutMS: 45000,         // 45 seconds socket timeout
    });
    
    console.log('\n✅ Connection successful!');
    console.log('Connection details:');
    console.log(`- MongoDB version: ${mongoose.connection.client.topology.s.description.version || 'Unknown'}`);
    console.log(`- Database name: ${mongoose.connection.db.databaseName}`);
    console.log(`- Connection state: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Not connected'}`);
    
    // Create a simple test model and document
    const TestModel = mongoose.model('TestConnection', new mongoose.Schema({
      name: String,
      timestamp: { type: Date, default: Date.now }
    }));
    
    // Try to save a test document
    console.log('\nTesting write operation...');
    const testDoc = new TestModel({ name: 'Connection Test' });
    await testDoc.save();
    console.log('✅ Successfully wrote test document to database');
    
    // Try to read the document back
    console.log('\nTesting read operation...');
    const foundDoc = await TestModel.findOne({ name: 'Connection Test' });
    console.log(`✅ Successfully read test document: ${foundDoc.name}, created at ${foundDoc.timestamp}`);
    
    // Clean up - delete the test document
    console.log('\nCleaning up test document...');
    await TestModel.deleteOne({ _id: testDoc._id });
    console.log('✅ Test document deleted');
    
  } catch (error) {
    console.error('\n❌ Connection failed!');
    console.error('Error details:', error.message);
    
    // Provide troubleshooting guidance based on error
    console.log('\nTroubleshooting steps:');
    
    if (error.name === 'MongoServerSelectionError') {
      console.log('1. Make sure MongoDB server is running');
      console.log('2. Check if the MongoDB URI is correct');
      console.log('3. If using localhost, try using 127.0.0.1 instead');
      console.log('4. Verify network connectivity to the MongoDB server');
      console.log('5. Check if MongoDB server is listening on the specified port');
    } else if (error.name === 'MongoParseError') {
      console.log('1. The MongoDB connection string format is invalid');
      console.log('2. Correct format: mongodb://[username:password@]host[:port]/database');
      console.log('3. Example: mongodb://localhost:27017/testdb');
    } else if (error.name === 'MongooseServerSelectionError') {
      console.log('1. MongoDB server might be running but not accepting connections');
      console.log('2. Check MongoDB logs for any errors');
      console.log('3. Verify MongoDB authentication settings if using auth');
    } else {
      console.log('1. Check your MongoDB installation');
      console.log('2. Verify network settings and firewall rules');
      console.log('3. Check MongoDB server logs for errors');
    }
  } finally {
    // Close the connection if it was established
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      console.log('\nMongoDB connection closed');
    }
    
    console.log('\nTest completed');
  }
}

// Run the test
testMongoConnection();