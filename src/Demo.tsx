import { ThemeToggle } from './components/ThemeToggle'

export function Demo({ path }: { path: string }) {
  const campaign = path === '/demo/campana'
  const landing = path === '/demo/landing'
  return <div className="app-shell demo-shell">
    <header className="app-header"><div className="brand"><span className="brand-mark" aria-hidden="true">P</span><h1>PASA · Demo local</h1><span className="badge">Simulación</span></div><ThemeToggle /></header>
    <main className="card campaign-content">
      {campaign ? <><p className="eyebrow">Campaña ficticia · campana-bronco</p><h2>Bronco Sport</h2><p>Una tarjeta de demostración para probar el recorrido desde una campaña hasta una landing.</p><a className="primary campaign-link" href="/r/campana-bronco">Me interesa</a><p className="footnote">El enlace registra un acceso y redirige. No crea un prospecto ni una conversación.</p></>
        : landing ? <><p className="eyebrow">Destino de demostración</p><h2>Bienvenido a la landing</h2><p>Esta página es independiente de la campaña y del chatbot. Puedes visitarla directamente sin registrar un acceso al enlace.</p><p>No se ha creado una oportunidad, una conversación ni una solicitud de contacto.</p></>
          : <><h2>Página de demostración no encontrada</h2><p>Comprueba la dirección de la página.</p></>}
      <p><a className="text-button" href="/demo/campana">Campaña local</a> · <a className="text-button" href="/">Volver a PASA</a></p>
    </main>
  </div>
}
