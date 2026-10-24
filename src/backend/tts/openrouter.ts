import { Span, startInactiveSpan } from '@sentry/node'
import { OpenAI } from 'openai'

import { transcodePcmToOggOpus } from '../../codecs/opus-transcoder'
import { TTSBackend, TTSRequest, TTSResponse } from '../backend'

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
      const pcm = Buffer.from(await result.arrayBuffer())
      if (pcm.length === 0) {
        throw new Error('OpenRouter TTS returned empty audio')
      }
      return {
        format: 'audio/opus',
        voiceOutput: await transcodePcmToOggOpus(pcm, this.parameters.pcmSampleRate)
      }
    } finally {
      span?.end()
    }
  }
}
