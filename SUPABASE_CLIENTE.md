# Cliente Supabase

El cliente del frontend usa `@supabase/supabase-js`. Configura en `.env` la URL del proyecto y su **publishable key**, disponibles en el dashboard de Supabase:

```dotenv
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Reinicia Vite tras cambiar estas variables. Las variables `VITE_` son públicas: nunca coloques una clave `service_role` o secret en ellas.

```ts
import { getSupabaseClient } from './lib/supabase'

const supabase = getSupabaseClient()
```

La función reutiliza una sola instancia y valida la configuración al primer uso. El SDK administra la sesión del navegador con sus opciones predeterminadas. Las consultas quedan sujetas a los permisos y políticas RLS del proyecto.

La API utiliza otra instancia del SDK, exclusiva del servidor, a través de `server/supabase-repository.ts`. Configura `SUPABASE_URL` y `SUPABASE_SECRET_KEY` para guardar la información que antes se almacenaba en SQLite. La clave secreta nunca lleva el prefijo `VITE_`.

Consulta `SUPABASE_PERSISTENCIA.md` para los detalles de transacciones y la importación del historial SQLite.

Referencia: https://supabase.com/docs/reference/javascript/initializing
