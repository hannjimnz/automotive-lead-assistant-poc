import { pageSizes, type PageSize, type prospectPage } from '../pagination'

export function Pagination({ result, pageSize, loading, onSize, onPage }: {
  result: ReturnType<typeof prospectPage>; pageSize: PageSize; loading: boolean;
  onSize: (size: PageSize) => void; onPage: (page: number) => void;
}) {
  return <div className="pagination-footer">
    <label className="page-size" htmlFor="prospect-page-size">Mostrar <select id="prospect-page-size" value={pageSize} disabled={loading} onChange={event => onSize(Number(event.target.value) as PageSize)}>{pageSizes.map(size => <option key={size} value={size}>{size}</option>)}</select><span>por página</span></label>
    <p className="page-range" role="status" aria-live="polite">{result.range}</p>
    {result.pageCount > 0 && <nav className="page-controls" aria-label="Páginas de prospectos">
      <button type="button" className="secondary" disabled={loading || result.page <= 1} onClick={() => onPage(result.page - 1)}>Anterior</button>
      {result.buttons.map((item, index) => item === 'ellipsis' ? <span className="page-ellipsis" key={`gap-${index}`} aria-hidden="true">…</span> : <button type="button" className="secondary page-number" key={item} disabled={loading} aria-label={`Página ${item}`} aria-current={item === result.page ? 'page' : undefined} onClick={() => onPage(item)}>{item}</button>)}
      <button type="button" className="secondary" disabled={loading || result.page >= result.pageCount} onClick={() => onPage(result.page + 1)}>Siguiente</button>
    </nav>}
  </div>
}
