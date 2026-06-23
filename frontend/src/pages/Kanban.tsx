import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import type { KanbanCard, KanbanColumn } from '../types'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core'
import {
  SortableContext, useSortable,
  verticalListSortingStrategy, horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Plus, X, DollarSign, Calendar, GripVertical, Pencil, Check, MessageSquare,
} from 'lucide-react'
import { v4 as uuid } from '../utils/uuid'

const COLORS = [
  '#6366f1', '#f59e0b', '#3b82f6', '#10b981',
  '#ec4899', '#8b5cf6', '#f97316', '#ef4444', '#14b8a6',
]

function localDateStr(offset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtDate(iso: string): string {
  const [y, m, day] = iso.split('-')
  return `${day}/${m}/${y.slice(2)}`
}

// ── Card ─────────────────────────────────────────────────────────────────────

function KanbanCardItem({ card }: { card: KanbanCard & { contactName?: string } }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id })
  const navigate = useNavigate()
  const { setActiveConversation } = useStore()

  function openChat(e: React.MouseEvent) {
    e.stopPropagation()
    if (!card.conversationId) return
    setActiveConversation(card.conversationId)
    navigate('/messages')
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      {...attributes} {...listeners}
      className="bg-gray-800 border border-gray-700 rounded-lg p-3 cursor-grab active:cursor-grabbing select-none"
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-sm font-medium text-white leading-snug flex-1">{card.title}</p>
        {card.conversationId && (
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={openChat}
            title="Abrir conversa"
            className="shrink-0 p-1 rounded-md text-gray-500 hover:text-indigo-400 hover:bg-gray-700 transition-colors cursor-pointer"
          >
            <MessageSquare size={13} />
          </button>
        )}
      </div>
      {card.contactName && <p className="text-xs text-gray-400 mb-1">{card.contactName}</p>}
      <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
        {card.value != null && (
          <span className="flex items-center gap-1 text-emerald-400">
            <DollarSign size={10} />
            {card.value.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </span>
        )}
        {card.dueDate && (
          <span className="flex items-center gap-1">
            <Calendar size={10} />
            {fmtDate(card.dueDate)}
          </span>
        )}
      </div>
      {card.tags && card.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {card.tags.map(t => (
            <span key={t} className="px-1.5 py-0.5 bg-gray-700 text-gray-300 rounded text-[10px]">{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Column ────────────────────────────────────────────────────────────────────

function KanbanColumnItem({ column, cards, contacts, onAddCard, onRemove, onSaveEdit }: {
  column: KanbanColumn
  cards: KanbanCard[]
  contacts: any[]
  onAddCard: (colId: string) => void
  onRemove: (id: string) => void
  onSaveEdit: (id: string, data: Partial<KanbanColumn>) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: column.id })

  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(column.title)
  const [editColor, setEditColor] = useState(column.color)

  const sorted = [...cards].sort((a, b) => a.order - b.order)
  const total = cards.reduce((s, c) => s + (c.value ?? 0), 0)

  function saveEdit() {
    if (editTitle.trim()) onSaveEdit(column.id, { title: editTitle.trim(), color: editColor })
    setEditing(false)
  }

  function startEdit() {
    setEditTitle(column.title)
    setEditColor(column.color)
    setEditing(true)
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.45 : 1, height: 'calc(100vh - 160px)' }}
      className="w-64 shrink-0 bg-gray-900 border border-gray-800 rounded-xl flex flex-col"
    >
      <div className="flex items-center gap-1.5 p-3 border-b border-gray-800">
        <div
          {...attributes} {...listeners}
          className="cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-400 touch-none shrink-0 p-0.5"
        >
          <GripVertical size={14} />
        </div>

        {!editing ? (
          <>
            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: column.color }} />
            <span className="text-sm font-medium text-white flex-1 truncate">{column.title}</span>
            <span className="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded shrink-0">{cards.length}</span>
            <button onClick={startEdit} className="text-gray-600 hover:text-indigo-400 transition-colors shrink-0">
              <Pencil size={12} />
            </button>
            <button onClick={() => onRemove(column.id)} className="text-gray-600 hover:text-red-400 transition-colors shrink-0">
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <input
              autoFocus
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(false) }}
              className="flex-1 min-w-0 bg-gray-800 border border-indigo-500 rounded px-2 py-0.5 text-sm text-white focus:outline-none"
            />
            <button onClick={saveEdit} className="text-green-400 hover:text-green-300 shrink-0"><Check size={14} /></button>
            <button onClick={() => setEditing(false)} className="text-gray-500 hover:text-gray-300 shrink-0"><X size={14} /></button>
          </>
        )}
      </div>

      {editing && (
        <div className="flex flex-wrap gap-1.5 px-3 py-2.5 border-b border-gray-800 bg-gray-800/40">
          {COLORS.map(c => (
            <button
              key={c}
              onClick={() => setEditColor(c)}
              className={`w-5 h-5 rounded-full transition-transform hover:scale-110 ${
                editColor === c ? 'ring-2 ring-white ring-offset-1 ring-offset-gray-900 scale-110' : ''
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
      )}

      {total > 0 && (
        <div className="px-3 py-1.5 border-b border-gray-800 text-xs text-emerald-400">
          R$ {total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
        </div>
      )}

      <SortableContext items={sorted.map(c => c.id)} strategy={verticalListSortingStrategy}>
        <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
          {sorted.map(card => {
            const contact = contacts.find((ct: any) => ct.id === card.contactId)
            return <KanbanCardItem key={card.id} card={{ ...card, contactName: contact?.name }} />
          })}
        </div>
      </SortableContext>

      <div className="p-2 border-t border-gray-800 shrink-0">
        <button
          onClick={() => onAddCard(column.id)}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg"
        >
          <Plus size={13} /> Adicionar card
        </button>
      </div>
    </div>
  )
}

// ── AddCardModal ──────────────────────────────────────────────────────────────

function AddCardModal({ columnId, onClose, onSave }: {
  columnId: string
  onClose: () => void
  onSave: (card: KanbanCard) => void
}) {
  const { contacts } = useStore()
  const [title, setTitle] = useState('')
  const [contactId, setContactId] = useState('')
  const [value, setValue] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [tags, setTags] = useState('')

  function save() {
    if (!title.trim()) return
    onSave({
      id: uuid(), conversationId: '', contactId,
      columnId, title: title.trim(),
      value: value ? parseFloat(value) : undefined,
      dueDate: dueDate || undefined,
      tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      order: Date.now(),
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm">
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h3 className="font-medium text-white text-sm">Novo Card</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3">
          <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            placeholder="Título do card *" autoFocus />
          <select value={contactId} onChange={e => setContactId(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
            <option value="">Selecionar contato</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input value={value} onChange={e => setValue(e.target.value)} type="number" min="0" step="0.01"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            placeholder="Valor (R$)" />
          <input value={dueDate} onChange={e => setDueDate(e.target.value)} type="date"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
          <input value={tags} onChange={e => setTags(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            placeholder="Tags (separadas por vírgula)" />
        </div>
        <div className="flex gap-2 p-4 border-t border-gray-800 justify-end">
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancelar</button>
          <button onClick={save} className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg">Salvar</button>
        </div>
      </div>
    </div>
  )
}

// ── Kanban Page ───────────────────────────────────────────────────────────────

type QuickFilter = 'today' | 'yesterday' | null

export default function Kanban() {
  const {
    kanbanColumns, kanbanCards, contacts, conversations,
    addKanbanColumn, updateKanbanColumn, removeKanbanColumn,
    addKanbanCard, moveCard,
  } = useStore()

  const [addCard, setAddCard] = useState<string | null>(null)
  const [newColName, setNewColName] = useState('')
  const [showAddCol, setShowAddCol] = useState(false)
  const [activeCardId, setActiveCardId] = useState<string | null>(null)
  const [activeColId, setActiveColId]   = useState<string | null>(null)

  // Filters — quick OR manual range (mutually exclusive)
  const [quickFilter, setQuickFilter] = useState<QuickFilter>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  // Exclui cards de grupos (@g.us)
  const groupContactIds = new Set(
    contacts.filter(c => c.phone?.endsWith('@g.us')).map(c => c.id)
  )
  const allCards = (Array.isArray(kanbanCards) ? kanbanCards : [])
    .filter(card => !groupContactIds.has(card.contactId))
  const sortedColumns = [...(Array.isArray(kanbanColumns) ? kanbanColumns : [])].sort((a, b) => a.order - b.order)
  const columnIds     = sortedColumns.map(c => c.id)

  const visibleCards = useMemo(() => {
    let from = dateFrom
    let to   = dateTo

    if (quickFilter === 'today') {
      const d = localDateStr(0)
      from = d; to = d
    } else if (quickFilter === 'yesterday') {
      const d = localDateStr(-1)
      from = d; to = d
    }

    if (!from && !to) return allCards

    return allCards.filter(card => {
      // Filtra pela data da última mensagem da conversa vinculada
      const conv = card.conversationId
        ? conversations.find(c => c.id === card.conversationId)
        : null
      const dateStr = conv?.lastMessageAt
        ? conv.lastMessageAt.slice(0, 10)   // "YYYY-MM-DD"
        : null
      if (!dateStr) return true             // sem conversa → sempre mostra
      if (from && dateStr < from) return false
      if (to   && dateStr > to)   return false
      return true
    })
  }, [allCards, conversations, quickFilter, dateFrom, dateTo])

  const hasFilter  = quickFilter !== null || dateFrom || dateTo
  const totalValue = visibleCards.reduce((s, c) => s + (c.value ?? 0), 0)

  function clearFilter() {
    setQuickFilter(null)
    setDateFrom('')
    setDateTo('')
  }

  // ── Drag handlers ───────────────────────────────────────────────────────────

  function handleDragStart(e: DragStartEvent) {
    const id = String(e.active.id)
    if (sortedColumns.some(c => c.id === id)) {
      setActiveColId(id)
      setActiveCardId(null)
    } else {
      setActiveCardId(id)
      setActiveColId(null)
    }
  }

  function handleDragOver(e: DragOverEvent) {
    if (activeColId) return
    const { active, over } = e
    if (!over) return
    const card = allCards.find(c => c.id === active.id)
    if (!card) return
    const overColumn = sortedColumns.find(c => c.id === over.id)
    if (overColumn && card.columnId !== overColumn.id) {
      moveCard(card.id, overColumn.id, Date.now())
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e

    if (activeColId) {
      if (over && active.id !== over.id) {
        const oldIdx = sortedColumns.findIndex(c => c.id === active.id)
        const newIdx = sortedColumns.findIndex(c => c.id === over.id)
        if (oldIdx !== -1 && newIdx !== -1) {
          arrayMove(sortedColumns, oldIdx, newIdx).forEach((col, idx) => {
            if (col.order !== idx) updateKanbanColumn(col.id, { order: idx })
          })
        }
      }
      setActiveColId(null)
      return
    }

    setActiveCardId(null)
    if (!over || active.id === over.id) return
    const card = allCards.find(c => c.id === active.id)
    if (!card) return
    const overCard   = allCards.find(c => c.id === over.id)
    const overColumn = sortedColumns.find(c => c.id === over.id)
    if (overCard)        moveCard(card.id, overCard.columnId, overCard.order - 0.5)
    else if (overColumn) moveCard(card.id, overColumn.id, Date.now())
  }

  function addColumn() {
    if (!newColName.trim()) return
    addKanbanColumn({
      id: uuid(), title: newColName.trim(),
      color: COLORS[sortedColumns.length % COLORS.length],
      order: sortedColumns.length,
    })
    setNewColName('')
    setShowAddCol(false)
  }

  const activeCard = activeCardId ? allCards.find(c => c.id === activeCardId) : null
  const activeCol  = activeColId  ? sortedColumns.find(c => c.id === activeColId) : null

  return (
    <div className="flex flex-col" style={{ height: '100%' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-gray-800 bg-gray-900 shrink-0 px-4 pt-4 pb-3">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-semibold text-white">Pipeline de Vendas</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {visibleCards.length} card{visibleCards.length !== 1 ? 's' : ''}
              {hasFilter ? ` de ${allCards.length}` : ''} · R$ {totalValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </p>
          </div>
          <button
            onClick={() => setShowAddCol(true)}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg"
          >
            <Plus size={15} /> Nova Coluna
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 shrink-0">Última mensagem:</span>

          <button
            onClick={() => setQuickFilter(quickFilter === 'today' ? null : 'today')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
              quickFilter === 'today'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
            }`}
          >
            Hoje
          </button>

          <button
            onClick={() => setQuickFilter(quickFilter === 'yesterday' ? null : 'yesterday')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
              quickFilter === 'yesterday'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
            }`}
          >
            Ontem
          </button>

          <div className="flex items-center gap-1.5 ml-1">
            <input
              type="date"
              value={dateFrom}
              onChange={e => { setDateFrom(e.target.value); setQuickFilter(null) }}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
            />
            <span className="text-xs text-gray-600">—</span>
            <input
              type="date"
              value={dateTo}
              onChange={e => { setDateTo(e.target.value); setQuickFilter(null) }}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500"
            />
          </div>

          {hasFilter && (
            <button
              onClick={clearFilter}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 px-2 py-1 bg-red-900/20 rounded-lg"
            >
              <X size={11} /> Limpar
            </button>
          )}
        </div>
      </div>

      {/* ── Board ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto p-4 min-h-0">
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
            <div className="flex gap-4 h-full items-start">
              {sortedColumns.map(col => (
                <KanbanColumnItem
                  key={col.id}
                  column={col}
                  cards={visibleCards.filter(c => c.columnId === col.id)}
                  contacts={contacts}
                  onAddCard={setAddCard}
                  onRemove={removeKanbanColumn}
                  onSaveEdit={updateKanbanColumn}
                />
              ))}

              {showAddCol ? (
                <div className="w-64 shrink-0 bg-gray-900 border border-gray-800 rounded-xl p-3">
                  <input
                    value={newColName}
                    onChange={e => setNewColName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addColumn(); if (e.key === 'Escape') setShowAddCol(false) }}
                    autoFocus
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 mb-2"
                    placeholder="Nome da coluna"
                  />
                  <div className="flex gap-2">
                    <button onClick={addColumn} className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs text-white rounded-lg">Criar</button>
                    <button onClick={() => setShowAddCol(false)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white"><X size={14} /></button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowAddCol(true)}
                  className="w-48 shrink-0 h-14 border-2 border-dashed border-gray-700 hover:border-indigo-600 rounded-xl text-xs text-gray-600 hover:text-indigo-400 transition-colors flex items-center justify-center gap-2"
                >
                  <Plus size={14} /> Nova coluna
                </button>
              )}
            </div>
          </SortableContext>

          <DragOverlay>
            {activeCard && (
              <div className="bg-gray-800 border border-indigo-500 rounded-lg p-3 shadow-xl w-64 opacity-90 rotate-1">
                <p className="text-sm font-medium text-white">{activeCard.title}</p>
              </div>
            )}
            {activeCol && (
              <div className="w-64 bg-gray-900 border border-indigo-500 rounded-xl p-3 shadow-xl opacity-90 rotate-1">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: activeCol.color }} />
                  <span className="text-sm font-medium text-white">{activeCol.title}</span>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {addCard && (
        <AddCardModal
          columnId={addCard}
          onClose={() => setAddCard(null)}
          onSave={c => { addKanbanCard(c); setAddCard(null) }}
        />
      )}
    </div>
  )
}
