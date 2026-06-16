import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { writeFile, readFile, rm, mkdtemp } from 'fs/promises'
import { existsSync } from 'fs'
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
const MAX_WHISPER_BYTES = 24 * 1024 * 1024
const ENCODE_KBPS      = 64
const BYTES_PER_SEC    = (ENCODE_KBPS * 1000) / 8

// ─── SSE helper ──────────────────────────────────────────────────────────────

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type':       'text/event-stream',
    'Cache-Control':      'no-cache',
    'Connection':         'keep-alive',
    'X-Accel-Buffering':  'no',   // prevent nginx from buffering SSE
  })
  res.flushHeaders()  // force headers through reverse proxies immediately

  // Send a comment ping every 5s to prevent proxy idle-timeout disconnects
  const keepalive = setInterval(() => res.write(': ping\n\n'), 5000)

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  return {
    log:       (message, level = 'info') => send({ type: 'log', message, level }),
    progress:  (pct, label)             => send({ type: 'progress', pct, label }),
    pipeline:  steps                    => send({ type: 'pipeline', steps }),
    stepStart: id                       => send({ type: 'step_start', id }),
    stepDone:  id                       => send({ type: 'step_done',  id }),
    stepError: id                       => send({ type: 'step_error', id }),
    result:    data                     => send({ type: 'result', ...data }),
    error:     message                  => send({ type: 'error', message }),
    end:       ()                       => { clearInterval(keepalive); res.end() },
  }
}

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
    if (opts.seek     != null) cmd = cmd.seekInput(opts.seek)
    if (opts.duration != null) cmd = cmd.duration(opts.duration)
    const stderrLines = []
    cmd
      .audioCodec('libmp3lame')
      .audioBitrate(`${ENCODE_KBPS}k`)
      .audioChannels(1)
      .audioFrequency(16000)
      .save(outputPath)
      .on('stderr', line => stderrLines.push(line))
      .on('end', resolve)
      .on('error', err => {
        const detail = stderrLines.slice(-3).join(' | ')
        reject(new Error(`ffmpeg: ${err.message}${detail ? ` [${detail}]` : ''}`))
      })
  })
}

async function convertToMp3Chunks(audioBase64, mimeType, emit) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'tc-'))
  try {
    const ext       = MIME_TO_EXT[mimeType] ?? 'bin'
    const inputPath = join(tmpDir, `input.${ext}`)
    const mp3Path   = join(tmpDir, 'full.mp3')

    emit.log(`Converting ${ext.toUpperCase()} → MP3 (${ENCODE_KBPS}kbps mono 16kHz)…`)
    await writeFile(inputPath, Buffer.from(audioBase64, 'base64'))
    await ffmpegConvert(inputPath, mp3Path)

    const mp3 = await readFile(mp3Path)
    emit.log(`Conversion complete — ${(mp3.length / 1024 / 1024).toFixed(1)} MB`)

    if (mp3.length <= MAX_WHISPER_BYTES) {
      return [{ data: mp3.toString('base64'), mimeType: 'audio/mpeg', startSec: 0 }]
    }

    const totalSec  = mp3.length / BYTES_PER_SEC
    const chunkSec  = Math.floor(MAX_WHISPER_BYTES / BYTES_PER_SEC * 0.9)
    const numChunks = Math.ceil(totalSec / chunkSec)
    emit.log(`Audio too large for one request — splitting into ${numChunks} chunks…`)

    const chunks = []
    for (let start = 0; start < totalSec; start += chunkSec) {
      const chunkPath = join(tmpDir, `chunk-${start}.mp3`)
      const dur = Math.min(chunkSec, totalSec - start)
      await ffmpegConvert(mp3Path, chunkPath, { seek: start, duration: dur })
      chunks.push({ data: (await readFile(chunkPath)).toString('base64'), mimeType: 'audio/mpeg', startSec: start })
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
    const body = await res.text().catch(() => '')
    let msg = `Whisper HTTP ${res.status}`
    try { msg = JSON.parse(body).error?.message ?? msg } catch {}
    throw new Error(`${msg} — URL: ${baseUrl}/v1/audio/transcriptions — body: ${body.slice(0, 200)}`)
  }
  return res.json()
}

