import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, PhoneOff } from 'lucide-react'

interface Props {
  chipId: string
  callType: 'voice' | 'video'
  phone: string
  onClose: () => void
}

function statusLabel(s: string) {
  switch (s) {
    case 'preparando': return 'Preparando...'
    case 'sincronizando': return 'Sincronizando WhatsApp...'
    case 'autenticando_ligando': return 'Ligando...'
    case 'conectado': return 'Em chamada'
    case 'encerrada': return 'Chamada encerrada'
    default: return 'Conectando...'
  }
}

export default function CallOverlay({ chipId, callType, phone, onClose }: Props) {
  const [status, setStatus] = useState('conectando')
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)

  const canvasRef       = useRef<HTMLCanvasElement>(null)
  const wsRef            = useRef<WebSocket | null>(null)
  const audioCtxRef      = useRef<AudioContext | null>(null)
  const nextPlayTimeRef  = useRef(0)
  const micStreamRef     = useRef<MediaStream | null>(null)
  const micNodeRef       = useRef<ScriptProcessorNode | null>(null)
  const mutedRef         = useRef(false)
  useEffect(() => { mutedRef.current = muted }, [muted])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws/call`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const audioCtx = new AudioContext({ sampleRate: 16000 })
    audioCtxRef.current = audioCtx

    ws.onopen = async () => {
      ws.send(JSON.stringify({ type: 'start', chipId, callType, phone }))
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        micStreamRef.current = stream
        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        micNodeRef.current = processor
        processor.onaudioprocess = (e) => {
          if (mutedRef.current || ws.readyState !== WebSocket.OPEN) return
          const input = e.inputBuffer.getChannelData(0)
          const pcm = new Int16Array(input.length)
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]))
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
          }
          ws.send(pcm.buffer)
        }
        // ScriptProcessorNode só dispara conectado até o destino — usa ganho
        // zero pra não tocar o próprio microfone de volta pro operador.
        const silentGain = audioCtx.createGain()
        silentGain.gain.value = 0
        source.connect(processor)
        processor.connect(silentGain)
        silentGain.connect(audioCtx.destination)
      } catch (e: any) {
        setError('Microfone indisponível: ' + e.message)
      }
    }

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'status') setStatus(msg.status)
          if (msg.type === 'error') setError(msg.error)
        } catch { /* ignore */ }
        return
      }

      const buf = new Uint8Array(event.data as ArrayBuffer)
      const frameType = buf[0]
      const payload = buf.subarray(1)

      if (frameType === 1) {
        // frame de vídeo (JPEG)
        const blob = new Blob([payload], { type: 'image/jpeg' })
        const url = URL.createObjectURL(blob)
        const img = new Image()
        img.onload = () => {
          const canvas = canvasRef.current
          if (canvas) {
            canvas.width = img.width
            canvas.height = img.height
            canvas.getContext('2d')?.drawImage(img, 0, 0)
          }
          URL.revokeObjectURL(url)
        }
        img.src = url
      } else if (frameType === 2) {
        // chunk de áudio PCM16 mono 16kHz
        const pcm = new Int16Array(payload.buffer, payload.byteOffset, Math.floor(payload.byteLength / 2))
        const float32 = new Float32Array(pcm.length)
        for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 0x8000
        const audioBuffer = audioCtx.createBuffer(1, float32.length, 16000)
        audioBuffer.copyToChannel(float32, 0)
        const src = audioCtx.createBufferSource()
        src.buffer = audioBuffer
        src.connect(audioCtx.destination)
        const now = audioCtx.currentTime
        const startAt = Math.max(now, nextPlayTimeRef.current)
        src.start(startAt)
        nextPlayTimeRef.current = startAt + audioBuffer.duration
      }
    }

    ws.onerror = () => setError('Erro de conexão com a chamada')
    ws.onclose = () => setStatus(prev => prev === 'encerrada' ? prev : 'encerrada')

    return () => {
      try { ws.send(JSON.stringify({ type: 'stop' })) } catch { /* ignore */ }
      ws.close()
      micStreamRef.current?.getTracks().forEach(t => t.stop())
      micNodeRef.current?.disconnect()
      audioCtx.close().catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipId, callType, phone])

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center">
      <div className="text-white text-sm mb-2">{statusLabel(status)}</div>
      {error && <div className="text-red-400 text-xs mb-2 max-w-md text-center px-4">{error}</div>}
      <canvas ref={canvasRef} className="max-w-[90vw] max-h-[70vh] bg-gray-900 rounded-lg" />
      <div className="flex gap-4 mt-6">
        <button onClick={() => setMuted(m => !m)}
          className={`p-3 rounded-full ${muted ? 'bg-gray-600' : 'bg-gray-800'} text-white hover:opacity-80`}>
          {muted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        <button onClick={onClose} className="p-3 rounded-full bg-red-600 text-white hover:bg-red-500">
          <PhoneOff size={18} />
        </button>
      </div>
    </div>
  )
}
