# Transcript Chat Backend Server

A modern RAG-based backend server for intelligent conversation with meeting transcripts using AI. Built with LangChain, MongoDB Atlas Vector Search, and OpenAI's latest embedding models.

## Features

- **🚀 Advanced Embedding Model**: `text-embedding-3-small` for 50% lower cost and better quality
- **🧩 Smart Text Chunking**: LangChain `RecursiveCharacterTextSplitter` for optimal content segmentation
- **🔍 Vector Database**: MongoDB Atlas Vector Search for lightning-fast similarity search
- **💬 Structured RAG**: `ChatPromptTemplate` with system/user roles for contextual responses
- **📊 Intelligent Output**: JSON responses with confidence levels and follow-up suggestions
- **🎯 Enhanced Task Recognition**: Automatically identifies and tracks SP-XXX task references
- **💾 Persistent Storage**: Embeddings cached permanently, conversations saved to MongoDB
- **⚡ Real-time API**: RESTful endpoints with comprehensive error handling
- **📈 Performance Optimized**: No duplicate embedding generation, intelligent caching

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Setup

Create your environment file:

```bash
cp env.example .env
```

Configure your variables in `.env`:

```env
MONGODB_URI=mongodb://localhost:27017/standuptickets
OPENAI_API_KEY=your-openai-api-key-here
PORT=3001
```

### 3. MongoDB Atlas Vector Search Setup

**IMPORTANT**: This system requires MongoDB Atlas Vector Search for optimal performance.

Create a vector search index on your `transcript_embeddings` collection with this configuration:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding", 
      "numDimensions": 1536,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "transcriptId"
    },
    {
      "type": "filter", 
      "path": "meetingId"
    },
    {
      "type": "filter",
      "path": "date"
    }
  ]
}
```

### 4. Start the Server

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

Server starts on `http://localhost:3001`

### 5. Verify Installation

```bash
# Health check
curl http://localhost:3001/health

# System status
curl http://localhost:3001/api/test
```

## API Reference

### Health Endpoints

#### GET /health
Basic server health check
```json
{
  "status": "ok", 
  "timestamp": "2025-09-16T...",
  "mongodb": true,
  "openai": true
}
```

#### GET /api/test
Detailed system status
```json
{
  "message": "Transcript Chat Server is running!",
  "mongodb_connected": true,
  "openai_configured": true, 
  "transcript_count": 112,
  "timestamp": "2025-09-16T..."
}
```

### Embeddings API

#### GET /api/embeddings/status
Check embedding status for transcripts
```bash
curl "http://localhost:3001/api/embeddings/status?ids=transcript_id_1,transcript_id_2"
```

**Response:**
```json
{
  "status": "ready",
  "totalTranscripts": 2,
  "embeddedTranscripts": 2,
  "transcripts": [
    {
      "_id": "68c856251732a35bb5bf96c3",
      "meeting_id": "teams-meeting-123",
      "hasEmbedding": true,
      "embeddingMetadata": {
        "model": "text-embedding-3-small",
        "vectorStore": true
      },
      "contentLength": 60236
    }
  ]
}
```

#### POST /api/embeddings/generate
Generate embeddings for specific transcripts
```bash
curl -X POST http://localhost:3001/api/embeddings/generate \
  -H "Content-Type: application/json" \
  -d '{"transcriptIds": ["68c856251732a35bb5bf96c3"]}'
```

**Response:**
```json
{
  "summary": {
    "processed": 1,
    "generated": 1, 
    "skipped": 0,
    "errors": 0
  },
  "results": [
    {
      "transcriptId": "68c856251732a35bb5bf96c3",
      "status": "generated",
      "message": "Embeddings generated and stored in vector database",
      "chunksStored": 54,
      "model": "text-embedding-3-small"
    }
  ]
}
```

### Chat API

#### POST /api/chat/message
Send message and get AI response with task-aware processing
```bash
curl -X POST http://localhost:3001/api/chat/message \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What tasks were discussed in the meeting?",
    "transcriptIds": ["68c856251732a35bb5bf96c3"]
  }'
```

**Response:**
```json
{
  "success": true,
  "response": "Based on the transcript, several tasks were discussed including SP-1234 regarding project timeline and SP-1235 for code review...",
  "confidence": "high",
  "followUpQuestions": [
    "What are the deadlines for these tasks?",
    "Who is assigned to SP-1234?"
  ],
  "sources": [
    {
      "meetingId": "teams-meeting-123",
      "date": "2025-09-15",
      "preview": "Discussion about SP-1234 project timeline..."
    }
  ],
  "contextUsed": true,
  "chunksRetrieved": 15
}
```

#### POST /api/chat/close
Save and close chat session
```bash
curl -X POST http://localhost:3001/api/chat/close \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "chat-session-123",
    "transcriptIds": ["68c856251732a35bb5bf96c3"],
    "messages": [...]
  }'
```

## Database Schema

### Vector Embeddings Collection: `transcript_embeddings`
```javascript
{
  _id: ObjectId,
  text: "Discussion content chunk...", 
  embedding: [0.123, -0.456, ...], // 1536-dimensional vector
  transcriptId: "68c856251732a35bb5bf96c3", // Flattened by LangChain
  meetingId: "teams-meeting-123",
  date: "2025-09-15", 
  chunkIndex: 0,
  chunkTotal: 54,
  contentHash: "61ad635d63203564",
  createdAt: "2025-09-16T07:22:43.761Z"
}
```

