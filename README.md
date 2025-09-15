# Transcript Chat Backend Server

A RAG-based backend server for chatting with meeting transcripts using AI. This server provides embeddings generation, similarity search, and conversational AI capabilities for transcript analysis.

## Features

- **Embedding Generation**: Automatically generates embeddings for transcript content using OpenAI
- **RAG System**: Retrieval-Augmented Generation for context-aware responses
- **Similarity Search**: Finds relevant transcript sections using cosine similarity
- **Conversation Storage**: Saves chat sessions to MongoDB for analysis
- **Real-time Chat**: RESTful API for chat communication
- **Health Monitoring**: Built-in health checks and status endpoints

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Setup

Copy the example environment file and configure your variables:

```bash
cp env.example .env
```

Edit `.env` with your configuration:

```env
MONGODB_URI=mongodb://localhost:27017/standuptickets
OPENAI_API_KEY=your-openai-api-key-here
PORT=3001
```

### 3. Start the Server

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

The server will start on `http://localhost:3001`

### 4. Verify Installation

Check that the server is running:

```bash
curl http://localhost:3001/health
```

Test the connection:

```bash
curl http://localhost:3001/api/test
```

## API Endpoints

### Health & Status

#### GET /health
Basic health check
```json
{
  "status": "ok",
  "timestamp": "2025-09-15T...",
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
  "transcript_count": 5,
  "timestamp": "2025-09-15T..."
}
```

### Embeddings API

#### GET /api/embeddings/status
Check embedding status for transcripts
```bash
curl "http://localhost:3001/api/embeddings/status?ids=60f7b3b3b3b3b3b3b3b3b3b3,60f7b3b3b3b3b3b3b3b3b3b4"
```

Response:
```json
{
  "status": "ready|partial",
  "totalTranscripts": 2,
  "embeddedTranscripts": 1,
  "transcripts": [
    {
      "_id": "60f7b3b3b3b3b3b3b3b3b3b3",
      "meeting_id": "teams-meeting-123",
      "hasEmbedding": true,
      "embeddingMetadata": { ... },
      "contentLength": 1500
    }
  ]
}
```

#### POST /api/embeddings/generate
Generate embeddings for specific transcripts
```bash
curl -X POST http://localhost:3001/api/embeddings/generate \
  -H "Content-Type: application/json" \
  -d '{"transcriptIds": ["60f7b3b3b3b3b3b3b3b3b3b3"]}'
```

Response:
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
      "transcriptId": "60f7b3b3b3b3b3b3b3b3b3b3",
      "status": "generated",
      "message": "Embedding generated successfully",
      "embeddingDimensions": 1536,
      "contentLength": 1500
    }
  ]
}
```

### Chat API

#### POST /api/chat/message
Send a message and get AI response
```bash
curl -X POST http://localhost:3001/api/chat/message \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What were the key decisions made in the meeting?",
    "transcriptIds": ["60f7b3b3b3b3b3b3b3b3b3b3", "60f7b3b3b3b3b3b3b3b3b3b4"]
  }'
```

Response:
```json
{
  "success": true,
  "response": "Based on the transcript content, the key decisions made were...",
  "sources": [
    {
      "meetingId": "teams-meeting-123",
      "date": "2025-09-15",
      "similarity": 0.85,
      "preview": "Discussion about project timeline..."
    }
  ],
  "contextUsed": true
}
```

#### POST /api/chat/close
Close chat session and save conversation
```bash
curl -X POST http://localhost:3001/api/chat/close \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "chat-123",
    "transcriptIds": ["60f7b3b3b3b3b3b3b3b3b3b3"],
    "messages": [
      {
        "id": "msg-1",
        "content": "Hello",
        "role": "user",
        "timestamp": "2025-09-15T10:00:00Z"
      }
    ]
  }'