function alignWithWhisper(segments, whisperSegs) {
  return segments.map(seg => {
    const { start, end } = parseTimecodeRange(seg.timecode)
    const overlapping = whisperSegs.filter(w => w.start < end && w.end > start)
    return { ...seg, whisperText: overlapping.map(w => w.text.trim()).join(' ').trim() || null }
  })
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/correct', async (req, res) => {
  const emit = openSSE(res)
  const { segments, glossary, apiKey, baseUrl, model = 'claude-opus-4-7' } = req.body

  if (!apiKey)           { emit.error('API key is required.'); return emit.end() }
  if (!segments?.length) { emit.error('No segments provided.'); return emit.end() }

  const totalChunks = Math.ceil(segments.length / CHUNK_SIZE)

  emit.pipeline([
    { id: 'prepare', label: `Prepare — ${segments.length} segments, ${totalChunks} chunk${totalChunks !== 1 ? 's' : ''}` },
    ...Array.from({ length: totalChunks }, (_, i) => ({
      id:    `claude_${i + 1}`,
      label: `Claude correction — chunk ${i + 1} of ${totalChunks}`,
    })),
    { id: 'done', label: 'Complete' },
  ])

  const clientOpts = { apiKey }
  if (baseUrl) clientOpts.baseURL = baseUrl.replace(/\/v1\/messages\/?$/, '')
  const client = new Anthropic(clientOpts)
  const correctedSegments = []

  try {
    emit.stepStart('prepare')
    emit.log(`${segments.length} segments — ${totalChunks} chunk${totalChunks !== 1 ? 's' : ''} to send`)
    emit.progress(5, 'Starting…')
    emit.stepDone('prepare')

    for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
      const chunk = segments.slice(i, i + CHUNK_SIZE)
      const n = Math.floor(i / CHUNK_SIZE) + 1
      emit.stepStart(`claude_${n}`)
      emit.log(`Sending chunk ${n}/${totalChunks} to Claude (${chunk.length} segments)…`)
      emit.progress(5 + Math.round((n - 1) / totalChunks * 88), `Claude: chunk ${n}/${totalChunks}`)

      const msg = await client.messages.create({
        model, max_tokens: 8096,
        system: [{ type: 'text', text: buildSystemPrompt(glossary), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `Correct this SRT (chunk ${n}/${totalChunks}):\n\n<srt>\n${chunk.map(s => `${s.index}\n${s.timecode}\n${s.text}`).join('\n\n')}\n</srt>` }],
      })

      const match = msg.content[0].text.match(/<srt>([\s\S]*?)<\/srt>/)
      correctedSegments.push(...applyCorrections(parseSRTSegments((match?.[1] ?? msg.content[0].text).trim()), chunk))
      emit.stepDone(`claude_${n}`)
      emit.log(`Chunk ${n}/${totalChunks} complete`, 'success')
    }

    emit.stepStart('done')
    emit.progress(100, 'Done')
    emit.log(`All done — ${correctedSegments.length} segments corrected`, 'success')
    emit.stepDone('done')
    emit.result({ segments: correctedSegments })
  } catch (err) {
    // Mark the currently-active step as errored
    emit.log(err.message ?? 'Unexpected error', 'error')
    emit.error(err.message ?? 'Unexpected error')
  }

  emit.end()
})

