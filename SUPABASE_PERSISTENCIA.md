# Persistencia del chatbot con el SDK de Supabase

La API utiliza `@supabase/supabase-js` mediante `server/supabase-repository.ts`. Conserva el contrato que usaba SQLite: documentos por entidad, IDs originales, orden de inserción, upsert, transacciones y outbox. El cliente del navegador de `src/lib/supabase.ts` es independiente; la persistencia del CRM se ejecuta en el servidor.

## Configuración

Configura en el `.env` del servidor:

```dotenv
SUPABASE_URL=https://wkhwurisjijgmnlivnty.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
DATABASE_PATH=./data/pasa.sqlite
LEAD_SYNC_ENABLED=false
LEAD_SYNC_DATABASE_URL=
```

Obtén la secret key en el dashboard de Supabase, en la configuración de API keys del proyecto. También se admite la clave legacy `service_role` como valor de `SUPABASE_SECRET_KEY`. Nunca uses el prefijo `VITE_` para estas claves. La publishable key del navegador no tiene permisos para persistir los datos privados del CRM. Si falta la configuración del servidor, la API falla al arrancar sin crear un almacenamiento local alternativo.

Ejecuta `npm run dev`. `/api/health` comprueba la persistencia con una lectura real del SDK.

## Tablas y funciones

El esquema privado `chatbot` conserva:

- `documents`: clientes, oportunidades, conversaciones, mensajes, evaluaciones, eventos, tareas, reglas y accesos de campaña. Cada entidad conserva su documento completo en JSONB.
- `lead_sync_outbox`: snapshots comerciales, versiones, estado de envío y reintentos.

La migración `20261020163335_chatbot_sdk_repository.sql` está aplicada al proyecto `pasa-lead-agent` (`wkhwurisjijgmnlivnty`). Depende de las tablas creadas por `20261019173419_chatbot_persistence.sql`. No vuelvas a ejecutarlas manualmente en ese proyecto.

Las funciones `public.chatbot_repository_snapshot` y `public.chatbot_repository_commit` permiten al SDK leer y confirmar los cambios sin exponer el esquema `chatbot` en la Data API. Solo `service_role` tiene permiso para ejecutarlas; usan `SECURITY INVOKER`, un `search_path` vacío y los permisos del llamador. Las tablas conservan RLS y los índices únicos para teléfono, correo y conversación por oportunidad. Las claves secretas de Supabase son credenciales privilegiadas y permanecen exclusivamente en el servidor.

## Transacciones y concurrencia

Cada transacción obtiene un snapshot de documentos y outbox. Las lecturas ven las escrituras de la misma transacción, incluidas las anidadas. El commit RPC toma un bloqueo de PostgreSQL, comprueba que el snapshot sigue vigente y aplica todos los cambios juntos. Si una restricción falla, se revierte todo. Una actualización conserva la posición original del documento.

Los conflictos confirmados de serialización reejecutan el callback hasta cinco intentos. Los callbacks deben contener únicamente operaciones de repositorio; las llamadas a IA y otros servicios externos permanecen fuera de las transacciones. Los errores de red no provocan un reenvío automático del commit, ya que su resultado puede ser ambiguo. La API conserva la idempotencia por `requestId` existente.

La cola mantiene versiones, deduplicación por hash, reintentos y protección contra confirmaciones de versiones anteriores. Una entrada `sending` solo se recupera tras un minuto, para no tomar el trabajo de un worker activo.

Este diseño está pensado para el volumen del POC: cada snapshot carga todos los documentos y el outbox, sin el límite de filas de una consulta REST paginada. A medida que crezca el historial, conviene sustituirlo por RPC específicas con lecturas filtradas y control de concurrencia por oportunidad. No ejecutes simultáneamente escritores del repositorio PostgreSQL anterior y del nuevo repositorio SDK. La recuperación de mensajes pendientes y la protección de solicitudes activas siguen diseñadas para una sola instancia de API.

## Importar el historial SQLite

Con la API detenida y una copia de respaldo del archivo de origen:

```sh
npm run db:import-sqlite
```

El importador abre SQLite en modo de solo lectura y usa el SDK para guardar en Supabase. Copia documentos en orden y el outbox si existe, en una sola transacción. Un ID idéntico puede importarse de nuevo; un ID con contenido diferente cancela todo el lote. Las entradas históricas `sending` pasan a `pending`. El archivo SQLite no se modifica.

La importación no se ejecuta automáticamente al arrancar. Los documentos antiguos sin snapshot comercial se conservan, pero no generan retroactivamente nuevos snapshots de outbox.

## Sincronización comercial

El chatbot ya no calcula puntuaciones, clasificaciones ni genera evaluaciones locales. Al arrancar, limpia `score`, `grade` y `ruleVersion` de las oportunidades históricas y cambia el estado local `qualified` a `conversing`. Conserva las respuestas, los contactos y las fechas de actividad. Los documentos antiguos de tipo `evaluations` y `rules` quedan como archivo histórico; no se muestran ni se usan en las respuestas de la API o la interfaz. El cálculo oficial queda a cargo del sistema externo de scoring, todavía sin conectar a esta interfaz.

La persistencia del chatbot es independiente del envío a `public.leads` y `public.lead_perfil_chatbot`. Ese worker mantiene su conexión PostgreSQL dedicada mediante `LEAD_SYNC_DATABASE_URL`, y se habilita con `LEAD_SYNC_ENABLED=true`. Las tablas de scoring y su contrato no cambian. Con el worker desactivado, el outbox permanece guardado en Supabase.

`DATABASE_URL` solo corresponde al repositorio PostgreSQL anterior; ya no es necesario para arrancar la API o importar SQLite. `DATABASE_PATH` solo selecciona el archivo histórico. SQLite se conserva para las pruebas aisladas y para leer ese historial.

## Verificación

`npm run test:service` incluye pruebas del SDK con transporte simulado: rollback, concurrencia, reintentos, orden, importación y flujo del CRM tras reabrir el repositorio. Las funciones SQL se verificaron en el proyecto real dentro de una transacción revertida, con el rol `service_role`, incluyendo rechazo de snapshot obsoleto y rollback de un lote inválido. La revisión de seguridad de Supabase no reportó avisos tras la migración.

La prueba de la API local contra Supabase y la importación del historial requieren configurar `SUPABASE_SECRET_KEY`.

Referencia: [RPC del SDK de Supabase](https://supabase.com/docs/reference/javascript/rpc).
