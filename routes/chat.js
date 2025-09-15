const express = require('express');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const { z } = require('zod');
const { TranscriptRAG } = require('./langchain-rag');

const router = express.Router();

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = "standuptickets";
const TRANSCRIPTS_COLLECTION = "transcripts";
const CHAT_COLLECTION = "transcript-chat";

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize LangChain RAG
const transcriptRAG = new TranscriptRAG();

let client = null;
let db = null;

async function getDatabase() {
  if (!db) {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DATABASE_NAME);
  }
  return db;
}

// Validation schemas using Zod
const ChatMessageSchema = z.object({
  message: z.string().min(1).max(4000),
  transcriptIds: z.array(z.string()).min(1),
  chatId: z.string().optional()
});

const ChatCloseSchema = z.object({
  chatId: z.string(),
  messages: z.array(z.object({
    id: z.string(),
    content: z.string(),
    role: z.enum(['user', 'assistant']),
    timestamp: z.string()
  })),
  transcriptIds: z.array(z.string())
});

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA, vecB) {
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Generate embedding for query
 */
async function generateQueryEmbedding(query) {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: query,
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating query embedding:', error);
    throw error;
  }
}

/**
 * Find similar content in transcripts using embeddings
 */
async function findSimilarContent(queryEmbedding, transcriptIds, similarityThreshold = 0.7, maxResults = 5) {
  try {
    const database = await getDatabase();
    const collection = database.collection(TRANSCRIPTS_COLLECTION);
    
    // Find transcripts with embeddings
    const { ObjectId } = require('mongodb');
    const objectIds = transcriptIds.map(id => {
      try {
        return new ObjectId(id);
      } catch {
        return id;
      }
    });
    
    const transcripts = await collection.find({
      _id: { $in: objectIds },
      embeddings: { $exists: true, $ne: null }
    }).toArray();
    
    const similarities = [];
    
    for (const transcript of transcripts) {
      if (!transcript.embeddings || !Array.isArray(transcript.embeddings)) continue;
      
      const similarity = cosineSimilarity(queryEmbedding, transcript.embeddings);
      
      if (similarity >= similarityThreshold) {
        // Parse transcript content
        let transcriptContent = '';
        try {
          const transcriptData = JSON.parse(transcript.transcript_data);
          transcriptContent = transcriptData.map(entry => `${entry.speaker}: ${entry.text}`).join('\n');
        } catch (error) {
          console.error('Error parsing transcript data:', error);
          continue;
        }
        
        similarities.push({
          transcriptId: transcript._id,
          meetingId: transcript.meeting_id,
          date: transcript.date,
          similarity,
          content: transcriptContent,
          contentPreview: transcriptContent.substring(0, 500) + (transcriptContent.length > 500 ? '...' : '')
        });
      }
    }
    
    // Sort by similarity (highest first) and limit results
    return similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, maxResults);
      
  } catch (error) {
    console.error('Error finding similar content:', error);
    throw error;
  }
}

/**
 * Generate response using LangChain RAG
 */
async function generateChatResponse(userMessage, similarContent, conversationHistory = []) {
  try {
    // Format context using LangChain RAG
    const context = transcriptRAG.formatContext(similarContent);
    
    // Generate response using LangChain
    const response = await transcriptRAG.generateResponse(userMessage, context, conversationHistory);
    
    return response;
  } catch (error) {
    console.error('Error generating chat response:', error);
    throw error;
  }
}

/**
 * Start or continue a chat session
 * POST /api/chat/message
 */
router.post('/message', async (req, res) => {
  try {
    // Validate request
    const validatedData = ChatMessageSchema.parse(req.body);
    const { message, transcriptIds, chatId } = validatedData;
    
    // Generate embedding for user query
    console.log('Generating embedding for user query...');
    const queryEmbedding = await generateQueryEmbedding(message);
    
    // Find similar content in transcripts
    console.log('Finding similar content in transcripts...');
    const similarContent = await findSimilarContent(queryEmbedding, transcriptIds, 0.6, 3);
    
    // Generate AI response using LangChain RAG
    console.log('Generating AI response with LangChain...');
    const aiResponse = await generateChatResponse(message, similarContent);
    
    res.json({
      success: true,
      response: aiResponse,
      sources: similarContent.map(item => ({
        meetingId: item.meetingId,
        date: item.date,
        similarity: item.similarity,
        preview: item.contentPreview
      })),
      contextUsed: similarContent.length > 0
    });
    
  } catch (error) {
    console.error('Error in chat message endpoint:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to process chat message',
      message: error.message
    });
  }
});

/**
 * Close chat session and save conversation
 * POST /api/chat/close
 */
router.post('/close', async (req, res) => {
  try {
    // Validate request
    const validatedData = ChatCloseSchema.parse(req.body);
    const { chatId, messages, transcriptIds } = validatedData;
    
    const database = await getDatabase();
    const chatCollection = database.collection(CHAT_COLLECTION);
    
    // Save conversation to database
    const conversation = {
      chatId,
      transcriptIds,
      messages: messages.map(msg => ({
        ...msg,
        timestamp: new Date(msg.timestamp)
      })),
      startedAt: messages.length > 0 ? new Date(messages[0].timestamp) : new Date(),
      endedAt: new Date(),
      messageCount: messages.length,
      createdAt: new Date()
    };
    
    const result = await chatCollection.insertOne(conversation);
    
    res.json({
      success: true,
      conversationId: result.insertedId,
      messagesSaved: messages.length
    });
    
  } catch (error) {
    console.error('Error closing chat session:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to close chat session',
      message: error.message
    });
  }
});

/**
 * Get chat history
 * GET /api/chat/history
 */
router.get('/history', async (req, res) => {
  try {
    const database = await getDatabase();
    const chatCollection = database.collection(CHAT_COLLECTION);
    
    const { limit = 10, skip = 0 } = req.query;
    
    const conversations = await chatCollection
      .find({})
      .sort({ createdAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();
    
    const formattedConversations = conversations.map(conv => ({
      _id: conv._id,
      chatId: conv.chatId,
      transcriptIds: conv.transcriptIds,
      messageCount: conv.messageCount,
      startedAt: conv.startedAt,
      endedAt: conv.endedAt,
      firstMessage: conv.messages && conv.messages.length > 0 ? conv.messages[0].content.substring(0, 100) + '...' : null
    }));
    
    res.json({
      success: true,
      conversations: formattedConversations,
      total: await chatCollection.countDocuments()
    });
    
  } catch (error) {
    console.error('Error getting chat history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get chat history'
    });
  }
});

module.exports = router;