app.post('/api/correct-audio', async (req, res) => {
  const emit = openSSE(res)
  const { segments, audioData, audioMimeType, glossary, apiKey, baseUrl: rawBase, model = 'claude-opus-4-7' } = req.body

  if (!apiKey)           { emit.error('API key is required.'); return emit.end() }
  if (!segments?.length) { emit.error('No segments provided.'); return emit.end() }
  if (!audioData)        { emit.error('No audio data provided.'); return emit.end() }

  // Fail fast with a clear message if the server environment can't handle audio
  const diag = systemDiagnostics()
  if (!diag.audioCapable) {
    const msg = diag.warnings.join(' | ')
    emit.error(`Server environment cannot process audio: ${msg}`)
    return emit.end()
  }

  const baseUrl = rawBase ? rawBase.replace(/\/v1\/messages\/?$/, '') : 'https://api.anthropic.com'

  // Emit an initial skeleton pipeline — chunk counts unknown until after conversion
  emit.pipeline([
    { id: 'read',    label: 'Read audio file' },
    { id: 'convert', label: 'Convert to MP3 (64kbps mono 16kHz)' },
    { id: 'whisper', label: 'Whisper transcription' },
    { id: 'align',   label: 'Align transcripts by timecode' },
    { id: 'claude',  label: 'Claude comparison' },
    { id: 'done',    label: 'Complete' },
  ])

  try {
    // Step: read
    emit.stepStart('read')
    emit.log(`Audio file received (${audioMimeType})`)
    emit.progress(2, 'Reading audio…')
    emit.stepDone('read')

    // Step: convert
    emit.stepStart('convert')
    const mp3Chunks = await convertToMp3Chunks(audioData, audioMimeType ?? 'audio/mpeg', emit)
    emit.stepDone('convert')

    // Now we know chunk counts — expand the pipeline in place
    const numClaudeChunks = Math.ceil(segments.length / AUDIO_CHUNK_SIZE)
    emit.pipeline([
      { id: 'read',    label: 'Read audio file',                 status: 'done' },
      { id: 'convert', label: 'Convert to MP3',                  status: 'done' },
      ...mp3Chunks.map((_, i) => ({
        id:    `whisper_${i + 1}`,
        label: `Whisper transcription — chunk ${i + 1} of ${mp3Chunks.length}`,
      })),
      { id: 'align', label: 'Align transcripts by timecode' },
      ...Array.from({ length: numClaudeChunks }, (_, i) => ({
        id:    `claude_${i + 1}`,
        label: `Claude comparison — chunk ${i + 1} of ${numClaudeChunks}`,
      })),
      { id: 'done', label: 'Complete' },
    ])

    // Steps: whisper
    const allWhisperSegs = []
    for (let i = 0; i < mp3Chunks.length; i++) {
      emit.stepStart(`whisper_${i + 1}`)
      emit.log(`Transcribing with Whisper (chunk ${i + 1}/${mp3Chunks.length})…`)
      emit.progress(20 + Math.round(i / mp3Chunks.length * 28), `Whisper: ${i + 1}/${mp3Chunks.length}`)

      const result = await callWhisper(Buffer.from(mp3Chunks[i].data, 'base64'), baseUrl, apiKey)
      for (const seg of (result.segments ?? [])) {
        allWhisperSegs.push({ start: seg.start + mp3Chunks[i].startSec, end: seg.end + mp3Chunks[i].startSec, text: seg.text })
      }
      emit.stepDone(`whisper_${i + 1}`)
      emit.log(`Whisper chunk ${i + 1} complete — ${result.segments?.length ?? 0} segments`, 'success')
    }

    emit.log(`Whisper transcript ready — ${allWhisperSegs.length} total segments`)

    // Step: align
    emit.stepStart('align')
    emit.progress(50, 'Aligning…')
    emit.log('Aligning Whisper output with original SRT by timecode…')
    const aligned = alignWithWhisper(segments, allWhisperSegs)
    const withRef = aligned.filter(s => s.whisperText).length
    emit.log(`Alignment complete — ${withRef}/${aligned.length} segments have Whisper reference`)
    emit.stepDone('align')

    // Steps: claude
    const clientOpts = { apiKey }
    if (rawBase) clientOpts.baseURL = baseUrl
    const client = new Anthropic(clientOpts)
    const correctedSegments = []

    for (let i = 0; i < aligned.length; i += AUDIO_CHUNK_SIZE) {
      const chunk = aligned.slice(i, i + AUDIO_CHUNK_SIZE)
      const n = Math.floor(i / AUDIO_CHUNK_SIZE) + 1
      emit.stepStart(`claude_${n}`)
      emit.log(`Sending to Claude for comparison (chunk ${n}/${numClaudeChunks}, ${chunk.length} segments)…`)
      emit.progress(52 + Math.round((n - 1) / numClaudeChunks * 44), `Claude: ${n}/${numClaudeChunks}`)

      const srt = chunk.map(s => {
        const block = `${s.index}\n${s.timecode}\n${s.text}`
        return s.whisperText ? `${block}\n[WHISPER: ${s.whisperText}]` : block
      }).join('\n\n')

      const msg = await client.messages.create({
        model, max_tokens: 8096,
        system: [{ type: 'text', text: buildAudioSystemPrompt(glossary), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `Correct this SRT (chunk ${n}/${numClaudeChunks}):\n\n<srt_with_reference>\n${srt}\n</srt_with_reference>` }],
      })

      const match = msg.content[0].text.match(/<srt>([\s\S]*?)<\/srt>/)
      correctedSegments.push(...applyCorrections(parseSRTSegments((match?.[1] ?? msg.content[0].text).trim()), chunk))
      emit.stepDone(`claude_${n}`)
      emit.log(`Claude chunk ${n}/${numClaudeChunks} complete`, 'success')
    }

    emit.stepStart('done')
    emit.progress(100, 'Done')
    emit.log(`All done — ${correctedSegments.length} segments corrected`, 'success')
    emit.stepDone('done')
    emit.result({ segments: correctedSegments, whisperSegCount: allWhisperSegs.length })
  } catch (err) {
    emit.log(err.message ?? 'Unexpected error', 'error')
    emit.error(err.message ?? 'Unexpected error')
  }

  emit.end()
})

