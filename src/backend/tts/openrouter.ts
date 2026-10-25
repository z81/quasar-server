import type { ReadableStream as WebReadableStream } from 'node:stream/web'

import { Span, startInactiveSpan } from '@sentry/node'
import { Readable } from 'node:stream'
import { OpenAI } from 'openai'

import { transcodePcmStreamToOggOpus } from '../../codecs/opus-transcoder'
import { TTSBackend, TTSRequest, TTSResponse, TTSStreamResponse } from '../backend'

interface OpenRouterTTSBackendParameters {
  instructions?: string;
  model: string;
  pcmSampleRate: number;
  speed: number;
  voice: string;
}

export class OpenRouterTTSBackend implements TTSBackend {
  constructor (private readonly openAI: OpenAI, private readonly parameters: OpenRouterTTSBackendParameters) {}

  async synthesize (request: TTSRequest): Promise<TTSResponse> {
    const stream = await this.synthesizeStream(request)
    const parts: Buffer[] = []
    for await (const chunk of stream.chunks) {
      parts.push(chunk)
    }
    return {
      format: stream.format,
      voiceOutput: Buffer.concat(parts)
    }
  }

  /**
   * Streams the response of /audio/speech as it is generated: PCM arrives
   * from OpenRouter incrementally, is transcoded to OGG/Opus on the fly and
   * can be played by the station before the whole phrase is synthesized
   */
  async synthesizeStream (request: TTSRequest): Promise<TTSStreamResponse> {
    let span: Span | undefined
    if (request.parentSpan) {
      span = startInactiveSpan({
        name: 'OpenRouter TTS synthesizing',
        op: 'openrouter-tts',
        parentSpan: request.parentSpan
      })
    }
    try {
      // OpenRouter has no opus output, so PCM is transcoded to OGG/Opus locally
      const result = await this.openAI.audio.speech.create({
        input: request.text,
        model: this.parameters.model,
        response_format: 'pcm',
        ...(this.parameters.speed === 1 ? {} : { speed: this.parameters.speed }),
        ...(this.parameters.instructions ? { instructions: this.parameters.instructions } : {}),
        voice: this.parameters.voice
      })
      if (!result.body) {
        throw new Error('OpenRouter TTS returned no audio stream')
      }
      const pcmStream = Readable.fromWeb(result.body as unknown as WebReadableStream<Uint8Array>)
      return {
        chunks: this.streamChunks(pcmStream, span),
        format: 'audio/opus'
      }
    } catch (error) {
      span?.end()
      throw error
    }
  }

  private async * streamChunks (pcmStream: Readable, span?: Span): AsyncGenerator<Buffer> {
    try {
      for await (const oggChunk of transcodePcmStreamToOggOpus(pcmStream, this.parameters.pcmSampleRate)) {
        yield oggChunk
      }
    } finally {
      span?.end()
    }
  }
}
