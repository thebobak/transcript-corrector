import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { writeFile, readFile, rm, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const Ffmpeg    = require('fluent-ffmpeg')
const ffmpegBin = require('ffmpeg-static')
Ffmpeg.setFfmpegPath(ffmpegBin)

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(express.json({ limit: '500mb' }))
app.use(express.static(join(__dirname, 'public')))

const CHUNK_SIZE       = 200
const AUDIO_CHUNK_SIZE = 100
const MAX_WHISPER_BYTES = 24 * 1024 * 1024   // 24 MB per Whisper request
const ENCODE_KBPS      = 64
const BYTES_PER_SEC    = (ENCODE_KBPS * 1000) / 8   // ~8000 B/s at 64 kbps

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(glossary) {
  return `You are a professional transcript correction specialist. Fix mis-transcribed words in SRT subtitle files — words the speech-to-text engine misheard or garbled, especially technical terms, corporate tool names, product names, and proper nouns.

RULES:
1. Fix ONLY clear transcription errors (homophones, mishearing of technical terms)
2. Do NOT rephrase, rewrite, improve, or restructure any text
3. Do NOT change grammar, punctuation, or sentence structure unless it is the error itself
4. Preserve ALL index numbers and timestamps EXACTLY
5. Return corrected SRT wrapped in <srt></srt> tags — nothing else outside those tags
6. If a segment has no errors, return it unchanged${glossary ? `\n\nDomain context:\n${glossary}` : ''}`
}

function buildAudioSystemPrompt(glossary) {
  return `You are a transcript correction specialist. Each SRT segment may include a [WHISPER:] line — an independent audio transcription of that time range from a second speech-recognition system.

TASK: Produce a corrected SRT using BOTH sources and your contextual knowledge.

DECISION RULES:
1. Original and [WHISPER:] AGREE → almost certainly correct; keep it
2. They DISAGREE → use CONTEXT to decide the correct word:
   • "actor" in cybersecurity/threat-modeling → keep "actor" (threat actor is a real term)
   • "actor" in IAM/authentication context → likely "Okta"; use Whisper as corroboration
   • Weigh the surrounding topic, industry, and sentence before changing anything
3. Whisper clearly says a different word that fits better in context → use it
4. Both sources appear wrong → infer the correct term from knowledge
5. ONLY change genuine transcription errors — never rephrase or restructure

FORMAT:
- Return ONLY the corrected SRT; strip ALL [WHISPER:] lines from output
- Preserve ALL index numbers and timestamps EXACTLY
- Wrap output in <srt></srt> tags${glossary ? `\n\nDomain context:\n${glossary}` : ''}`
}

// ─── SRT helpers ──────────────────────────────────────────────────────────────

function parseSRTSegments(content) {
  const blocks = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim().split(/\n\n+/)
  return blocks.map(block => {
    const lines = block.trim().split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('[WHISPER:'))
    if (lines.length < 3) return null
    return { index: lines[0], timecode: lines[1], text: lines.slice(2).join('\n').trim() }
  }).filter(s => s?.index && s?.timecode && s?.text)
}

function parseTimecode(tc) {
  const [hms, ms = '0'] = tc.split(',')
  const parts = hms.split(':').map(Number)
  const [h = 0, m = 0, s = 0] = parts.length === 3 ? parts : [0, ...parts]
  return h * 3600 + m * 60 + s + Number(ms) / 1000
}

function parseTimecodeRange(timecode) {
  const [a, b] = timecode.split(' --> ')
  return { start: parseTimecode(a.trim()), end: parseTimecode(b.trim()) }
}

function applyCorrections(corrected, original) {
  if (corrected.length === original.length) return corrected
  const byIndex = Object.fromEntries(corrected.map(s => [s.index, s]))
  return original.map(orig => byIndex[orig.index] ?? orig)
}

// ─── Audio conversion ─────────────────────────────────────────────────────────

const MIME_TO_EXT = {
  'audio/aac': 'aac', 'audio/x-aac': 'aac',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'audio/flac': 'flac',
  'audio/webm': 'webm', 'video/webm': 'webm',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'video/x-msvideo': 'avi', 'video/x-matroska': 'mkv',
}

function ffmpegConvert(inputPath, outputPath, opts = {}) {
  return new Promise((resolve, reject) => {
    let cmd = Ffmpeg(inputPath).noVideo()
    if (opts.seek    != null) cmd = cmd.seekInput(opts.seek)
    if (opts.duration != null) cmd = cmd.duration(opts.duration)
    cmd
      .audioCodec('libmp3lame')
      .audioBitrate(`${ENCODE_KBPS}k`)
      .audioChannels(1)
      .audioFrequency(16000)
      .save(outputPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`ffmpeg: ${err.message}`)))
  })
}

// Convert any audio/video to MP3 chunk(s) ready for Whisper
async function convertToMp3Chunks(audioBase64, mimeType) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'tc-'))
  try {
    const ext = MIME_TO_EXT[mimeType] ?? 'bin'
    const inputPath = join(tmpDir, `input.${ext}`)
    const mp3Path   = join(tmpDir, 'full.mp3')

    await writeFile(inputPath, Buffer.from(audioBase64, 'base64'))
    await ffmpegConvert(inputPath, mp3Path)

    const mp3 = await readFile(mp3Path)

    // Small enough for a single Whisper call
    if (mp3.length <= MAX_WHISPER_BYTES) {
      return [{ data: mp3.toString('base64'), mimeType: 'audio/mpeg', startSec: 0 }]
    }

    // Split into chunks using known bitrate to avoid needing ffprobe
    const totalSec    = mp3.length / BYTES_PER_SEC
    const chunkSec    = Math.floor(MAX_WHISPER_BYTES / BYTES_PER_SEC * 0.9)
    const chunks      = []

    for (let start = 0; start < totalSec; start += chunkSec) {
      const chunkPath = join(tmpDir, `chunk-${start}.mp3`)
      const dur = Math.min(chunkSec, totalSec - start)
      await ffmpegConvert(mp3Path, chunkPath, { seek: start, duration: dur })
      chunks.push({
        data:     (await readFile(chunkPath)).toString('base64'),
        mimeType: 'audio/mpeg',
        startSec: start,
      })
    }
    return chunks
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ─── Whisper ──────────────────────────────────────────────────────────────────

async function callWhisper(audioBuffer, baseUrl, apiKey) {
  const blob = new Blob([audioBuffer], { type: 'audio/mpeg' })
  const form = new FormData()
  form.append('file', blob, 'audio.mp3')
  form.append('model', 'whisper-1')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')

  const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message ?? `Whisper error ${res.status}`)
  }
  return res.json()
}

