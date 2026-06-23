import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export interface UserPermissions {
  dispatcher: boolean
  chipsPage: boolean
  settings: boolean
  channelIds: string[]
  chipIds: string[]
}

export interface AuthUser {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
  permissions: UserPermissions
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  login: (email: string, password: string) => Promise<string | null>
  logout: () => void
  isAdmin: () => boolean
  can: (key: 'dispatcher' | 'chipsPage' | 'settings') => boolean
  allowedChannelIds: () => string[]
  allowedChipIds: () => string[]
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,

      login: async (email, password) => {
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          })
          const data = await res.json()
          if (!res.ok) return data.error || 'Erro ao entrar'
          set({ token: data.token, user: data.user })
          return null
        } catch {
          return 'Erro de conexão com o servidor'
        }
      },

      logout: () => set({ token: null, user: null }),

      isAdmin: () => get().user?.role === 'admin',

      can: (key) => {
        const { user } = get()
        if (!user) return false
        if (user.role === 'admin') return true
        return user.permissions[key] === true
      },

      allowedChannelIds: () => {
        const { user } = get()
        if (!user || user.role === 'admin') return []
        return user.permissions.channelIds || []
      },

      allowedChipIds: () => {
        const { user } = get()
        if (!user || user.role === 'admin') return []
        return user.permissions.chipIds || []
      },
    }),
    {
      name: 'auth-store',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
