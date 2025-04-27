
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from 'dotenv';
config();

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Initialize the embedding model
const model = genAI.getGenerativeModel({ model: "embedding-001" });

// Export the model for use in other files
export { model };
