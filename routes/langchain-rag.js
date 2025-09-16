const { ChatOpenAI } = require('@langchain/openai');
const { ChatPromptTemplate, SystemMessagePromptTemplate, HumanMessagePromptTemplate } = require('langchain/prompts');
const { RunnableSequence } = require('langchain/schema/runnable');
const { StringOutputParser } = require('langchain/schema/output_parser');
const { z } = require('zod');

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

    // Define response schema for structured output
    this.responseSchema = z.object({
      answer: z.string().describe("The main response to the user's question"),
      confidence: z.enum(['high', 'medium', 'low']).describe("Confidence level in the answer based on available context"),
      sources_used: z.array(z.string()).describe("List of meeting IDs or dates that provided relevant information"),
      follow_up_questions: z.array(z.string()).optional().describe("Suggested follow-up questions the user might ask")
    });

    // Create ChatPromptTemplate with system and human messages
    this.chatPrompt = ChatPromptTemplate.fromMessages([
      SystemMessagePromptTemplate.fromTemplate(`
You are an AI assistant specialized in analyzing meeting transcripts and providing helpful insights.

Your role:
- You have access to transcript content from team meetings
- You can answer questions about discussions, decisions, action items, and meeting content
- You should provide specific, accurate information based only on the transcript content provided
- If you cannot find relevant information in the transcripts, clearly state that
- Be conversational but professional in your responses

CRITICAL: MULTI-TRANSCRIPT ANALYSIS
- You may be analyzing content from MULTIPLE DIFFERENT MEETING DATES
- Content is grouped by MEETING DATE in the format: === MEETING ON [DATE] ===
- When users ask for information about "each meeting" or "separate summaries", you MUST analyze and respond for each unique DATE separately
- IMPORTANT: Multiple transcripts from the same date should be treated as ONE MEETING - combine their content into a single analysis
- When presenting information from multiple meeting dates, organize your response by DATE for clarity
- If a user asks "give me a summary of each meeting", provide ONE summary per unique date, even if there are multiple transcript sources from that date

Important Context Recognition:
- TASKS and SP-XXX are INTERCHANGEABLE TERMS - when someone asks about "tasks", they want to know about SP-XXX items
- Any reference to "SP-XXX", "SP XXX", "sp-XXX", "sp XXX" or similar patterns (where XXX is a number) refers to TASKS
- These are task identifiers (e.g., "SP-123", "sp-45", "SP 789" all refer to specific tasks)
- When asked about "tasks" in general, actively search for and list ALL SP-XXX references found in the transcript
- When you see these patterns, recognize them as task references in your responses
- Pay special attention to discussions about these tasks, their status, assignments, or updates
- If someone asks "what tasks were discussed", you should find and list ALL SP-XXX patterns, even if they weren't explicitly called "tasks"

Guidelines:
- Always base your responses on the provided transcript context
- Quote specific parts of conversations when relevant
- If asked about people, reference what they said or did in the meetings AND specify which meeting
- If asked about decisions or action items, be specific about what was discussed AND in which meeting
- When discussing tasks, use the SP-XXX format and mention any relevant details from the transcript AND which transcript discussed them
- When asked about "tasks" or "what tasks were discussed", scan through ALL the provided context and identify EVERY SP-XXX pattern mentioned, organized by transcript ID
- Be comprehensive - don't just mention one task if multiple SP-XXX items are referenced
- When analyzing multiple transcripts, clearly separate your analysis by date
- Use headers or clear organization when discussing multiple transcripts (e.g., "## Meeting on September 15, 2025")
- If the question cannot be answered from the transcript content, say so clearly

RESPONSE FORMAT FOR MULTIPLE TRANSCRIPTS:
When you have content from multiple transcripts, structure your response like this:
## Meeting on [DATE]
[Analysis specific to this transcript]

## Meeting on [DATE]  
[Analysis specific to this transcript]

Note: Use descriptive dates (e.g., "September 15, 2025" or "2025-09-15") instead of showing long transcript or meeting IDs to users.

Please provide a helpful response based on the transcript content below.

Context from relevant transcript sections:
{context}`),
      HumanMessagePromptTemplate.fromTemplate("{question}")
    ]);

    // Create output parser for string responses (fallback for older LangChain)
    this.outputParser = new StringOutputParser();

    // Create the RAG chain
    this.ragChain = RunnableSequence.from([
      {
        context: (input) => input.context,
        question: (input) => input.question,
      },
      this.chatPrompt,
      this.llm,
      this.outputParser,
    ]);
  }

  /**
   * Generate response using LangChain RAG
   * @param {string} question - User's question
   * @param {string} context - Relevant transcript context
   * @param {Array} conversationHistory - Previous messages for context
   * @returns {Promise<Object>} Structured AI response
   */
  async generateResponse(question, context, conversationHistory = []) {
    try {
      // Use the RAG chain to get string response
      const response = await this.ragChain.invoke({
        question,
        context: context || 'No relevant transcript content found for this query.',
      });

      // Try to parse JSON response if it looks like JSON
      if (typeof response === 'string' && response.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(response);
          if (parsed.answer) {
            return parsed;
          }
        } catch (parseError) {
          // If JSON parsing fails, treat as plain text
        }
      }

      // Return structured response from string
      return {
        answer: typeof response === 'string' ? response : 'I encountered an issue processing your request. Please try again.',
        confidence: 'medium',
        sources_used: [],
        follow_up_questions: []
      };
    } catch (error) {
      console.error('Error in LangChain RAG:', error);
      // Return structured error response
      return {
        answer: 'I encountered an error while processing your request. Please try again or rephrase your question.',
        confidence: 'low',
        sources_used: [],
        follow_up_questions: []
      };
    }
  }

  /**
   * Format context from similar transcript sections with enhanced transcript separation
   * @param {Array} similarContent - Array of similar content with metadata
   * @returns {string} Formatted context string with clear transcript boundaries
   */
  formatContext(similarContent) {
    if (!similarContent || similarContent.length === 0) {
      return 'No relevant transcript content found for this query.';
    }

    // Group content by DATE for better user experience (users care about dates, not internal IDs)
    const groupedByDate = {};
    similarContent.forEach((item, index) => {
      const dateKey = item.date;
      if (!groupedByDate[dateKey]) {
        groupedByDate[dateKey] = {
          date: item.date,
          transcripts: new Set(),
          content: []
        };
      }
      groupedByDate[dateKey].transcripts.add(item.transcriptId);
      const similarity = (item.similarity * 100).toFixed(1);
      groupedByDate[dateKey].content.push({
        sourceNum: index + 1,
        content: item.content,
        similarity: similarity,
        transcriptId: item.transcriptId
      });
    });

    // Format grouped content with clear date separation (user-friendly)
    const formattedSections = Object.values(groupedByDate).map(meeting => {
      const header = `=== MEETING ON ${meeting.date} ===`;
      const contentSections = meeting.content.map(section => 
        `[Source ${section.sourceNum}] (Similarity: ${section.similarity}%)
${section.content}`
      ).join('\n\n');
      
      return `${header}\n${contentSections}`;
    });

    return formattedSections.join('\n\n' + '='.repeat(60) + '\n\n');
  }
}

module.exports = { TranscriptRAG };