```

#### GET /api/chat/history
Get chat session history
```bash
curl "http://localhost:3001/api/chat/history?limit=10&skip=0"
```

## Database Schema

### Transcripts Collection
The server works with the existing `transcripts` collection and adds embedding fields:

```javascript
{
  _id: ObjectId,
  date: "2025-09-15",
  meeting_id: "teams-meeting-123",
  transcript_data: "JSON string of transcript entries",
  entry_count: 45,
  timestamp: Date,
  
  // Added by this server:
  embeddings: [0.1, 0.2, -0.1, ...], // 1536-dimensional vector
  embeddingMetadata: {
    model: "text-embedding-ada-002",
    generatedAt: "2025-09-15T10:00:00Z",
    contentHash: "abc123...",
    contentLength: 1500,
    lastUpdated: "2025-09-15T10:00:00Z"
  }
}
```

### Chat Collection
Conversation storage in `transcript-chat` collection:

```javascript
{
  _id: ObjectId,
  chatId: "chat-123",
  transcriptIds: ["60f7b3b3b3b3b3b3b3b3b3b3"],
  messages: [
    {
      id: "msg-1",
      content: "What was discussed about the project?",
      role: "user|assistant",
      timestamp: Date
    }
  ],
  startedAt: Date,
  endedAt: Date,
  messageCount: 5,
  createdAt: Date
}
```

## Integration with Admin Panel

The backend is designed to work with the SherpaPrompt Admin Panel:

1. **Admin panel** calls `/api/embeddings/status` to check embedding availability
2. **Admin panel** displays embedding status and generates embeddings if needed
3. **Admin panel** sends chat messages to `/api/chat/message`
4. **Admin panel** closes sessions with `/api/chat/close`

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `MONGODB_URI` | MongoDB connection string | Yes | - |
| `OPENAI_API_KEY` | OpenAI API key for embeddings/chat | Yes | - |
| `PORT` | Server port | No | 3001 |

### MongoDB Requirements

- MongoDB 4.4 or higher
- Existing `standuptickets` database with `transcripts` collection
- Write permissions for embedding updates and chat storage

### OpenAI Requirements

- Valid OpenAI API key with access to:
  - `text-embedding-ada-002` model (for embeddings)
  - `gpt-4` model (for chat responses)

## Performance Considerations

### Embedding Generation
- Each transcript embedding costs ~$0.0001 via OpenAI API
- Embeddings are generated once and cached in MongoDB
- Large transcripts (>8k tokens) are automatically chunked

### Chat Performance
- Similarity search is performed in-memory (very fast)
- Context is limited to top 3 most similar transcript sections
- Responses typically take 1-3 seconds depending on OpenAI API

### Memory Usage
- Server loads embeddings into memory for similarity search
- Typical usage: ~50MB for 100 transcripts with embeddings
- Consider pagination for very large transcript datasets

## Troubleshooting

### Common Issues

**Server won't start:**
- Check MongoDB connection string in `.env`
- Verify MongoDB server is running
- Check OpenAI API key is valid

**Embeddings not generating:**
- Verify OpenAI API key has sufficient credits
- Check transcript data format in MongoDB
- Look for parsing errors in server logs

**Chat responses are poor:**
- Ensure embeddings exist for transcripts
- Check similarity threshold (lowering from 0.7 to 0.5 may help)
- Verify transcript content is meaningful text

**Memory issues:**
- Limit number of transcripts loaded simultaneously
- Consider implementing embedding pagination
- Monitor server memory usage

### Debug Mode

Set debug logging:
```bash
DEBUG=transcript-chat npm run dev
```

View detailed logs:
```bash
tail -f transcript-chat.log
```

## Development

### Project Structure
```
transcript-chat/
├── server.js              # Main server file
├── routes/
│   ├── embeddings.js      # Embedding generation & status
│   └── chat.js            # Chat API & RAG implementation
├── package.json           # Dependencies & scripts
├── README.md              # This documentation
└── env.example            # Environment template
```

### Adding Features

1. **New API endpoints**: Add to `routes/` directory
2. **Database models**: Extend existing MongoDB collections
3. **AI models**: Update OpenAI model configurations in route files
4. **Validation**: Use Zod schemas for request validation

### Testing

```bash
# Test health endpoint
curl http://localhost:3001/health

# Test embedding generation
curl -X POST http://localhost:3001/api/embeddings/generate \
  -H "Content-Type: application/json" \
  -d '{"transcriptIds": ["your-transcript-id"]}'

# Test chat
curl -X POST http://localhost:3001/api/chat/message \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Test question",
    "transcriptIds": ["your-transcript-id"]
  }'
```

## Security Notes

- API endpoints are open for development; add authentication for production
- MongoDB connection should use authentication in production
- Consider rate limiting for OpenAI API calls
- Log and monitor API usage for cost management

## License

ISC License - See LICENSE file for details.

---

For support or questions, check the server logs and verify all environment variables are correctly configured.
