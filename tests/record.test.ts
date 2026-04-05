import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordTrace } from '../src/record.js'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('recordTrace', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws when no API key is provided', async () => {
    const prev = process.env['OPENAI_API_KEY']
    delete process.env['OPENAI_API_KEY']
    await expect(
      recordTrace({
        user: 'hi',
        tools: [],
        httpFetch: vi.fn(),
      }),
    ).rejects.toThrow(/no API key/)
    if (prev !== undefined) process.env['OPENAI_API_KEY'] = prev
  })

  it('records tool calls across rounds using httpFetch mock', async () => {
    const tools = [
      {
        name: 'lookup_order',
        description: 'Look up order',
        parameters: {
          type: 'object',
          properties: { orderId: { type: 'string' } },
          required: ['orderId'],
        },
      },
      {
        name: 'refund_order',
        description: 'Refund',
        parameters: {
          type: 'object',
          properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
          required: ['orderId', 'amount'],
        },
      },
    ]

    let round = 0
    const httpFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      round++
      const body = init?.body ? JSON.parse(init.body as string) : {}
      const msgs = body.messages as unknown[]

      if (round === 1) {
        expect(msgs.some((m) => (m as { role: string }).role === 'user')).toBe(true)
        return jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'lookup_order',
                      arguments: JSON.stringify({ orderId: '123' }),
                    },
                  },
                ],
              },
            },
          ],
        })
      }

      if (round === 2) {
        expect(msgs.some((m) => (m as { role: string }).role === 'tool')).toBe(true)
        return jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_2',
                    type: 'function',
                    function: {
                      name: 'refund_order',
                      arguments: JSON.stringify({ orderId: '123', amount: 10 }),
                    },
                  },
                ],
              },
            },
          ],
        })
      }

      return jsonResponse({
        choices: [{ message: { content: 'Done.', tool_calls: undefined } }],
      })
    })

    const trace = await recordTrace({
      apiKey: 'sk-test-mock',
      system: 'Support agent.',
      user: 'Refund order 123',
      scenario: 'refund_happy_path',
      tools,
      stubs: {
        lookup_order: { found: true },
        refund_order: { ok: true },
      },
      httpFetch,
    })

    expect(trace.version).toBe(1)
    expect(trace.scenario).toBe('refund_happy_path')
    expect(trace.calls).toEqual([
      { name: 'lookup_order', args: { orderId: '123' } },
      { name: 'refund_order', args: { orderId: '123', amount: 10 } },
    ])
    expect(httpFetch).toHaveBeenCalledTimes(3)
  })

  it('throws on non-OK API response', async () => {
    const httpFetch = vi.fn(async () => jsonResponse({ error: 'bad' }, 401))
    await expect(
      recordTrace({
        apiKey: 'sk-x',
        user: 'u',
        tools: [
          {
            name: 't',
            description: 'd',
            parameters: { type: 'object', properties: {} },
          },
        ],
        httpFetch,
      }),
    ).rejects.toThrow(/API error 401/)
  })

  it('stores _raw when tool arguments are invalid JSON', async () => {
    let call = 0
    const httpFetch = vi.fn(async () => {
      call++
      if (call === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'broken', arguments: 'not-json{' },
                  },
                ],
              },
            },
          ],
        })
      }
      return jsonResponse({
        choices: [{ message: { content: 'Stopping after bad args.', tool_calls: undefined } }],
      })
    })

    const trace = await recordTrace({
      apiKey: 'sk-x',
      user: 'u',
      tools: [
        {
          name: 'broken',
          description: 'd',
          parameters: { type: 'object', properties: {} },
        },
      ],
      maxSteps: 8,
      httpFetch,
    })

    expect(trace.calls).toHaveLength(1)
    expect(trace.calls[0]!.name).toBe('broken')
    expect(trace.calls[0]!.args).toEqual({ _raw: 'not-json{' })
    expect(httpFetch).toHaveBeenCalledTimes(2)
  })
})
