import type { ChatCompletionMessageFunctionToolCall, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat'

import { Span, startInactiveSpan } from '@sentry/node'
import { ProcessorDirectiveFunctions } from '@v3rt3p/types/processor'
import { EventEmitter } from 'node:stream'
import { OpenAI } from 'openai'

import { getLogger } from '../../logger'
import { ProcessorBackend, ProcessorPartialResponse, ProcessorRequest, ProcessorSession, ProcessorSessionEvents } from '../backend'

const DEFAULT_SYSTEM_PROMPT = `Ты — голосовой ассистент умной колонки в доме пользователя. Ты получаешь реплики пользователя в виде текста, а твой ответ будет произнесён вслух синтезатором речи.

Правила:
- Отвечай на русском языке (если тебя не просят иначе), кратко и живо, как в устной беседе.
- Не используй разметку, списки, эмодзи, код и спецсимволы — только обычный текст.
- Для управления колонкой (музыка, громкость, Bluetooth и прочее) вызывай доступные инструменты. Действия выполняются автоматически, коротко подтверждай их выполнение.
- Если просьбу нельзя выполнить доступными инструментами, честно скажи об этом и предложи, чем можешь помочь.
- Если реплика помечена как внешнее событие, отреагируй уместно: сообщи о нём или помоги разобраться.`

const ERROR_RESPONSE_TEXT = 'Извините, что-то пошло не так. Попробуйте спросить ещё раз.'

interface OpenRouterProcessorBackendParameters {
  model: string;
  systemPrompt?: string;
}

export class OpenRouterProcessorBackend implements ProcessorBackend {
  constructor (private readonly openAI: OpenAI, private readonly parameters: OpenRouterProcessorBackendParameters) {}

  openSession (parentSpan?: Span): Promise<ProcessorSession> {
    let span: Span | undefined
    if (parentSpan) {
      span = startInactiveSpan({
        name: 'OpenRouter processor processing',
        op: 'openrouter-processor',
        parentSpan
      })
    }
    return Promise.resolve(new OpenRouterProcessorSession(this.openAI, this.parameters, span))
  }
}

// eslint-disable-next-line unicorn/prefer-event-target
export class OpenRouterProcessorSession extends EventEmitter<ProcessorSessionEvents> implements ProcessorSession {
  private closed = false
  private currentAbortController: AbortController | null = null
  private directiveFunctions: ProcessorDirectiveFunctions = {}
  private readonly logger = getLogger<OpenRouterProcessorSession>()
  private readonly messages: ChatCompletionMessageParam[]
  private turnQueue: Promise<void> = Promise.resolve()

  constructor (private readonly openAI: OpenAI, private readonly parameters: OpenRouterProcessorBackendParameters,
    private readonly span?: Span) {
    super()
    this.messages = [{
      content: parameters.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      role: 'system'
    }]
  }

  close (): void {
    if (this.closed) return
    this.closed = true
    this.currentAbortController?.abort()
    this.span?.end()
  }

  prepare (directiveFunctions: ProcessorDirectiveFunctions): Promise<void> {
    this.directiveFunctions = directiveFunctions
    return Promise.resolve()
  }

  process (request: ProcessorRequest): Promise<void> {
    this.turnQueue = this.turnQueue
      .then(() => this.runTurn(request))
      .catch(error => {
        this.logger.warn({ error: String(error), event: 'openrouter_processor_turn_failed' })
      })
    return this.turnQueue
  }

  private buildTools (): ChatCompletionTool[] {
    return Object.entries(this.directiveFunctions).map(([name, info]) => ({
      function: {
        description: info.description,
        name,
        parameters: normalizeJsonSchema(info.arguments)
      },
      type: 'function' as const
    }))
  }

  private emitPartial (text: string, directives: ProcessorPartialResponse['directives'], finished: boolean): void {
    this.emit('partialResponse', finished
      ? {
          directives,
          finished: true,
          shouldListen: false,
          text
        }
      : {
          directives,
          finished: false,
          text
        })
  }

  private async runTurn (request: ProcessorRequest): Promise<void> {
    if (this.closed) return

    if (request.text.length === 0) {
      this.emitPartial('', [], true)
      return
    }

    const abortController = new AbortController()
    this.currentAbortController = abortController

    this.messages.push({
      content: buildUserContent(request),
      role: 'user'
    })

    try {
      const tools = this.buildTools()
      const stream = await this.openAI.chat.completions.create({
        messages: this.messages,
        model: this.parameters.model,
        stream: true,
        ...(tools.length > 0 ? { tools } : {})
      }, { signal: abortController.signal })

      let text = ''
      let emittedLength = 0
      const toolCalls = new Map<number, ChatCompletionMessageFunctionToolCall>()

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (!delta) continue
        if (delta.content) {
          text += delta.content
          const sentenceEnd = findSentenceEnd(text)
          if (sentenceEnd > emittedLength) {
            this.emitPartial(text.slice(emittedLength, sentenceEnd), [], false)
            emittedLength = sentenceEnd
          }
        }
        for (const toolCall of delta.tool_calls ?? []) {
          const existing = toolCalls.get(toolCall.index) ?? {
            function: {
              arguments: '',
              name: ''
            },
            id: '',
            type: 'function' as const
          }
          if (toolCall.id) existing.id = toolCall.id
          if (toolCall.function?.name) existing.function.name += toolCall.function.name
          if (toolCall.function?.arguments) existing.function.arguments += toolCall.function.arguments
          toolCalls.set(toolCall.index, existing)
        }
      }

      const calls = [...toolCalls.values()].filter(call => call.function.name.length > 0)
      this.messages.push({
        ...(text.length > 0 ? { content: text } : {}),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
        role: 'assistant'
      })
      for (const call of calls) {
        // directives are fire-and-forget device actions, no real result to report back
        this.messages.push({
          content: 'done',
          role: 'tool',
          tool_call_id: call.id
        })
      }

      const directives = calls.map(call => ({
        arguments: parseArguments(call.function.arguments),
        name: call.function.name
      }))

      this.emitPartial(text.slice(emittedLength), directives, true)
      this.span?.setAttribute('text', text)
    } catch (error) {
      if (this.closed) return
      this.logger.warn({ error: String(error), event: 'openrouter_processor_stream_failed' })
      this.emitPartial(ERROR_RESPONSE_TEXT, [], true)
    } finally {
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null
      }
    }
  }
}

