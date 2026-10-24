import { Span, startInactiveSpan } from '@sentry/node'
import { OpenAI } from 'openai'

import { transcodeOggOpusToWav } from '../../codecs/opus-transcoder'
import { getLogger } from '../../logger'
import { STTBackend, STTBackendSession } from '../backend'

interface OpenRouterSTTBackendParameters {
  language?: string;
  model: string;
  partialIntervalMs: number;
}

class OpenRouterSTTSession extends STTBackendSession {
  private readonly chunks: Buffer[] = []
  private closed = false
  private generation = 0
  private lastPartialAt = Date.now()
  private readonly logger = getLogger<OpenRouterSTTSession>()
  private partialAbortController: AbortController | null = null

  constructor (private readonly openAI: OpenAI, private readonly parameters: OpenRouterSTTBackendParameters,
    private readonly span?: Span) {
    super()
  }

  close (): void {
    if (this.closed) return
    this.closed = true
    this.generation++
    this.partialAbortController?.abort()
    this.span?.end()
  }

  override async finish (): Promise<null | string> {
    if (this.closed || this.chunks.length === 0) {
      this.span?.end()
      return null
    }
    const generation = ++this.generation
    this.partialAbortController?.abort()

    const audio = Buffer.concat(this.chunks)
    try {
      const response = await this.transcribe(audio)
      if (generation !== this.generation) {
        return null
      }
      this.span?.setAttribute('text', response.text)
      this.span?.end()
      return response.text
    } catch (error) {
      this.logger.warn({
        details: error instanceof OpenAI.APIError ? error.error : undefined,
        error: String(error),
        event: 'openrouter_stt_final_failed'
      })
      this.span?.end()
      return null
    }
  }

  transcribeChunk (chunk: Buffer): void {
    if (this.closed) return
    this.chunks.push(chunk)
    if (this.parameters.partialIntervalMs > 0 && this.partialAbortController === null &&
      Date.now() - this.lastPartialAt >= this.parameters.partialIntervalMs) {
      this.lastPartialAt = Date.now()
      void this.transcribePartial()
    }
  }

  private async transcribe (audio: Buffer, signal?: AbortSignal): Promise<{ text: string }> {
    // the station streams Opus in OGG, which providers reject with 400; WAV is accepted everywhere
    const wav = await transcodeOggOpusToWav(audio)
    const response = await this.openAI.audio.transcriptions.create({
      file: new File([Uint8Array.from(wav)], 'audio.wav', { type: 'audio/wav' }),
      ...(this.parameters.language ? { language: this.parameters.language } : {}),
      model: this.parameters.model
    }, signal ? { signal } : {})
    return { text: response.text }
  }

  private async transcribePartial (): Promise<void> {
    const generation = this.generation
    if (this.chunks.length === 0) return

    const audio = Buffer.concat(this.chunks)
    const abortController = new AbortController()
    this.partialAbortController = abortController
    try {
      const response = await this.transcribe(audio, abortController.signal)
      if (generation === this.generation && response.text.length > 0) {
        this.chunkTranscribed({
          endOfUtt: false,
          text: response.text
        })
      }
    } catch (error) {
      // failed partial transcriptions are not fatal, the final one still runs
      this.logger.debug({ error: String(error), event: 'openrouter_stt_partial_failed' })
    } finally {
      if (this.partialAbortController === abortController) {
        this.partialAbortController = null
      }
    }
  }
}

export class OpenRouterSTTBackend implements STTBackend {
  constructor (private readonly openAI: OpenAI, private readonly parameters: OpenRouterSTTBackendParameters) {}

  startTranscribing (parentSpan?: Span): Promise<STTBackendSession> {
    let span: Span | undefined
    if (parentSpan) {
      span = startInactiveSpan({
        name: 'OpenRouter STT transcribing',
        op: 'openrouter-stt',
        parentSpan
      })
    }
    return Promise.resolve(new OpenRouterSTTSession(this.openAI, this.parameters, span))
  }
}
