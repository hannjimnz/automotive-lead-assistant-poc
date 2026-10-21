# Seguimiento interno de la POC

Los recordatorios son mensajes dentro del chat, sin WhatsApp, correo, notificaciones externas ni llamadas a Claude. La exportación JSON no forma parte de este cambio.

## Demostración con los botones

1. Abre una conversación con al menos un mensaje del usuario procesado correctamente y datos pendientes. Una conversación vacía con solo el saludo no es elegible.
2. Bajo la ficha comercial aparece **Simulación de seguimiento**. Pulsa **Simular recordatorio de 24 h**: añade un mensaje amable al chat y un evento identificado como simulación en Historial.
3. Se habilita **Simular recordatorio de 48 h**. Púlsalo para mostrar el último recordatorio del ciclo. Ambos botones quedan deshabilitados: no se pueden repetir ni ejecutar el segundo antes del primero.
4. Si el usuario responde y su mensaje se procesa correctamente, verás otro ciclo si siguen pendientes datos. Si se atendieron todos los campos necesarios, ambos quedan deshabilitados. Los estados «No sabe», «Prefiere no responder» y «No aplica» cuentan como atendidos.

Cada botón explica su bloqueo: conversación no iniciada, recopilación completa, procesamiento/envío pendiente, primer recordatorio todavía no ejecutado o tarea ya resuelta. Los botones no llaman al proveedor; los mensajes normales que el usuario envía siguen usando el agente configurado. Para verificar todo sin proveedor ni datos habituales, usa las pruebas aisladas descritas abajo.

La simulación hace elegible temporalmente **solo la tarea elegida** en la misma función de ejecución que usa el proceso automático. No adelanta el reloj, no cambia `dueAt` y no toca otras conversaciones. El mensaje y su evento llevan la hora real de ejecución. El ciclo es el ID del mensaje del usuario; un reintento de simulación del mismo ciclo no duplica mensajes. Un intento de un ciclo anterior es rechazado.

## Ciclos, estados y recuperación

- Se reutiliza la entidad SQLite `tasks`, con `kind=followup`, ciclo, mensaje de origen, intento, vencimiento, estado, modo de ejecución y mensaje generado. Las tareas históricas sin esa marca no se ejecutan como seguimiento.
- Se programan 24 y 48 horas desde la aceptación del último mensaje del usuario **procesado correctamente**. La recepción de una nueva respuesta cancela inmediatamente los pendientes del ciclo anterior. Mientras se procesa no se envía seguimiento. Si falla, el seguimiento queda detenido hasta que un reintento o nuevo mensaje se procese correctamente.
- La recopilación usa los estados validados, no el score: contacto, vehículo de interés, `missingBlocks`, dudas y propuestas pendientes. El enganche solo es necesario para crédito; marca/modelo/año a cuenta solo cuando corresponde. No se repreguntan datos atendidos para hacer elegible un recordatorio.
- Cada tarea revalida el estado al ejecutarse. Mensaje, tarea y evento se guardan en una única transacción SQLite. Las escrituras interrumpidas se revierten y pueden reintentarse sin duplicar el mensaje.
- Con el servidor encendido se revisa al arrancar y cada 30 segundos. Tras un reinicio, si vencieron ambas tareas, se omite la primera y solo se envía la última. El historial explica la omisión. Después de la segunda no hay más recordatorios hasta una nueva respuesta del usuario.
- Los recordatorios no cambian score, evaluaciones ni estado comercial del prospecto. Actualizan únicamente actividad, tareas, mensajes e historial. Su marca permite conservar el contexto de la pregunta pendiente para respuestas breves y confirmaciones.
- La vista Chat activa y visible consulta novedades cada 10 segundos, sin sobrescribir borradores o solicitudes locales pendientes. Las consultas no se solapan y se ignoran resultados obsoletos tras cambiar de conversación o iniciar otra operación. Las pestañas no visibles no consultan en segundo plano. «Actualizar estado» continúa disponible si falla una lectura.
- Al iniciar el servidor, las conversaciones elegibles anteriores sin ciclo se programan desde su último mensaje del usuario; si están vencidas se aplica la misma regla de recuperación. No se requiere migración masiva ni recalcular evaluaciones.

## Verificaciones aisladas

```powershell
npm.cmd run build
npm.cmd run lint
npm.cmd run test:service
npm.cmd run test:client
```

El reloj se inyecta solo en las pruebas; no se modifica el reloj global. Se usa agente falso, SQLite en memoria y un archivo temporal creado por la propia prueba para comprobar cierre/reapertura real. No se usa la base habitual ni se llama a Anthropic.

Se cubren elegibilidad, dependencias, propuestas, 24/48 h, cancelación, recopilación completa, procesamiento, fallo/reintento, doble clic HTTP, ciclos obsoletos, rollback atómico y recuperación tras reinicio. Las pruebas de interfaz comprueban etiquetas, controles deshabilitados y contrato API. Queda la revisión visual en navegador de llegada automática de mensajes, borrador intacto, teclado y ambos temas.