### Enhanced Transcripts Collection
```javascript
{
  _id: ObjectId,
  date: "2025-09-15",
  meeting_id: "teams-meeting-123", 
  transcript_data: "JSON string of transcript entries",
  entry_count: 150,
  timestamp: Date,
  
  // Added embedding metadata
  embeddingMetadata: {
    model: "text-embedding-3-small",
    generatedAt: "2025-09-16T07:22:43.761Z",
    vectorStore: true,
    chunksStored: 54
  }
}
```

### Chat Sessions Collection: `transcript-chat`
```javascript
{
  _id: ObjectId,
  chatId: "chat-session-123",
  transcriptIds: ["68c856251732a35bb5bf96c3"],
  messages: [
    {
      id: "msg-1",
      content: "What tasks were mentioned?",
      role: "user",
      timestamp: Date
    },
    {
      id: "msg-2", 
      content: "Several SP-XXX tasks were discussed...",
      role: "assistant",
      timestamp: Date,
      confidence: "high",
      sources: [...]
    }
  ],
  startedAt: Date,
  endedAt: Date,
  messageCount: 4
}
```

## Advanced Features

### Task Recognition System
The system intelligently recognizes task references:
- **SP-XXX patterns**: Automatically detects SP-1234, SP 1234, sp-1234, etc.
- **Interchangeable terms**: Understands "task" and "SP-XXX" as synonymous
- **Comprehensive search**: When asked about tasks, searches all SP-XXX references
- **Hybrid retrieval**: Combines vector similarity with keyword-based task search

### Intelligent Retrieval Strategy
- **Vector Search**: Top-K similarity using MongoDB Atlas Vector Search
- **Keyword Search**: Pattern matching for specific terms and SP-XXX references  
- **Task-Aware Processing**: Detects task-related queries and prioritizes relevant chunks
- **Context Optimization**: Combines multiple search strategies for comprehensive results

### Performance Optimizations
- **No Duplicate Embeddings**: Intelligent caching prevents regeneration
- **Efficient Chunking**: LangChain RecursiveCharacterTextSplitter for optimal segments
- **Vector Database**: Delegates similarity search to MongoDB Atlas for speed
- **Structured Responses**: JSON output with confidence and follow-up suggestions

## Configuration

### Environment Variables
| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `MONGODB_URI` | MongoDB Atlas connection string | ✅ | - |
| `OPENAI_API_KEY` | OpenAI API key | ✅ | - |
| `PORT` | Server port | ❌ | 3001 |

### MongoDB Requirements
- MongoDB Atlas cluster with Atlas Search enabled
- Vector search index on `transcript_embeddings` collection
- Read/write access to `standuptickets` database

### OpenAI Requirements
- API key with access to:
  - `text-embedding-3-small` (embeddings)
  - `gpt-4` (chat responses)

## Performance & Costs

### Embedding Generation
- **Cost**: ~$0.00002 per chunk with `text-embedding-3-small`
- **Efficiency**: 50% cost reduction vs `text-embedding-ada-002`
- **Caching**: Generated once, stored permanently
- **Chunking**: 3-10 chunks per typical transcript

### Chat Performance
- **Response Time**: 1-3 seconds including vector search
- **Context Quality**: Top 15 most relevant chunks maximum
- **Task Detection**: Automatic SP-XXX pattern recognition
- **Scalability**: Handles 100+ transcripts efficiently

## Integration

### Admin Panel Integration
```typescript
// Check embedding status
const status = await fetch('/api/embeddings/status?ids=transcript1,transcript2')

// Generate if needed  
if (status.embeddedTranscripts < status.totalTranscripts) {
  await fetch('/api/embeddings/generate', {
    method: 'POST',
    body: JSON.stringify({ transcriptIds: ['transcript1'] })
  })
}

// Start chat
const response = await fetch('/api/chat/message', {
  method: 'POST', 
  body: JSON.stringify({
    message: 'What tasks were discussed?',
    transcriptIds: ['transcript1']
  })
})
```

## Troubleshooting

### Common Issues

**❌ Embeddings not generating**
- Verify OpenAI API key and credits
- Check MongoDB Atlas Vector Search index
- Ensure transcript data is valid JSON

**❌ Poor search results**
- Verify vector search index is active
- Check embedding generation completed
- Review chunk size and overlap settings

**❌ Task recognition issues**
- Confirm SP-XXX patterns in transcript content
- Check task-related keyword detection
- Verify hybrid search is functioning

**❌ Performance problems**
- Monitor MongoDB Atlas metrics
- Check OpenAI API rate limits
- Optimize vector search index

### Debug Commands
```bash
# Check embeddings status
curl "http://localhost:3001/api/embeddings/status?ids=your_transcript_id"

# Test task recognition
curl -X POST http://localhost:3001/api/chat/message \
  -H "Content-Type: application/json" \
  -d '{"message": "show me all tasks", "transcriptIds": ["your_transcript_id"]}'

# Monitor server logs
npm run dev
```

## Development

### Project Structure
```
transcript-chat/
├── server.js                 # Express server setup
├── routes/
│   ├── embeddings.js         # Vector embedding generation/status
│   ├── chat.js               # Chat API with hybrid search
│   └── langchain-rag.js      # RAG system with structured output
├── package.json              # Dependencies
└── README.md                 # Documentation
```

### Key Dependencies
- `@langchain/mongodb`: MongoDB Atlas Vector Search integration
- `@langchain/openai`: OpenAI embeddings and chat models
- `langchain`: Core LangChain functionality
- `express`: Web server framework
- `mongodb`: Database driver

## Security

- Add authentication middleware for production
- Use MongoDB Atlas with proper access controls
- Implement rate limiting for OpenAI API calls
- Monitor and log API usage for cost management
- Validate all user inputs

---

## License

ISC License - Internal development use.

For questions or support, check server logs and verify environment configuration.