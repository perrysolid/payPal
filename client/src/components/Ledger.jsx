import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule, themeQuartz } from 'ag-grid-community';
import { time } from '../format.js';

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: 'IBM Plex Sans, system-ui, sans-serif',
  fontSize: 12.5,
  headerFontSize: 11,
  headerTextColor: '#8fa6b8',
  wrapperBorder: false,
  columnBorder: false,
  rowBorder: { color: '#142231' },
  headerFontWeight: 600,
  foregroundColor: '#e8f1f7',
  headerBackgroundColor: '#0b1621',
  backgroundColor: '#0e1a27',
  borderColor: '#1c2d3d',
  rowHoverColor: '#13283a',
  accentColor: '#4fb3d9',
  oddRowBackgroundColor: '#0c1823',
  browserColorScheme: 'dark',
  rowHeight: 42,
  headerHeight: 40,
  wrapperBorderRadius: 0,
  wrapperBorder: false,
  spacing: 6,
});

function statusClass(s) {
  if (!s) return 'st-neutral';
  if (s === 'TRIGGERED') return 'st-trigger';
  if (/FAIL|REJECT|DENIED|BLOCKED|RETURNED/.test(s)) return 'st-bad';
  if (/^(CAPTURED|SUCCESS|ALLOCATED|COMPLETED)$/.test(s)) return 'st-ok';
  if (/AUTHORIZED|HELD/.test(s)) return 'st-held';
  if (/PENDING|PROCESSING|UNCLAIMED|ONHOLD|CREATED|REQUESTED|CAPTURING|VOIDING|AUTHORIZING/.test(s)) return 'st-pending';
  return 'st-neutral';
}

const StatusCell = ({ value }) => <span className={`cell-status ${statusClass(value)}`}>{value}</span>;
const ScenarioCell = ({ value }) => (value === 'SCENARIO' ? <span className="tag-sim">Scenario</span> : value === 'LIVE' ? <span className="tag-live">Live</span> : <span className="muted">—</span>);
const RefCell = ({ value }) => <span className="mono" style={{ fontSize: 11.5 }}>{value}</span>;

const SUGGESTIONS = [
  'Show unpaid pledges in Sylhet',
  'Household allocations in zone A in Sylhet',
  'Payout items that are not completed',
  'Captures over $20',
];

export default function Ledger({ rows, api, onError }) {
  const gridRef = useRef(null);
  const [grouped, setGrouped] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState(null);

  const columnDefs = useMemo(() => [
    {
      headerName: 'Transaction',
      children: [
        { field: 'district', headerName: 'District', width: 120, spanRows: grouped, sort: grouped ? 'asc' : undefined, sortIndex: grouped ? 0 : undefined, cellStyle: grouped ? { fontWeight: 600, background: '#faf9f5' } : undefined },
        { field: 'time', headerName: 'Time', width: 150, valueFormatter: (p) => time(p.value), sort: grouped ? 'desc' : 'desc', sortIndex: grouped ? 1 : 0, filter: false },
        { field: 'type', headerName: 'Type', width: 160 },
        { field: 'zone', headerName: 'Zone', width: 80 },
      ],
    },
    {
      headerName: 'Money',
      children: [
        { field: 'party', headerName: 'Party', flex: 1, minWidth: 200, tooltipField: 'party' },
        { field: 'amount', headerName: 'Amount', width: 120, type: 'numericColumn', filter: 'agNumberColumnFilter', valueFormatter: (p) => (p.value == null ? '' : p.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), cellClass: 'mono' },
        { field: 'currency', headerName: 'Currency', width: 95 },
        { field: 'status', headerName: 'Status', width: 170, cellRenderer: StatusCell },
      ],
    },
    {
      headerName: 'Provenance',
      children: [
        { field: 'reference', headerName: 'PayPal reference', width: 220, cellRenderer: RefCell, tooltipField: 'reference' },
        { field: 'scenario', headerName: 'Basis', width: 110, cellRenderer: ScenarioCell },
        { field: 'provider', headerName: 'Provider', width: 140 },
        { field: 'note', headerName: 'Note', width: 260, tooltipField: 'note' },
      ],
    },
  ], [grouped]);

  const defaultColDef = useMemo(() => ({ sortable: true, filter: 'agTextColumnFilter', resizable: true, floatingFilter: false }), []);

  const ask = useCallback(async (q) => {
    const text = (q ?? question).trim();
    if (!text) return;
    setQuestion(text);
    setAsking(true);
    try {
      const r = await api.ask(text);
      setResult(r);
      const gridApi = gridRef.current?.api;
      if (gridApi) {
        gridApi.setFilterModel(r.filterModel);
        if (r.sort) gridApi.applyColumnState({ state: [{ colId: r.sort.column, sort: r.sort.direction }], defaultState: { sort: null } });
      }
    } catch (e) {
      onError(e);
    } finally {
      setAsking(false);
    }
  }, [question, api, onError]);

  const clear = () => {
    setResult(null);
    setQuestion('');
    gridRef.current?.api?.setFilterModel(null);
  };

  const exportCsv = () => gridRef.current?.api?.exportDataAsCsv({ fileName: `floodgate-ledger-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv` });

  return (
    <div className="panel">
      <form className="ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <span className="eyebrow" style={{ whiteSpace: 'nowrap' }}>Ask the ledger</span>
        <input aria-label="Ask the ledger a question" placeholder="e.g. Show unpaid pledges in zone B in Sylhet" value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} />
        <button type="submit" className="btn" disabled={asking || !question.trim()}>{asking ? <span className="spinner" /> : null}Ask</button>
        {result && <button type="button" className="btn secondary" onClick={clear}>Clear</button>}
      </form>
      {!result && (
        <div className="suggestions" style={{ paddingTop: 0 }}>
          {SUGGESTIONS.map((s) => <button type="button" key={s} onClick={() => ask(s)} disabled={asking}>{s}</button>)}
        </div>
      )}
      {result && (
        <div className="ask-result">
          <span>{result.explanation}</span>
          {Object.entries(result.filterModel).map(([k, v]) => (
            <span key={k} className="cell-status st-neutral">{k} {v.conditions ? v.conditions.map((c) => `${c.type} ${c.filter}`).join(' OR ') : `${v.type} ${v.filter}`}</span>
          ))}
          {result.rejected?.length ? <span className="muted">Ignored: {result.rejected.join('; ')}</span> : null}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 18px', borderBottom: '1px solid var(--line-2)', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12.5 }}>{rows.length} entries</span>
        <div className="grid-tools">
          <label className="toggle"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />Group by district</label>
          <button type="button" className="btn secondary" onClick={exportCsv}>Export CSV</button>
        </div>
      </div>
      <div className="grid-host">
        <AgGridReact
          ref={gridRef}
          theme={theme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(p) => p.data.id}
          enableCellSpan
          tooltipShowDelay={300}
          animateRows={false}
          overlayNoRowsTemplate='<span style="color:#667180">No entries yet.</span>'
        />
      </div>
    </div>
  );
}