function alignWithWhisper(segments, whisperSegs) {
  return segments.map(seg => {
    const { start, end } = parseTimecodeRange(seg.timecode)
    const overlapping = whisperSegs.filter(w => w.start < end && w.end > start)
    const whisperText = overlapping.map(w => w.text.trim()).join(' ').trim()
    return { ...seg, whisperText: whisperText || null }
  })
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/correct', async (req, res) => {
  const { segments, glossary, apiKey, baseUrl, model = 'claude-opus-4-7' } = req.body
  if (!apiKey)          return res.status(400).json({ error: 'API key is required.' })
  if (!segments?.length) return res.status(400).json({ error: 'No segments provided.' })

  const clientOpts = { apiKey }
  if (baseUrl) clientOpts.baseURL = baseUrl.replace(/\/v1\/messages\/?$/, '')
  const client = new Anthropic(clientOpts)
  const correctedSegments = []

  try {
    for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
      const chunk = segments.slice(i, i + CHUNK_SIZE)
      const n = Math.floor(i / CHUNK_SIZE) + 1
      const total = Math.ceil(segments.length / CHUNK_SIZE)
      const srt = chunk.map(s => `${s.index}\n${s.timecode}\n${s.text}`).join('\n\n')

      const msg = await client.messages.create({
        model, max_tokens: 8096,
        system: [{ type: 'text', text: buildSystemPrompt(glossary), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `Correct this SRT (chunk ${n}/${total}):\n\n<srt>\n${srt}\n</srt>` }],
      })
      const match = msg.content[0].text.match(/<srt>([\s\S]*?)<\/srt>/)
      correctedSegments.push(...applyCorrections(parseSRTSegments((match?.[1] ?? msg.content[0].text).trim()), chunk))
    }
    res.json({ segments: correctedSegments })
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'API error' })
  }
})

app.post('/api/correct-audio', async (req, res) => {
  const { segments, audioData, audioMimeType, glossary, apiKey, baseUrl: rawBase, model = 'claude-opus-4-7' } = req.body
  if (!apiKey)          return res.status(400).json({ error: 'API key is required.' })
  if (!segments?.length) return res.status(400).json({ error: 'No segments provided.' })
  if (!audioData)       return res.status(400).json({ error: 'No audio data provided.' })

  const baseUrl = rawBase ? rawBase.replace(/\/v1\/messages\/?$/, '') : 'https://api.anthropic.com'

  try {
    // 1. Convert to MP3 chunk(s) — handles AAC, M4A, MP4, MOV, WAV, OGG, etc.
    const mp3Chunks = await convertToMp3Chunks(audioData, audioMimeType ?? 'audio/mpeg')

    // 2. Transcribe each chunk with Whisper
    const allWhisperSegs = []
    for (const chunk of mp3Chunks) {
      const result = await callWhisper(Buffer.from(chunk.data, 'base64'), baseUrl, apiKey)
      for (const seg of (result.segments ?? [])) {
        allWhisperSegs.push({ start: seg.start + chunk.startSec, end: seg.end + chunk.startSec, text: seg.text })
      }
    }

    // 3. Align Whisper output with original SRT segments
    const aligned = alignWithWhisper(segments, allWhisperSegs)

    // 4. Claude comparison + correction
    const clientOpts = { apiKey }
    if (rawBase) clientOpts.baseURL = baseUrl
    const client = new Anthropic(clientOpts)
    const correctedSegments = []

    for (let i = 0; i < aligned.length; i += AUDIO_CHUNK_SIZE) {
      const chunk = aligned.slice(i, i + AUDIO_CHUNK_SIZE)
      const n = Math.floor(i / AUDIO_CHUNK_SIZE) + 1
      const total = Math.ceil(aligned.length / AUDIO_CHUNK_SIZE)
      const srt = chunk.map(s => {
        const block = `${s.index}\n${s.timecode}\n${s.text}`
        return s.whisperText ? `${block}\n[WHISPER: ${s.whisperText}]` : block
      }).join('\n\n')

      const msg = await client.messages.create({
        model, max_tokens: 8096,
        system: [{ type: 'text', text: buildAudioSystemPrompt(glossary), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `Correct this SRT (chunk ${n}/${total}):\n\n<srt_with_reference>\n${srt}\n</srt_with_reference>` }],
      })
      const match = msg.content[0].text.match(/<srt>([\s\S]*?)<\/srt>/)
      correctedSegments.push(...applyCorrections(parseSRTSegments((match?.[1] ?? msg.content[0].text).trim()), chunk))
    }

    res.json({ segments: correctedSegments, whisperSegCount: allWhisperSegs.length })
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Unexpected error' })
  }
})

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => {
  console.log(`\n  ◆ Transcript Corrector`)
  console.log(`  → http://localhost:${PORT}\n`)
})
