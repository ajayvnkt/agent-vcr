/**
 * @fileoverview Deterministic LLM: returns scripted assistant turns in order (VCR-style).
 */

import type { AssistantTurn, ChatMessage } from './types.js'

export type ScriptedTurn = AssistantTurn

/**
 * LLM that ignores conversation state and returns `turns[i]` on the i-th `complete` call.
 * Use with {@link collectToolCalls} to replay recorded behavior without a live model.
 */
export class ScriptedLlm {
  private index = 0

  constructor(private readonly turns: ScriptedTurn[]) {}

  async complete(_messages: ChatMessage[]): Promise<AssistantTurn> {
    if (this.index >= this.turns.length) {
      throw new Error(
        `ScriptedLlm: no more scripted turns (index ${this.index}, have ${this.turns.length}).`,
      )
    }
    return this.turns[this.index++]!
  }

  /** Remaining turns that were not consumed. */
  remaining(): number {
    return Math.max(0, this.turns.length - this.index)
  }
}