function buildUserContent (request: ProcessorRequest): string {
  const context: string[] = [`сейчас ${new Date().toLocaleString('ru-RU')}`]
  const deviceState = request.metadata.deviceState as Record<string, unknown> | undefined
  if (typeof deviceState?.SoundLevel === 'number') {
    context.push(`громкость колонки ${deviceState.SoundLevel} из 10`)
  }
  if (deviceState?.SoundMuted === true) {
    context.push('звук выключен')
  }
  if (typeof request.metadata.gender === 'string') {
    context.push(`говорит ${request.metadata.gender === 'female' ? 'женщина' : 'мужчина'}`)
  }

  const prefix = request.isExternalEvent ? '[внешнее событие] ' : ''
  return `[Контекст: ${context.join('; ')}]\n${prefix}${request.text}`
}

function findSentenceEnd (text: string): number {
  let end = -1
  for (const separator of ['.', '!', '?', '…', '\n']) {
    end = Math.max(end, text.lastIndexOf(separator))
  }
  return end === -1 ? 0 : end + 1
}

function normalizeJsonSchema (schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || (schema as Record<string, unknown>).type !== 'object') {
    return {
      properties: {},
      type: 'object'
    }
  }
  return schema as Record<string, unknown>
}

function parseArguments (raw: string): unknown {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
