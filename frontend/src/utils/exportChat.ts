import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import type { Contact, Message, Conversation } from '../types'

function cleanPhone(contact: Contact): string {
  return (contact.waNumber || contact.phone).replace(/@[^@]+$/, '').replace(/\D/g, '')
}

function buildHTML(contact: Contact, messages: Message[]): string {
  const phone = cleanPhone(contact)
  const rows: string[] = []
  let lastDate = ''

  for (const msg of messages) {
    const ts = new Date(msg.timestamp)
    const dateKey = format(ts, 'yyyy-MM-dd')

    if (dateKey !== lastDate) {
      lastDate = dateKey
      const label = format(ts, "d 'de' MMMM 'de' yyyy", { locale: ptBR })
      rows.push(`
        <div style="display:flex;justify-content:center;margin:10px 0 6px;">
          <div style="background:#1f2c34;color:#8696a0;font-size:11px;padding:5px 12px;border-radius:8px;letter-spacing:.3px;">
            ${label}
          </div>
        </div>`)
    }

    const isOut = msg.direction === 'outbound'
    const text  = (msg.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')
    const time  = format(ts, 'HH:mm')

    rows.push(`
      <div style="display:flex;justify-content:${isOut ? 'flex-end' : 'flex-start'};margin-bottom:3px;padding:0 10px;">
        <div style="
          background:${isOut ? '#005c4b' : '#202c33'};
          color:#e9edef;
          padding:6px 9px 4px 9px;
          border-radius:${isOut ? '10px 2px 10px 10px' : '2px 10px 10px 10px'};
          max-width:74%;
          min-width:56px;
          font-size:13.5px;
          line-height:1.45;
          word-break:break-word;
        ">
          <div style="margin-bottom:2px;">${text}</div>
          <div style="font-size:10px;color:#8696a0;text-align:right;white-space:nowrap;">${time}</div>
        </div>
      </div>`)
  }

  const initial = contact.name[0]?.toUpperCase() || '?'

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;">
<div id="__chat__" style="
  width:400px;
  background:#0b1f15;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;
  padding-bottom:20px;
">
  <div style="background:#1f2c34;padding:12px 16px;display:flex;align-items:center;gap:13px;border-bottom:1px solid #2a3942;">
    <div style="width:44px;height:44px;border-radius:50%;background:#3b4a54;display:flex;align-items:center;justify-content:center;color:#e9edef;font-weight:700;font-size:19px;flex-shrink:0;">${initial}</div>
    <div>
      <div style="color:#e9edef;font-weight:600;font-size:15px;line-height:1.2;">${contact.name}</div>
      <div style="color:#8696a0;font-size:12px;margin-top:2px;">${phone}</div>
    </div>
    <div style="margin-left:auto;color:#8696a0;font-size:10px;">${format(new Date(), "dd/MM/yyyy 'às' HH:mm")}</div>
  </div>
  <div style="padding-top:10px;">${rows.join('\n')}</div>
</div>
</body></html>`
}

async function renderToPDF(container: HTMLElement, doc: jsPDF, firstPage: boolean) {
  const canvas = await html2canvas(container, {
    backgroundColor: '#0b1f15',
    scale: 2,
    useCORS: true,
    logging: false,
    allowTaint: true,
  })

  const PAGE_W = 210  // mm A4
  const PAGE_H = 297
  const imgW    = canvas.width
  const imgH    = canvas.height
  const ratio   = PAGE_W / imgW          // mm per pixel
  const sliceHpx = Math.floor(PAGE_H / ratio)  // pixels that fit per A4 page

  let yPx = 0
  let pageIdx = 0

  while (yPx < imgH) {
    if (pageIdx > 0 || !firstPage) doc.addPage()

    const hPx = Math.min(sliceHpx, imgH - yPx)
    const slice = document.createElement('canvas')
    slice.width  = imgW
    slice.height = hPx
    const ctx = slice.getContext('2d')!
    ctx.drawImage(canvas, 0, yPx, imgW, hPx, 0, 0, imgW, hPx)

    doc.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, PAGE_W, hPx * ratio)
    yPx += hPx
    pageIdx++
  }
}

export async function exportChatToPDF(contact: Contact, messages: Message[]) {
  if (!messages.length) { alert('Nenhuma mensagem para exportar.'); return }

  const sorted = [...messages].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:420px;height:800px;border:none;visibility:hidden;'
  document.body.appendChild(iframe)

  try {
    const iDoc = iframe.contentDocument!
    iDoc.open()
    iDoc.write(buildHTML(contact, sorted))
    iDoc.close()

    await new Promise(r => setTimeout(r, 200))

    const root = iDoc.getElementById('__chat__') as HTMLElement
    const doc  = new jsPDF({ format: 'a4', unit: 'mm', compress: true })

    await renderToPDF(root, doc, true)

    const file = `${cleanPhone(contact)}.pdf`
    doc.save(file)
  } finally {
    document.body.removeChild(iframe)
  }
}

export async function exportAllChatsToPDF(
  contacts: Contact[],
  conversations: Conversation[],
  messages: Message[],
  onProgress?: (done: number, total: number, name: string) => void,
) {
  const pairs = contacts
    .map(c => {
      const conv = conversations.find(cv => cv.contactId === c.id)
      if (!conv) return null
      const msgs = messages.filter(m => m.conversationId === conv.id)
      if (!msgs.length) return null
      return { contact: c, messages: msgs }
    })
    .filter(Boolean) as { contact: Contact; messages: Message[] }[]

  if (!pairs.length) { alert('Nenhuma conversa com mensagens encontrada.'); return }

  for (let i = 0; i < pairs.length; i++) {
    const { contact, messages: msgs } = pairs[i]
    onProgress?.(i + 1, pairs.length, contact.name)
    await exportChatToPDF(contact, msgs)
    await new Promise(r => setTimeout(r, 600))
  }
}
