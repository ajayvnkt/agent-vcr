/**
 * Example: RAG Pipeline Validation
 *
 * Tests that a retrieval-augmented generation agent always searches,
 * reranks, and cites sources — catching silent regressions like
 * "the agent started hallucinating without retrieving any docs."
 *
 * Run: npm run example:rag-validation
 */

import {
  ScriptedLlm,
  assistantText,
  assistantWithTools,
  collectToolCalls,
  compareTraces,
  loadTraceFile,
  toolCall,
} from '../../dist/index.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const goldenPath = join(__dirname, 'traces', 'rag-with-citation.expected.json')

const SYSTEM = `You are a knowledge-base assistant. You MUST:
1. search_knowledge_base — always retrieve relevant documents first
2. rerank_results — rerank retrieved documents by relevance
3. cite_sources — include source IDs in your final answer

Never answer without retrieving and citing sources.`

const query = 'refund policy for digital products'

// ── Scripted LLM ──────────────────────────────────────────────────────────────

const llm = new ScriptedLlm([
  assistantWithTools([
    toolCall('search_knowledge_base', { query, topK: 3 }, 'c1'),
  ]),
  assistantWithTools([
    toolCall('rerank_results', {
      query,
      resultIds: ['doc_1', 'doc_2', 'doc_3'],
    }, 'c2'),
  ]),
  assistantWithTools([
    toolCall('cite_sources', {
      sourceIds: ['doc_1', 'doc_2'],
      answer: 'Digital products are refundable within 14 days of purchase.',
    }, 'c3'),
  ]),
  assistantText(
    'Based on our policy docs [doc_1, doc_2]: Digital products are refundable within 14 days of purchase.',
  ),
])

// ── Stub tool backend ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  if (name === 'search_knowledge_base') {
    return {
      results: [
        { id: 'doc_1', title: 'Refund Policy', score: 0.91 },
        { id: 'doc_2', title: 'Digital Product Terms', score: 0.87 },
        { id: 'doc_3', title: 'FAQ', score: 0.72 },
      ],
    }
  }
  if (name === 'rerank_results') {
    return { rankedIds: ['doc_1', 'doc_2', 'doc_3'] }
  }
  if (name === 'cite_sources') {
    return { citationBlock: `[Sources: ${args.sourceIds.join(', ')}]` }
  }
  throw new Error(`Unknown tool: ${name}`)
}

// ── Subsequence mode: as long as these tools appear in order, extra calls are OK ──

const recorded = await collectToolCalls({
  system: SYSTEM,
  user: `What is the ${query}?`,
  llm,
  executeTool,
})

const expected = await loadTraceFile(goldenPath)

// Use subsequence mode — the pipeline must include search → rerank → cite
// but may add more steps in future without breaking the test
const result = compareTraces(expected.calls, recorded, { mode: 'subsequence' })

if (!result.ok) {
  console.error('TRACE MISMATCH:', result.reason)
  process.exit(1)
}

console.error(`OK: rag-validation — pipeline integrity confirmed (subsequence mode)`)
console.error(`    ${recorded.map((c) => c.name).join(' → ')}`)
