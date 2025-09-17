const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_NAME = "standuptickets";
const TRANSCRIPTS_COLLECTION = "transcripts";
const CHAT_COLLECTION = "transcript-chat";

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// MongoDB connection
let client = null;
let db = null;

async function initializeMongoDB() {
  try {
    if (!MONGODB_URI) {
      throw new Error("MONGODB_URI environment variable is not set");
    }

    if (!client) {
      client = new MongoClient(MONGODB_URI);
      await client.connect();
      db = client.db(DATABASE_NAME);
      console.log("✅ MongoDB connection established");
    }
  } catch (error) {
    console.error("❌ Failed to initialize MongoDB connection:", error.message);
    throw error;
  }
}

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000', 
    'http://localhost:3001', 
    'https://sherpaprompt-admin.vercel.app' // Allow production admin panel
  ],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    mongodb: !!db,
    openai: !!OPENAI_API_KEY
  });
});

// Test endpoint
app.get('/api/test', async (req, res) => {
  try {
    await initializeMongoDB();
    
    const transcriptsCollection = db.collection(TRANSCRIPTS_COLLECTION);
    const transcriptCount = await transcriptsCollection.countDocuments();
    
    res.json({
      message: 'Transcript Chat Server is running!',
      mongodb_connected: true,
      openai_configured: !!OPENAI_API_KEY,
      transcript_count: transcriptCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Server configuration error',
      details: error.message
    });
  }
});

// Import and use routes
const embeddingRoutes = require('./routes/embeddings');
const chatRoutes = require('./routes/chat');

app.use('/api/embeddings', embeddingRoutes);
app.use('/api/chat', chatRoutes);

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server Error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// Start server
async function startServer() {
  try {
    await initializeMongoDB();
    
    app.listen(PORT, () => {
      console.log(`🚀 Transcript Chat Server running on http://localhost:${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`🧪 Test endpoint: http://localhost:${PORT}/api/test`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...');
  if (client) {
    await client.close();
    console.log('✅ MongoDB connection closed');
  }
  process.exit(0);
});

startServer();

module.exports = { app, db };
