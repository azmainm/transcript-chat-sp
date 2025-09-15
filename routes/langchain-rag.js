const { ChatOpenAI } = require('@langchain/openai');
const { PromptTemplate } = require('langchain/prompts');
const { RunnableSequence } = require('langchain/schema/runnable');
const { StringOutputParser } = require('langchain/schema/output_parser');

/**
 * LangChain-based RAG system for transcript chat
 */
class TranscriptRAG {
  constructor() {
    this.llm = new ChatOpenAI({
      modelName: 'gpt-5-nano',
      max_output_tokens: 1000,
      reasoning: { effort: 'medium' },
      verbosity: "medium",
    });

    // System prompt template
    this.systemPrompt = PromptTemplate.fromTemplate(`
You are an AI assistant specialized in analyzing meeting transcripts and providing helpful insights.

Your role:
- You have access to transcript content from team meetings
- You can answer questions about discussions, decisions, action items, and meeting content
- You should provide specific, accurate information based only on the transcript content provided
- If you cannot find relevant information in the transcripts, clearly state that
- Be conversational but professional in your responses

Guidelines:
- Always base your responses on the provided transcript context
- Quote specific parts of conversations when relevant
- If asked about people, reference what they said or did in the meetings
- If asked about decisions or action items, be specific about what was discussed
- If the question cannot be answered from the transcript content, say so clearly

Context from relevant transcript sections:
{context}

Human Question: {question}

Please respond to the human's question based on the transcript content above.`);

    // Create the RAG chain
    this.ragChain = RunnableSequence.from([
      {
        context: (input) => input.context,
        question: (input) => input.question,
      },
      this.systemPrompt,
      this.llm,
      new StringOutputParser(),
    ]);
  }

  /**
   * Generate response using LangChain RAG
   * @param {string} question - User's question
   * @param {string} context - Relevant transcript context
   * @param {Array} conversationHistory - Previous messages for context
   * @returns {Promise<string>} AI response
   */
  async generateResponse(question, context, conversationHistory = []) {
    try {
      // For now, we'll use the simple RAG chain
      // In the future, we can add conversation memory here
      const response = await this.ragChain.invoke({
        question,
        context: context || 'No relevant transcript content found for this query.',
      });

      return response;
    } catch (error) {
      console.error('Error in LangChain RAG:', error);
      throw error;
    }
  }

  /**
   * Format context from similar transcript sections
   * @param {Array} similarContent - Array of similar content with metadata
   * @returns {string} Formatted context string
   */
  formatContext(similarContent) {
    if (!similarContent || similarContent.length === 0) {
      return 'No relevant transcript content found for this query.';
    }

    return similarContent.map((item, index) => {
      const similarity = (item.similarity * 100).toFixed(1);
      return `[Source ${index + 1}: Meeting ${item.meetingId} - ${item.date}] (Similarity: ${similarity}%)
${item.content}`;
    }).join('\n\n---\n\n');
  }
}

module.exports = { TranscriptRAG };
