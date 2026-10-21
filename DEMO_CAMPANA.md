# Prueba local de campaña

Hipótesis técnica por validar: tarjeta de campaña → página nuestra «Te estamos redirigiendo…» y registro de acceso → landing independiente. No es una integración definitiva ni una medición de leads o usuarios únicos.

## Probar sin utilizar la base habitual

Desde PowerShell, en la raíz del proyecto:

```powershell
$env:DATABASE_PATH = 'data/campana-demo.sqlite'
npm.cmd run dev
```

Elige un archivo nuevo para una prueba aislada. No hace falta modificar `.env`. La aplicación crea ese archivo al arrancar. El backend escucha en `127.0.0.1:3001` y Vite en `127.0.0.1:5173`. Usa el puerto de Vite para todo el recorrido:

1. Abre `http://127.0.0.1:5173/demo/campana`: tarjeta Bronco Sport con distintivo Simulación.
2. Pulsa **Me interesa**. El navegador solicita `GET /r/campana-bronco`; Vite lo envía a Express. SQLite registra un evento y Express devuelve **200 HTML**, sin `Location`, con `Cache-Control: no-store, max-age=0`. Verás «Te estamos redirigiendo al sitio de PASA…», «En unos segundos abrirás la página de la campaña» y el enlace **Continuar ahora** desde el inicio.
3. El JavaScript de la página abre `/demo/landing` aproximadamente 3 segundos después de cargar el documento. **Continuar ahora** abre el mismo destino inmediatamente, incluso con JavaScript desactivado. Sin JavaScript no hay continuación automática. El destino procede exclusivamente de la configuración del servidor; la landing muestra contenido propio y no monta el chat ni crea conversaciones. Cargar los estilos, el script y la landing no añade registros.
4. Vuelve a `/`, elige **Eventos de campaña** y pulsa **Actualizar**. Se muestran el total de accesos, campaña, vehículo y fecha UTC. La consulta no registra accesos. No hay actualización automática.
5. Abrir directamente `/demo/landing` tampoco registra un acceso. Repite el enlace de campaña para comprobar que cada solicitud genera otro evento.

Para inspeccionar la página intermedia y el enlace fijo (curl no ejecuta el temporizador):

```powershell
curl.exe -i "http://127.0.0.1:5173/r/campana-bronco"
curl.exe -i "http://127.0.0.1:5173/r/inexistente"
curl.exe -i "http://127.0.0.1:5173/r/campana-bronco?url=https://example.invalid&destination=/otro"
curl.exe "http://127.0.0.1:5173/api/campaign-events"
```

Los parámetros no cambian el destino. La campaña inexistente responde 404 sin escribir. Cada solicitud al enlace válido, incluso con parámetros, intenta registrar un único acceso; recargar `/r` es otra solicitud. Si falla la escritura, se registra únicamente un diagnóstico técnico seguro y la página permite continuar de todas formas. El total no incluirá ese acceso si no pudo guardarse; no se reintenta desde el navegador.

## Probar el frontend compilado servido por Express

Con un archivo SQLite de prueba nuevo seleccionado en la terminal:

```powershell
$env:DATABASE_PATH = 'data/campana-compilada-demo.sqlite'
npm.cmd run build
npm.cmd run dev:api
```

Sin necesitar Vite, abre `http://127.0.0.1:3001/demo/campana`. Express sirve `dist` y las rutas conocidas `/`, `/demo/campana` y `/demo/landing`; `/r` sigue resolviéndose en el backend. Repite el recorrido y comprueba la pantalla durante unos 3 segundos, el botón manual y la landing. Para ver los registros, abre `/` en ese mismo puerto y usa la vista existente **Eventos de campaña** → **Actualizar**. No se añadió ninguna pantalla administrativa.

Prueba manualmente ambos puertos en claro/oscuro y móvil, con navegación por teclado y movimiento reducido. La página intermedia respeta la elección `pasa-theme` o el tema del sistema; sin JavaScript usa el tema del sistema. No tiene animaciones. Desactiva JavaScript y verifica el enlace manual. El temporizador puede demorarse más por la carga del navegador o pestañas en segundo plano.

Al finalizar, detén el proceso y, si lo deseas, limpia solo la variable de esta terminal con `Remove-Item Env:DATABASE_PATH`. No es necesario borrar ningún archivo de datos.

## Alcance y límites

- Configuración ficticia solo en `server/campaigns.ts`: `campana-bronco`, vehículo `bronco`, destino fijo `/demo/landing`.
- Los registros usan la entidad separada `campaignAccesses` del repositorio SQLite existente: ID de evento, campaña, vehículo y fecha ISO UTC. No se guardan IP, identidad, query params, headers, teléfono, correo ni nombres.
- Vistas previas, robots y recargas pueden generar accesos. Un registro no demuestra interés humano, conversión ni una persona distinta. No se llama al agente ni se envían mensajes externos.
- Se mantienen los temas claro/oscuro. Comprueba manualmente escritorio, móvil, teclado y estados de carga/error.
- Ejecuta `npm.cmd run build` antes de las pruebas: el caso de Express verifica el contenido real de `dist`. Después ejecuta `npm.cmd run lint`, `npm.cmd run test:service` y `npm.cmd run test:client`. Se comprueban HTTP 200/404, caché, destino fijo, fallo de escritura, temporizador simulado de 3000 ms, continuación manual, proxy de Vite y frontend compilado servido por Express. Las pruebas usan SQLite en memoria y HTTP local, sin la base habitual ni Anthropic.
- La temporización se prueba con un reloj simulado y la estructura del enlace se verifica en el HTML. Estas pruebas no sustituyen la revisión visual ni la comprobación manual del navegador con JavaScript desactivado.
- `vite preview` solo sirve archivos del frontend; usa el servidor Express descrito arriba para verificar el recorrido compilado completo.

## Antes de una campaña y landing reales

Confirmar el dominio/HTTPS y el alojamiento de la landing; configurar una lista de campañas y destinos autorizados en el servidor, sin aceptar URLs del visitante. Definir quién puede consultar los eventos, retención de registros, límites de tráfico y operación/respaldos. Configurar el proxy de producción para `/r` y `/api`, y servir las rutas de frontend correctamente. Verificar con el canal real cómo se comportan robots y vistas previas y acordar qué métrica se desea medir. Cualquier seguimiento de personas o integración comercial requiere un alcance nuevo; esta demo no los implementa.
