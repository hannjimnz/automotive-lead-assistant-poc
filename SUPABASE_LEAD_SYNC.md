# Sincronización de prospectos con Supabase

> La API ahora usa PostgreSQL como persistencia principal. La configuración y la importación del historial SQLite están en [SUPABASE_PERSISTENCIA.md](SUPABASE_PERSISTENCIA.md). Las menciones a SQLite más abajo describen el diseño original; el outbox actual de producción se encuentra en `chatbot.lead_sync_outbox`.

La sincronización está deshabilitada salvo que `LEAD_SYNC_ENABLED=true` y exista `LEAD_SYNC_DATABASE_URL`. Express usa una conexión PostgreSQL de servidor con SSL; la URL contiene una credencial y nunca debe enviarse al navegador ni registrarse en logs. No se consulta ni modifica ningún objeto de scoring.

## Modelo

- `sistema_origen` está centralizado como `pasa-chatbot-poc` en `server/lead-sync-model.ts`.
- `Opportunity.id` es `leads.id_externo`. El supuesto es una fila `leads` por oportunidad, no una persona compartida por varias oportunidades. El índice único existente sobre `(sistema_origen, id_externo)` evita duplicados.
- `leads` conserva nombre, teléfono, correo e ID del vehículo del catálogo. `lead_perfil_chatbot` guarda respuestas comerciales, el siguiente paso como código estable, estados de recopilación, versión, hash y fecha de sincronización.
- La migración local `supabase/migrations/20261018231546_lead_perfil_chatbot_sync.sql` solo crea la tabla relacionada y habilita RLS. No se aplica automáticamente.
- `Opportunity.nextAction` sigue siendo texto de presentación local. Solo `nextActionCode` se sincroniza.
- La respuesta explícita “sin dudas” se representa como `dudas = NULL` con estado `answered`; no se persiste el texto de interfaz como valor comercial.

## Variables

Agregar al entorno del proceso servidor cuando backend haya provisionado el acceso:

```dotenv
LEAD_SYNC_ENABLED=false
LEAD_SYNC_DATABASE_URL=
```

La URL debe apuntar a Supabase PostgreSQL con un rol dedicado de servidor. Mantener `LEAD_SYNC_ENABLED=false` hasta que se aplique y revise la migración, se provisionen permisos, y se verifique la conexión en un ambiente aislado. Habilitarlo enviará snapshots nuevos pendientes del outbox; el proceso no recorre oportunidades antiguas de SQLite ni genera una carga masiva.

## Permisos sugeridos

No usar `service_role`: la política actual le permite operar sobre las tablas de scoring. Provisionar un rol dedicado `lead_chatbot_writer` que no sea propietario de las tablas, no tenga `BYPASSRLS`, no herede `service_role`, no tenga permiso `DELETE` ni grants sobre tablas de scoring. El rol necesita:

- `USAGE` en `public`.
- En `leads`: `SELECT (id, sistema_origen, id_externo)`, `INSERT (sistema_origen, id_externo)` y `UPDATE (nombre, telefono, email, vehiculo_interes)`.
- En `lead_perfil_chatbot`: `SELECT (lead_id, version_actualizacion, snapshot_hash)`, `INSERT` para las columnas del perfil y `UPDATE` para sus columnas mutables.
- Políticas RLS de `SELECT`, `INSERT` y `UPDATE` para ese rol en ambas tablas, restringidas a `sistema_origen = 'pasa-chatbot-poc'`. En el perfil, verificar esa condición mediante el lead relacionado. No conceder acceso a `lead_evaluaciones`, `lead_evaluacion_parametros` ni las tablas `scoring_*`.

La creación de rol, grants y políticas queda fuera de la migración de esquema y requiere revisión/provisión por backend. Configurar la contraseña por el mecanismo de secretos del entorno, nunca dentro de SQL versionado.

## Consistencia y reintentos

Cada cambio incluido en el snapshot actualiza SQLite y su outbox en la misma transacción local. La versión del outbox solo aumenta cuando cambia el hash canónico del snapshot; el snapshot conserva valores falsos y cero explícitos, mientras que la columna JSON conserva los estados por separado.

El worker abre una transacción PostgreSQL corta por snapshot, bloquea la fila `leads` asociada a `(sistema_origen, id_externo)`, compara la versión/hash del perfil y actualiza contacto y perfil juntos. Un error revierte ambas tablas. No mantiene una transacción abierta durante la llamada al agente de IA. Envíos antiguos se ponen en estado terminal de diagnóstico; un hash distinto en la misma versión también es terminal.

Los errores recuperables usan como máximo ocho intentos con espera exponencial creciente, hasta cinco minutos. Tras agotar intentos, el snapshot se conserva en estado `dead` para diagnóstico. Los logs solo incluyen categoría, código PostgreSQL/infraestructura, intento y si el error es terminal; nunca payload, teléfono, correo, contraseña ni URL.

## Migración y pruebas

Revisar y aplicar la migración por separado en un proyecto PostgreSQL de pruebas, nunca desde el arranque de Express. La suite local usa SQLite aislado para mapping/outbox. La prueba de concurrencia y rollback real requiere `LEAD_SYNC_TEST_DATABASE_URL` apuntando a la base local vacía y aislada `pasa_lead_sync_test`; nunca usar la URL del proyecto compartido. Si falta esa variable, se omite. El acceso RLS y los grants del rol dedicado aún deben verificarse de forma aislada antes de habilitarlo.
