# Prueba local de campaña

Hipótesis técnica por validar: tarjeta de campaña → registro de acceso → redirección a una landing independiente. No es una integración definitiva ni una medición de leads o usuarios únicos.

## Probar sin utilizar la base habitual

Desde PowerShell, en la raíz del proyecto:

```powershell
$env:DATABASE_PATH = 'data/campana-demo.sqlite'
npm.cmd run dev
```

Elige un archivo nuevo para una prueba aislada. No hace falta modificar `.env`. La aplicación crea ese archivo al arrancar. El backend escucha en `127.0.0.1:3001` y Vite en `127.0.0.1:5173`. Usa el puerto de Vite para todo el recorrido:

1. Abre `http://127.0.0.1:5173/demo/campana`: tarjeta Bronco Sport con distintivo Simulación.
2. Pulsa **Me interesa**. El navegador solicita `GET /r/campana-bronco`; Vite lo envía a Express. SQLite registra el evento y Express devuelve 302 con `Location: /demo/landing` y `Cache-Control: no-store, max-age=0`.
3. La redirección vuelve al mismo origen de Vite, que resuelve `/demo/landing`. La landing muestra contenido propio; no monta el chat, crea conversaciones ni recibe contenido del endpoint de registro.
4. Vuelve a `/`, elige **Eventos de campaña** y pulsa **Actualizar**. Se muestran el total de accesos, campaña, vehículo y fecha UTC. La consulta no registra accesos. No hay actualización automática.
5. Abrir directamente `/demo/landing` tampoco registra un acceso. Repite el enlace de campaña para comprobar que cada solicitud genera otro evento.

Para inspeccionar el salto sin seguir la redirección:

```powershell
curl.exe -i "http://127.0.0.1:5173/r/campana-bronco"
curl.exe -i "http://127.0.0.1:5173/r/inexistente"
curl.exe -i "http://127.0.0.1:5173/r/campana-bronco?url=https://example.invalid&destination=/otro"
curl.exe "http://127.0.0.1:5173/api/campaign-events"
```

Los parámetros no cambian el destino. La campaña inexistente responde 404 sin escribir. Cada ejecución del enlace válido, incluso con parámetros, añade un acceso.

Al finalizar, detén el proceso y, si lo deseas, limpia solo la variable de esta terminal con `Remove-Item Env:DATABASE_PATH`. No es necesario borrar ningún archivo de datos.

## Alcance y límites

- Configuración ficticia solo en `server/campaigns.ts`: `campana-bronco`, vehículo `bronco`, destino fijo `/demo/landing`.
- Los registros usan la entidad separada `campaignAccesses` del repositorio SQLite existente: ID de evento, campaña, vehículo y fecha ISO UTC. No se guardan IP, identidad, query params, headers, teléfono, correo ni nombres.
- Vistas previas, robots y recargas pueden generar accesos. Un registro no demuestra interés humano, conversión ni una persona distinta. No se llama al agente ni se envían mensajes externos.
- Se mantienen los temas claro/oscuro. Comprueba manualmente escritorio, móvil, teclado y estados de carga/error.
- `npm.cmd run build`, `npm.cmd run lint`, `npm.cmd run test:service` y `npm.cmd run test:client` verifican compilación y casos aislados, incluido el proxy de Vite y el contenido independiente de las páginas. Las pruebas usan SQLite en memoria y HTTP local, sin la base habitual ni Anthropic.
- El recorrido documentado utiliza `npm.cmd run dev`. `vite preview` solo sirve el frontend compilado y no sustituye el backend ni su proxy.

## Antes de una campaña y landing reales

Confirmar el dominio/HTTPS y el alojamiento de la landing; configurar una lista de campañas y destinos autorizados en el servidor, sin aceptar URLs del visitante. Definir quién puede consultar los eventos, retención de registros, límites de tráfico y operación/respaldos. Configurar el proxy de producción para `/r` y `/api`, y servir las rutas de frontend correctamente. Verificar con el canal real cómo se comportan robots y vistas previas y acordar qué métrica se desea medir. Cualquier seguimiento de personas o integración comercial requiere un alcance nuevo; esta demo no los implementa.
