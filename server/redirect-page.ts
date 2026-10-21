const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export function redirectPage(destination: string): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Te estamos redirigiendo · PASA</title>
  <script src="/campaign-redirect.js"></script>
  <link rel="stylesheet" href="/campaign-redirect.css">
</head>
<body>
  <main>
    <span class="brand" aria-hidden="true">P</span>
    <p class="eyebrow">PASA · Campaña</p>
    <h1>Te estamos redirigiendo al sitio de PASA…</h1>
    <p>En unos segundos abrirás la página de la campaña</p>
    <a id="continue-link" href="${escapeHtml(destination)}">Continuar ahora</a>
    <p class="note">Demostración local · El destino es una landing de prueba.</p>
    <noscript><p>Puedes continuar con el enlace; la apertura automática requiere JavaScript.</p></noscript>
  </main>
</body>
</html>`;
}
