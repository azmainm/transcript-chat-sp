const express = require('express');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const crypto = require('crypto');

const router = express.Router();

// In-memory lock to prevent concurrent embedding generation for same transcript
const generationLocks = new Set();

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = "standuptickets";
const TRANSCRIPTS_COLLECTION = "transcripts";

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
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
 * Generate hash for transcript content to detect changes
 */
function generateContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Split text into chunks for embedding
 */
function chunkText(text, maxTokens = 4000) {
  const chunks = [];
  const words = text.split(' ');
  let currentChunk = '';
  
  for (const word of words) {
    const testChunk = currentChunk + (currentChunk ? ' ' : '') + word;
    // Rough token estimation: 1 token ≈ 4 characters
    if (testChunk.length > maxTokens * 4) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = word;
      } else {
        // Single word is too long, truncate it
        chunks.push(word.substring(0, maxTokens * 4));
      }
    } else {
      currentChunk = testChunk;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * Generate embeddings for transcript content (with chunking for large content)
 */
async function generateEmbedding(text) {
  try {
    // If text is small enough, generate single embedding
    if (text.length <= 4000 * 4) {
      const response = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: text,
      });
      
      return response.data[0].embedding;
    }
    
    // For large text, chunk it and average the embeddings
    const chunks = chunkText(text);
    const embeddings = [];
    
    console.log(`Text too large (${text.length} chars), splitting into ${chunks.length} chunks`);
    
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}...`);
      const response = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: chunks[i],
      });
      
      embeddings.push(response.data[0].embedding);
      
      // Small delay to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Average the embeddings
    const dimensions = embeddings[0].length;
    const avgEmbedding = new Array(dimensions).fill(0);
    
    for (const embedding of embeddings) {
      for (let i = 0; i < dimensions; i++) {
        avgEmbedding[i] += embedding[i];
      }
    }
    
    for (let i = 0; i < dimensions; i++) {
      avgEmbedding[i] /= embeddings.length;
    }
    
    console.log(`Generated averaged embedding from ${chunks.length} chunks`);
    return avgEmbedding;
    
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
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
    
    const embeddingStatus = transcripts.map(transcript => {
      const hasEmbedding = transcript.embeddings && Array.isArray(transcript.embeddings) && transcript.embeddings.length > 0;
      
      return {
        _id: transcript._id,
        meeting_id: transcript.meeting_id,
        hasEmbedding,
        embeddingMetadata: transcript.embeddingMetadata || null,
        contentLength: transcript.transcript_data ? transcript.transcript_data.length : 0
      };
    });
    
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
        
        // Check if embeddings already exist
        if (transcript.embeddings && Array.isArray(transcript.embeddings) && transcript.embeddings.length > 0) {
          results.push({
            transcriptId,
            status: 'skipped',
            message: 'Embeddings already exist'
          });
          skipped++;
          generationLocks.delete(transcriptId); // Remove lock
          continue;
        }
        
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
        
        // Generate embedding
        console.log(`Generating embedding for transcript ${transcriptId}...`);
        const embedding = await generateEmbedding(transcriptContent);
        
        // Create metadata
        const embeddingMetadata = {
          model: 'text-embedding-ada-002',
          generatedAt: new Date().toISOString(),
          contentHash: generateContentHash(transcriptContent),
          contentLength: transcriptContent.length,
          lastUpdated: new Date().toISOString()
        };
        
        // Update transcript with embedding
        await collection.updateOne(
          { _id: transcript._id },
          {
            $set: {
              embeddings: embedding,
              embeddingMetadata: embeddingMetadata
            }
          }
        );
        
        results.push({
          transcriptId,
          status: 'generated',
          message: 'Embedding generated successfully',
          embeddingDimensions: embedding.length,
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
