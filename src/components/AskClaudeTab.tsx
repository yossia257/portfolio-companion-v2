import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { supabase } from '../lib/supabase'
import { getDirection, getTextAlign } from '../lib/rtl'
import { useUserProfile } from '../lib/useUserProfile'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const EXAMPLE_PROMPTS = [
  'Am I overexposed to tech?',
  'What should I plan for my next RSU vest?',
  'Are my leveraged ETFs (TQQQ, SSO) still appropriate?',
  'Should I rebalance? Why or why not?',
  'Walk me through the tax cost of selling my biggest winner.',
  'What am I missing in my portfolio?',
]

export default function AskClaudeTab() {
  const { profile } = useUserProfile()
  const userLanguage = profile?.ai_response_language ?? 'en'

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage(text: string) {
    if (!text.trim() || isStreaming) return

    setError(null)
    const userMessage: Message = { role: 'user', content: text }
    const assistantPlaceholder: Message = { role: 'assistant', content: '' }

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder])
    setInput('')
    setIsStreaming(true)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        throw new Error('Not authenticated')
      }

      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
      const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error('Supabase config missing')
      }

      abortControllerRef.current = new AbortController()

      const response = await fetch(`${SUPABASE_URL}/functions/v1/ask-claude`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: [...messages, userMessage] }),
        signal: abortControllerRef.current.signal,
      })

      if (!response.ok) {
        const errBody = await response.text()
        throw new Error(`API error: ${response.status} ${errBody}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response stream')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')

        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataLine = line.slice(6).trim()

            // Skip empty lines
            if (!dataLine) continue

            try {
              const parsed = JSON.parse(dataLine)

              // Handle token events
              if (parsed.type === 'token' && typeof parsed.text === 'string') {
                setMessages((prev) => {
                  const updated = [...prev]
                  if (updated[updated.length - 1]?.role === 'assistant') {
                    updated[updated.length - 1] = {
                      ...updated[updated.length - 1],
                      content: updated[updated.length - 1].content + parsed.text,
                    }
                  }
                  return updated
                })
              }
              // Handle done event
              else if (parsed.type === 'done') {
                setIsStreaming(false)
                break
              }
              // Handle error event
              else if (parsed.type === 'error') {
                console.error('[AskClaudeTab] Stream error:', parsed.message)
                setError(parsed.message || 'Streaming error')
                setIsStreaming(false)
                break
              }
            } catch (e) {
              console.error('[AskClaudeTab] Failed to parse SSE data:', e, 'raw:', dataLine)
            }
          }
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error'
      if (message !== 'The operation was aborted') {
        setError(message)
        console.error('[AskClaudeTab] Error:', e)
      }
    } finally {
      setIsStreaming(false)
      abortControllerRef.current = null
    }
  }

  function stopStreaming() {
    abortControllerRef.current?.abort()
    setIsStreaming(false)
  }

  function clearConversation() {
    setMessages([])
    setInput('')
    setError(null)
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
  }

  function handleExampleClick(prompt: string) {
    setInput(prompt)
  }

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
        <div>
          <h2 className="text-xl font-semibold text-white">Ask Claude</h2>
          <p className="text-xs text-gray-400 mt-1">Claude gives context, not advice.</p>
        </div>
        <button
          onClick={clearConversation}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-300 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 flex flex-col items-center w-full">
        <div className="w-full md:max-w-3xl">
          {messages.length === 0 && (
            <div className="h-full flex items-center justify-center text-center">
              <div>
                <p className="text-gray-400 text-sm">No messages yet.</p>
                <p className="text-gray-500 text-xs mt-2">Ask Claude about your portfolio.</p>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex w-full mb-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                dir={getDirection(msg.role === 'user' ? 'en' : userLanguage)}
                className={`px-4 py-2 rounded-lg ${
                  msg.role === 'user'
                    ? `bg-blue-600 text-white max-w-[80%] text-${getTextAlign('en')}`
                    : `bg-gray-800 text-gray-200 max-w-[90%] text-${getTextAlign(userLanguage)}`
                }`}
              >
                {msg.role === 'assistant' ? (
                  <div className="prose prose-invert prose-sm max-w-none text-gray-200
                    prose-p:text-sm prose-p:my-1
                    prose-a:text-blue-400 prose-a:underline
                    prose-li:text-sm prose-li:my-0.5
                    prose-code:text-xs prose-code:bg-gray-700 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
                    prose-pre:bg-gray-700 prose-pre:p-2 prose-pre:text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {msg.content}
                  </p>
                )}
                {msg.role === 'assistant' && isStreaming && i === messages.length - 1 && (
                  <span className="inline-block ml-1 w-2 h-4 bg-gray-400 animate-pulse" />
                )}
              </div>

              {/* Stop button for current streaming message */}
              {msg.role === 'assistant' && isStreaming && i === messages.length - 1 && (
                <button
                  onClick={stopStreaming}
                  className="ml-2 px-2 py-1 text-xs text-gray-500 hover:text-gray-300 bg-gray-800 hover:bg-gray-700 rounded transition-colors self-end"
                >
                  Stop
                </button>
              )}
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="px-6 py-2 bg-red-900/20 border-t border-red-800 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Example prompts */}
      {messages.length === 0 && (
        <div className="px-6 py-3 border-t border-gray-800 bg-gray-900 shrink-0">
          <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Try asking:</p>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {EXAMPLE_PROMPTS.map((prompt, i) => (
              <button
                key={i}
                onClick={() => handleExampleClick(prompt)}
                className="flex-shrink-0 px-3 py-1.5 text-xs text-gray-300 bg-gray-800 hover:bg-gray-700 rounded-full transition-colors whitespace-nowrap"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-gray-800 px-6 py-4 bg-gray-900 shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage(input)
              }
            }}
            placeholder="Ask about your portfolio…"
            disabled={isStreaming}
            className="flex-1 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={isStreaming || !input.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">Press Enter to send, Shift+Enter for new line</p>
      </div>
    </div>
  )
}
