# quasar-server

Emulator of Yandex.Station Quasar backend server. Позволяет станции работать без облака Яндекса: голосовой ассистент целиком на ваших бэкендах.

В этой сборке **все AI-фичи — распознавание речи (STT), синтез речи (TTS) и диалоговый процессор («мозг») — работают через [OpenRouter](https://openrouter.ai) с одним токеном**, без отдельных сервисов GigaAM / OpenAI-совместимого TTS / процессора.

## Требования

- Node.js ≥ 24 и pnpm ≥ 10
- PostgreSQL
- **ffmpeg** — транскодинг TTS-аудио (OpenRouter отдаёт PCM, станция ждёт OGG/Opus)
- Токен OpenRouter ([openrouter.ai/keys](https://openrouter.ai/settings/keys))

## Запуск

```bash
git clone --recurse-submodules <repo>
cd quasar-server
pnpm install
pnpm generate-proto
OPENROUTER_API_KEY=sk-or-... pnpm start
```

Конфигурация читается из `.env.local` (приоритетнее) и `.env`.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `31115` | Порт основного сервера (эмуляция доменов Яндекса) |
| `API_PORT` | `31116` | Порт API управления устройствами |
| `POSTGRES_URL` | `postgres://quasar:quasar@localhost/quasar` | Строка подключения PostgreSQL |
| `OPENROUTER_API_KEY` | — | **Обязательный.** Токен OpenRouter для STT, TTS и процессора |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Базовый URL OpenRouter-совместимого API |
| `OPENROUTER_TIMEOUT_MS` | `10000` | Таймаут запроса к OpenRouter, без повторов (станция ждёт ответ ~15 с) |
| `OPENROUTER_STT_MODEL` | `openai/whisper-large-v3` | Модель распознавания речи (`/audio/transcriptions`) |
| `OPENROUTER_STT_LANGUAGE` | `ru` | Язык речи (ISO-639-1) |
| `OPENROUTER_STT_PARTIAL_INTERVAL_MS` | `0` | Интервал промежуточных распознаваний (0 — выключено; каждая промежуточная = отдельный платный запрос) |
| `OPENROUTER_TTS_MODEL` | `google/gemini-3.8-flash-lite-tts` | Модель синтеза речи (`/audio/speech`) |
| `OPENROUTER_TTS_VOICE` | `Kore` | Голос (список — на странице модели на OpenRouter) |
| `OPENROUTER_TTS_INSTRUCTIONS` | — | Стиль речи (поддерживается не всеми моделями) |
| `OPENROUTER_TTS_SPEED` | `1` | Скорость речи |
| `OPENROUTER_TTS_PCM_SAMPLE_RATE` | `24000` | Частота дискретизации PCM, которую отдаёт TTS-модель |
| `OPENROUTER_PROCESSOR_MODEL` | `google/gemini-3.8-flash` | Модель «мозга» (chat completions; должны поддерживаться стриминг и tools) |
| `OPENROUTER_PROCESSOR_SYSTEM_PROMPT` | встроенный | Системный промпт ассистента |
| `MUSIC_SERVICE_BASIC_URL` | — | Адрес музыкального сервиса (иначе заглушка) |
| `AUDIO_METADATA_URLS` | — | URL бэкендов аудиометаданных через запятую |

## Как это работает

- **STT** — аудиопоток станции (OGG/Opus) отправляется в `POST /api/v1/audio/transcriptions` после конца фразы; текст уходит в процессор.
- **Процессор** — стриминговый `chat/completions`: частичные ответы нарезаются по границам предложений и озвучиваются по мере генерации; управление колонкой (музыка, громкость, Bluetooth) — через tools, которые маппятся в директивы Quasar.
- **TTS** — `POST /api/v1/audio/speech` (`response_format: pcm`), затем PCM транскодируется в OGG/Opus через ffmpeg и отправляется на станцию.

## Лицензия

[GPL-3.0](LICENSE)