// ─── Health check ─────────────────────────────────────────────────────────────

function systemDiagnostics() {
  const nodeVer  = process.version
  const nodeMaj  = parseInt(nodeVer.slice(1))
  const hasFetch = typeof fetch !== 'undefined'
  const hasBlob  = typeof Blob  !== 'undefined'
  const hasForm  = typeof FormData !== 'undefined'
  const ffmpegOk = ffmpegBin && existsSync(ffmpegBin)

  return {
    node:    nodeVer,
    platform: process.platform,
    arch:    process.arch,
    ffmpegPath: ffmpegBin ?? null,
    ffmpegExists: ffmpegOk,
    nativeFetch:    hasFetch,
    nativeBlob:     hasBlob,
    nativeFormData: hasForm,
    audioCapable:   hasFetch && hasBlob && hasForm && ffmpegOk,
    warnings: [
      nodeMaj < 18  && `Node ${nodeVer} detected — native fetch/Blob/FormData require Node 18+. Audio correction WILL FAIL.`,
      !ffmpegOk     && `ffmpeg binary not found at ${ffmpegBin}. Audio conversion WILL FAIL. Re-run: npm install`,
      !hasFetch     && 'globalThis.fetch unavailable — audio correction will fail.',
      !hasBlob      && 'globalThis.Blob unavailable — audio correction will fail.',
      !hasForm      && 'globalThis.FormData unavailable — audio correction will fail.',
    ].filter(Boolean),
  }
}

app.get('/api/health', (_req, res) => {
  const diag = systemDiagnostics()
  res.status(diag.audioCapable ? 200 : 503).json(diag)
})

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => {
  console.log(`\n  ◆ Transcript Corrector  →  http://localhost:${PORT}`)

  const diag = systemDiagnostics()
  console.log(`  Node ${diag.node}  |  ${diag.platform}/${diag.arch}`)
  console.log(`  ffmpeg  : ${diag.ffmpegExists ? diag.ffmpegPath : '✗ NOT FOUND'}`)
  console.log(`  fetch   : ${diag.nativeFetch    ? '✓' : '✗ missing (Node 18+ required)'}`)
  console.log(`  Blob    : ${diag.nativeBlob     ? '✓' : '✗ missing'}`)
  console.log(`  FormData: ${diag.nativeFormData ? '✓' : '✗ missing'}`)

  if (diag.warnings.length) {
    console.log('\n  ⚠ Warnings:')
    diag.warnings.forEach(w => console.log(`    • ${w}`))
  }
  console.log()
})
