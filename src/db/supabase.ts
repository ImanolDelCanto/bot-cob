import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Usamos la service_role key porque el bot es backend y necesita
// saltearse las RLS policies que dejamos prendidas en las tablas.
// Esta key NUNCA debe exponerse en frontend.
export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);
