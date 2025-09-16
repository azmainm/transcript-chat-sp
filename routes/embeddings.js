const express = require('express');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const crypto = require('crypto');
const { OpenAIEmbeddings } = require('@langchain/openai');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const { MongoDBAtlasVectorSearch } = require('@langchain/mongodb');

const router = express.Router();

// In-memory lock to prevent concurrent embedding generation for same transcript
const generationLocks = new Set();

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = "standuptickets";
const TRANSCRIPTS_COLLECTION = "transcripts";
const EMBEDDINGS_COLLECTION = "transcript_embeddings";

// Initialize OpenAI and LangChain components
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small",
  apiKey: process.env.OPENAI_API_KEY,
});

const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 200,
});

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
 * Initialize Vector Store for MongoDB Atlas Vector Search
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

/**
 * Generate hash for transcript content to detect changes
 */
function generateContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Process and store transcript chunks in vector database
 */
async function processTranscriptToVectorStore(transcriptId, transcriptContent, meetingId, date) {
  try {
    const vectorStore = await getVectorStore();
    
    // Split text into chunks using LangChain
    const chunks = await textSplitter.splitText(transcriptContent);
    console.log(`Split transcript into ${chunks.length} chunks`);
    
    // Prepare documents for vector store
    const documents = chunks.map((chunk, index) => ({
      pageContent: chunk,
      metadata: {
        transcriptId: transcriptId,
        meetingId: meetingId,
        date: date,
        chunkIndex: index,
        chunkTotal: chunks.length,
        contentHash: generateContentHash(transcriptContent),
        createdAt: new Date().toISOString()
      }
    }));
    
    // Store in vector database
    await vectorStore.addDocuments(documents);
    
    console.log(`Stored ${documents.length} chunks in vector database for transcript ${transcriptId}`);
    return {
      chunksStored: documents.length,
      model: "text-embedding-3-small"
    };
    
  } catch (error) {
    console.error('Error processing transcript to vector store:', error);
    throw error;
  }
}

/**
 * Check if transcript already has embeddings in vector store
 */
async function checkExistingEmbeddings(transcriptId) {
  try {
    const database = await getDatabase();
    const embeddingsCollection = database.collection(EMBEDDINGS_COLLECTION);
    
    const existingEmbeddings = await embeddingsCollection.findOne({
      "transcriptId": transcriptId  // LangChain flattens metadata fields
    });
    
    const hasEmbeddings = !!existingEmbeddings;
    
    return hasEmbeddings;
  } catch (error) {
    console.error('Error checking existing embeddings:', error);
    return false;
  }
}

/**
 * Remove existing embeddings for a transcript
 */
async function removeExistingEmbeddings(transcriptId) {
  try {
    const database = await getDatabase();
    const embeddingsCollection = database.collection(EMBEDDINGS_COLLECTION);
    
    const result = await embeddingsCollection.deleteMany({
      "transcriptId": transcriptId  // LangChain flattens metadata fields
    });
    
    console.log(`Removed ${result.deletedCount} existing embeddings for transcript ${transcriptId}`);
  } catch (error) {
    console.error('Error removing existing embeddings:', error);
  }
}

/**
 * Check embeddings status for specific transcripts
 * GET /api/embeddings/status?ids=id1,id2,id3
 */
router.get('/status', async (req, res) => {
  try {
    const database = await getDatabase();
    const collection = database.collection(TRANSCRIPTS_COLLECTION);
    
    const { ids } = req.query;
    console.log('Embeddings status request:', { ids, query: req.query });
    
    if (!ids) {
      console.log('Missing IDs in request');
      return res.status(400).json({ error: 'Transcript IDs are required' });
    }
    
    const transcriptIds = ids.split(',');
    const { ObjectId } = require('mongodb');
    const objectIds = transcriptIds.map(id => {
      try {
        return new ObjectId(id);
      } catch {
        return id; // Fallback for string IDs
      }
    });
    
    const transcripts = await collection.find({
      _id: { $in: objectIds }
    }).toArray();
    
    // Check vector store for embeddings instead of transcript documents
    const embeddingStatus = await Promise.all(transcripts.map(async (transcript) => {
      // Ensure we're using the string version of the ObjectId for consistency
      const transcriptIdString = transcript._id.toString();
      const hasEmbedding = await checkExistingEmbeddings(transcriptIdString);
      
      return {
        _id: transcript._id,
        meeting_id: transcript.meeting_id,
        hasEmbedding,
        embeddingMetadata: hasEmbedding ? { model: "text-embedding-3-small", vectorStore: true } : null,
        contentLength: transcript.transcript_data ? transcript.transcript_data.length : 0
      };
    }));
    
    const allHaveEmbeddings = embeddingStatus.every(status => status.hasEmbedding);
    const totalCount = embeddingStatus.length;
    const embeddedCount = embeddingStatus.filter(status => status.hasEmbedding).length;
    
    res.json({
      status: allHaveEmbeddings ? 'ready' : 'partial',
      totalTranscripts: totalCount,
      embeddedTranscripts: embeddedCount,
      transcripts: embeddingStatus
    });
    
  } catch (error) {
    console.error('Error checking embedding status:', error);
    res.status(500).json({ error: 'Failed to check embedding status' });
  }
});

