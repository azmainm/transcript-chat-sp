const express = require('express');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const { z } = require('zod');
const { TranscriptRAG } = require('./langchain-rag');
const { OpenAIEmbeddings } = require('@langchain/openai');
const { MongoDBAtlasVectorSearch } = require('@langchain/mongodb');

const router = express.Router();

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = "standuptickets";
const TRANSCRIPTS_COLLECTION = "transcripts";
const CHAT_COLLECTION = "transcript-chat";
const EMBEDDINGS_COLLECTION = "transcript_embeddings";

// Initialize OpenAI and LangChain components
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small",
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

/**
 * Initialize Vector Store for retrieval
 */
async function getVectorStore() {
  const database = await getDatabase();
  
  return new MongoDBAtlasVectorSearch(embeddings, {
    collection: database.collection(EMBEDDINGS_COLLECTION),
    indexName: "vector_index", // Vector search index name in MongoDB Atlas
    textKey: "text",
    embeddingKey: "embedding",
  });
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
 * Search for all SP-XXX task references in transcripts
 */
async function searchAllTaskReferences(transcriptIds) {
  try {
    const database = await getDatabase();
    const embeddingsCollection = database.collection(EMBEDDINGS_COLLECTION);
    
    // Broad regex to catch all SP-XXX variations
    const taskPattern = /\b(?:sp|SP)[-\s]?\d+\b/;
    
    const taskQuery = {
      "transcriptId": { $in: transcriptIds },  // LangChain flattens metadata fields
      text: { $regex: taskPattern, $options: 'i' }
    };
    
    const taskDocs = await embeddingsCollection.find(taskQuery).limit(20).toArray();
    
    return taskDocs.map(doc => ({
      transcriptId: doc.transcriptId,  // LangChain flattens metadata fields
      meetingId: doc.meetingId,
      date: doc.date,
      content: doc.text,
      contentPreview: doc.text.substring(0, 500) + (doc.text.length > 500 ? '...' : ''),
      chunkIndex: doc.chunkIndex || 0,
      similarity: 0.95 // Very high similarity for task references
    }));
    
  } catch (error) {
    console.error('Error in task search:', error);
    return [];
  }
}

/**
 * Search for keyword matches in addition to vector similarity
 */
async function searchKeywordContent(query, transcriptIds) {
  try {
    const database = await getDatabase();
    const embeddingsCollection = database.collection(EMBEDDINGS_COLLECTION);
    
    // Check if query is asking about tasks (use synonyms)
    const isTaskQuery = /\b(task|tasks|sp[-\s]?\d+|ticket|tickets|item|items|work|todo|assignment)\b/i.test(query);
    
    let searchQueries = [];
    
    // If asking about tasks, search broadly for SP patterns and task-related terms
    if (isTaskQuery) {
      // Search for SP-XXX patterns
      searchQueries.push({
        "transcriptId": { $in: transcriptIds },  // LangChain flattens metadata fields
        text: { $regex: /\b(?:sp|SP)[-\s]?\d+\b/, $options: 'i' }
      });
      
      // Search for task-related keywords
      searchQueries.push({
        "transcriptId": { $in: transcriptIds },  // LangChain flattens metadata fields
        text: { $regex: /\b(task|ticket|item|assignment|todo|work|status|progress|update|complete|done|pending)\b/i }
      });
    }
    
    // Search for specific SP-XXX patterns mentioned in query
    const spMatches = query.match(/\b(?:sp|SP)[-\s]?\d+\b/g) || [];
    if (spMatches.length > 0) {
      searchQueries.push({
        "transcriptId": { $in: transcriptIds },  // LangChain flattens metadata fields
        text: { $regex: spMatches.join('|'), $options: 'i' }
      });
    }
    
    // General keyword search
    const searchTerms = query.toLowerCase().split(' ').filter(term => term.length > 2);
    if (searchTerms.length > 0) {
      searchQueries.push({
        "transcriptId": { $in: transcriptIds },  // LangChain flattens metadata fields
        text: { $regex: searchTerms.join('|'), $options: 'i' }
      });
    }
    
    if (searchQueries.length === 0) {
      return [];
    }
    
    // Execute all queries and combine results
    const allResults = [];
    for (const query of searchQueries) {
      const docs = await embeddingsCollection.find(query).limit(10).toArray();
      allResults.push(...docs);
    }
    
    // Remove duplicates and format
    const uniqueDocs = allResults.filter((doc, index, self) => 
      index === self.findIndex(d => d._id.toString() === doc._id.toString())
    );
    
    return uniqueDocs.slice(0, 15).map(doc => ({
      transcriptId: doc.transcriptId,  // LangChain flattens metadata fields
      meetingId: doc.meetingId,
      date: doc.date,
      content: doc.text,
      contentPreview: doc.text.substring(0, 500) + (doc.text.length > 500 ? '...' : ''),
      chunkIndex: doc.chunkIndex || 0,
      similarity: 0.9 // High similarity for keyword matches
    }));
    
  } catch (error) {
    console.error('Error in keyword search:', error);
    return [];
  }
}

/**
 * Search for similar content using vector store retriever
 */
async function searchSimilarContent(query, transcriptIds, maxResults = 5) {
  try {
    const vectorStore = await getVectorStore();
    const retriever = vectorStore.asRetriever({
      k: maxResults * 3, // Get more results to filter by transcript IDs
      searchType: "similarity",
      searchKwargs: {
        filter: {
          "metadata.transcriptId": { $in: transcriptIds }
        }
      }
    });
    
    // Use the retriever to find similar documents
    const docs = await retriever.getRelevantDocuments(query);
    
    // Filter by transcript IDs and format results
    const filteredDocs = docs
      .filter(doc => transcriptIds.includes(doc.metadata.transcriptId))
      .slice(0, maxResults);
    
    return filteredDocs.map(doc => ({
      transcriptId: doc.metadata.transcriptId,
      meetingId: doc.metadata.meetingId,
      date: doc.metadata.date,
      content: doc.pageContent,
      contentPreview: doc.pageContent.substring(0, 500) + (doc.pageContent.length > 500 ? '...' : ''),
      chunkIndex: doc.metadata.chunkIndex || 0,
      similarity: 0.8 // Placeholder - vector stores don't always return similarity scores
    }));
    
  } catch (error) {
    console.error('Error searching similar content:', error);
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
    
    // Check if this is a task-related query
    const isTaskQuery = /\b(task|tasks|sp[-\s]?\d+|ticket|tickets|item|items|work|todo|assignment)\b/i.test(message);
    
    // Check if this is a meeting-specific query (wanting separate analysis for each meeting)
    const isMeetingSpecificQuery = /\b(each meeting|each transcript|separate|individual|per meeting|meeting.*separate|summary.*each|each.*summary)\b/i.test(message);
    
    // Search for similar content using enhanced approach
    console.log('Searching for similar content using hybrid approach...');
    
    // Adjust search parameters based on query type
    const vectorResultsCount = isMeetingSpecificQuery ? 10 : 5; // Get more results for meeting-specific queries
    const maxFinalResults = isMeetingSpecificQuery ? 25 : 15; // Allow more results for comprehensive meeting analysis
    
    let searchPromises = [
      searchSimilarContent(message, transcriptIds, vectorResultsCount),
      searchKeywordContent(message, transcriptIds)
    ];
    
    // If asking about tasks, also search for all task references
    if (isTaskQuery) {
      console.log('Task-related query detected, searching for all SP-XXX references...');
      searchPromises.push(searchAllTaskReferences(transcriptIds));
    }
    
    // If asking for meeting-specific information, log for debugging
    if (isMeetingSpecificQuery) {
      console.log('Meeting-specific query detected, retrieving comprehensive results for each transcript...');
    }
    
    const searchResults = await Promise.all(searchPromises);
    const [vectorResults, keywordResults, taskResults = []] = searchResults;
    
    // Combine and deduplicate results, prioritizing task results for task queries
    const combinedResults = isTaskQuery 
      ? [...taskResults, ...keywordResults, ...vectorResults]
      : [...keywordResults, ...vectorResults];
      
    const uniqueResults = combinedResults.filter((result, index, self) => 
      index === self.findIndex(r => r.content === result.content)
    );
    
    const similarContent = uniqueResults.slice(0, maxFinalResults); // Take appropriate number of results based on query type
    
    // Generate AI response using LangChain RAG
    console.log('Generating AI response with LangChain...');
    const uniqueTranscripts = [...new Set(similarContent.map(item => item.transcriptId))];
    const uniqueMeetings = [...new Set(similarContent.map(item => item.meetingId))];
    
    console.log(`Using ${similarContent.length} content chunks from ${uniqueTranscripts.length} unique transcripts across ${uniqueMeetings.length} meetings`);
    
    if (isMeetingSpecificQuery) {
      console.log('Meeting-specific query - transcripts involved:', uniqueTranscripts);
      console.log('Meetings involved:', uniqueMeetings);
    }
    
    const aiResponse = await generateChatResponse(message, similarContent);
    
    // Handle structured response from new RAG system
    let responseText = '';
    let confidence = 'medium';
    let followUpQuestions = [];
    
    if (typeof aiResponse === 'object' && aiResponse.answer) {
      responseText = aiResponse.answer;
      confidence = aiResponse.confidence || 'medium';
      followUpQuestions = aiResponse.follow_up_questions || [];
    } else {
      responseText = typeof aiResponse === 'string' ? aiResponse : 'I apologize, but I encountered an issue processing your request.';
    }
    
    // Extract unique transcript information for better client-side understanding
    const uniqueTranscriptIds = [...new Set(similarContent.map(item => item.transcriptId))];
    const transcriptDetails = uniqueTranscriptIds.map(transcriptId => {
      const transcriptContent = similarContent.filter(item => item.transcriptId === transcriptId);
      return {
        transcriptId: transcriptId,
        meetingId: transcriptContent[0]?.meetingId,
        date: transcriptContent[0]?.date,
        chunksUsed: transcriptContent.length
      };
    });
    
    // Also maintain meeting-level grouping for backward compatibility
    const uniqueMeetingIds = [...new Set(similarContent.map(item => item.meetingId))];
    const meetingDetails = uniqueMeetingIds.map(meetingId => {
      const meetingContent = similarContent.filter(item => item.meetingId === meetingId);
      const transcriptsInMeeting = [...new Set(meetingContent.map(item => item.transcriptId))];
      return {
        meetingId: meetingId,
        date: meetingContent[0]?.date,
        transcriptCount: transcriptsInMeeting.length,
        chunksUsed: meetingContent.length
      };
    });

    res.json({
      success: true,
      response: responseText,
      confidence: confidence,
      followUpQuestions: followUpQuestions,
      sources: similarContent.map(item => ({
        transcriptId: item.transcriptId,
        meetingId: item.meetingId,
        date: item.date,
        similarity: item.similarity,
        preview: item.contentPreview,
        chunkIndex: item.chunkIndex
      })),
      transcriptAnalysis: {
        totalTranscripts: uniqueTranscriptIds.length,
        transcripts: transcriptDetails,
        isTranscriptSpecific: isMeetingSpecificQuery
      },
      meetingAnalysis: {
        totalMeetings: uniqueMeetingIds.length,
        meetings: meetingDetails,
        isMeetingSpecific: isMeetingSpecificQuery
      },
      contextUsed: similarContent.length > 0,
      chunksRetrieved: similarContent.length
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
