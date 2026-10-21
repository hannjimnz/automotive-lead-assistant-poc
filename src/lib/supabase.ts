import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | undefined

/** Cliente compartido del navegador; se inicializa cuando se utiliza por primera vez. */
export function getSupabaseClient(): SupabaseClient {
  if (client) return client

  const url = import.meta.env.VITE_SUPABASE_URL?.trim()
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

  if (!url || !key) {
    throw new Error('Configura VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en .env para usar Supabase.')
  }

  client = createClient(url, key)
  return client
}