/**
 * Generate embeddings for specific transcripts
 * POST /api/embeddings/generate
 * Body: { transcriptIds: ['id1', 'id2'] }
 */
router.post('/generate', async (req, res) => {
  try {
    const database = await getDatabase();
    const collection = database.collection(TRANSCRIPTS_COLLECTION);
    
    const { transcriptIds } = req.body;
    if (!transcriptIds || !Array.isArray(transcriptIds)) {
      return res.status(400).json({ error: 'Transcript IDs array is required' });
    }
    
    const results = [];
    let processed = 0;
    let generated = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const transcriptId of transcriptIds) {
      try {
        processed++;
        
        // Check if this transcript is already being processed
        if (generationLocks.has(transcriptId)) {
          results.push({
            transcriptId,
            status: 'skipped',
            message: 'Embeddings already being generated for this transcript'
          });
          skipped++;
          continue;
        }
        
        // Add lock for this transcript
        generationLocks.add(transcriptId);
        
        // Find transcript by ID
        let transcript;
        const { ObjectId } = require('mongodb');
        try {
          transcript = await collection.findOne({ _id: new ObjectId(transcriptId) });
        } catch {
          transcript = await collection.findOne({ _id: transcriptId });
        }
        
        if (!transcript) {
          results.push({
            transcriptId,
            status: 'error',
            message: 'Transcript not found'
          });
          errors++;
          generationLocks.delete(transcriptId); // Remove lock
          continue;
        }
        
        // Check if embeddings already exist in vector store
        const hasExistingEmbeddings = await checkExistingEmbeddings(transcriptId);
        if (hasExistingEmbeddings) {
          results.push({
            transcriptId,
            status: 'skipped',
            message: 'Embeddings already exist in vector store'
          });
          skipped++;
          generationLocks.delete(transcriptId); // Remove lock
          continue;
        }
        
        // Clean up any partial embeddings before creating new ones
        await removeExistingEmbeddings(transcriptId);
        
        // Parse transcript data
        let transcriptContent;
        try {
          const transcriptData = JSON.parse(transcript.transcript_data);
          
          // Convert transcript entries to text
          transcriptContent = transcriptData.map(entry => {
            return `${entry.speaker}: ${entry.text}`;
          }).join('\n');
          
        } catch (parseError) {
          results.push({
            transcriptId,
            status: 'error',
            message: 'Failed to parse transcript data'
          });
          errors++;
          generationLocks.delete(transcriptId); // Remove lock
          continue;
        }
        
        if (!transcriptContent || transcriptContent.trim().length === 0) {
          results.push({
            transcriptId,
            status: 'error',
            message: 'No transcript content found'
          });
          errors++;
          generationLocks.delete(transcriptId); // Remove lock
          continue;
        }
        
        // Process transcript and store in vector database
        console.log(`Processing transcript ${transcriptId} to vector store...`);
        const result = await processTranscriptToVectorStore(
          transcriptId, 
          transcriptContent, 
          transcript.meeting_id, 
          transcript.date
        );
        
        // Update transcript with embedding metadata (backward compatibility)
        const embeddingMetadata = {
          model: 'text-embedding-3-small',
          generatedAt: new Date().toISOString(),
          contentHash: generateContentHash(transcriptContent),
          contentLength: transcriptContent.length,
          lastUpdated: new Date().toISOString(),
          vectorStore: true,
          chunksStored: result.chunksStored
        };
        
        await collection.updateOne(
          { _id: transcript._id },
          {
            $set: {
              embeddingMetadata: embeddingMetadata
            },
            $unset: {
              embeddings: "" // Remove old averaged embeddings
            }
          }
        );
        
        results.push({
          transcriptId,
          status: 'generated',
          message: 'Embeddings generated and stored in vector database',
          chunksStored: result.chunksStored,
          model: result.model,
          contentLength: transcriptContent.length
        });
        generated++;
        
        console.log(`✅ Generated embedding for transcript ${transcriptId}`);
        
        // Add small delay between transcript processing to avoid rate limits
        if (transcriptIds.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
      } catch (error) {
        console.error(`Error processing transcript ${transcriptId}:`, error);
        results.push({
          transcriptId,
          status: 'error',
          message: error.message
        });
        errors++;
      } finally {
        // Always remove lock when done processing this transcript
        generationLocks.delete(transcriptId);
      }
    }
    
    res.json({
      summary: {
        processed,
        generated,
        skipped,
        errors
      },
      results
    });
    
  } catch (error) {
    console.error('Error in embedding generation:', error);
    res.status(500).json({ error: 'Failed to generate embeddings' });
  }
});

module.exports = router;
