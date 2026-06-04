import { useState, useRef } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { detectColumns, ALL_FIELDS, FIELD_LABELS, type FieldKey } from '../lib/columnDetect'
import { importPortfolio, type HoldingInput } from '../lib/uploadHoldings'

const MAX_ROWS = 200
const MAX_BYTES = 1024 * 1024

function parseCSV(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: (result) => {
        const data = result.data as string[][]
        if (data.length === 0) return resolve({ headers: [], rows: [] })
        resolve({ headers: data[0], rows: data.slice(1) })
      },
      error: (err) => reject(err),
    })
  })
}

async function parseXLSX(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' })
  if (raw.length === 0) return { headers: [], rows: [] }
  return {
    headers: raw[0].map(String),
    rows: raw.slice(1).map(r => r.map(String)),
  }
}

function toNum(s: string | undefined): number | undefined {
  if (!s) return undefined
  const n = parseFloat(s.replace(/,/g, ''))
  return isNaN(n) ? undefined : n
}

const CURRENCY_MAP: Record<string, string> = {
  '₪': 'NIS', 'ILS': 'NIS',
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
}
const VALID_CURRENCIES = new Set(['USD', 'NIS', 'EUR', 'GBP'])

function normalizeCurrency(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const s = raw.trim().toUpperCase()
  return CURRENCY_MAP[s] ?? (VALID_CURRENCIES.has(s) ? s : undefined)
}

function isNISValue(raw: string): boolean {
  const s = raw.trim().toUpperCase()
  return s === '₪' || s === 'ILS' || s === 'NIS'
}

// Build initial isAgorot map for all NIS rows: default true if price > 1000, else false.
function buildDefaultAgorot(
  rows: string[][],
  cm: Record<FieldKey, number>
): Record<number, boolean> {
  const result: Record<number, boolean> = {}
  rows.slice(0, MAX_ROWS).forEach((row, i) => {
    const ccyIdx = cm['currency']
    const ccy = ccyIdx >= 0 ? (row[ccyIdx]?.trim() ?? '') : ''
    if (!isNISValue(ccy)) return
    const priceIdx = cm['buy_price']
    const price = priceIdx >= 0 ? toNum(row[priceIdx]?.trim()) : undefined
    result[i] = price !== undefined && price > 1000
  })
  return result
}

type Status = 'idle' | 'preview' | 'submitting' | 'done' | 'error'

export default function UploadPage({ onBack }: { onBack: () => void }) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [headers, setHeaders] = useState<string[]>([])
  const [rawRows, setRawRows] = useState<string[][]>([])
  const [colMap, setColMap] = useState<Record<FieldKey, number>>({} as Record<FieldKey, number>)
  // isAgorot[i] = true means row i's buy price is in Agorot and will be ÷100 on import.
  // Only NIS rows get an entry; undefined rows fall back to the price>1000 heuristic.
  const [isAgorot, setIsAgorot] = useState<Record<number, boolean>>({})
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    if (file.size > MAX_BYTES) {
      setErrorMsg('File exceeds 1 MB.')
      return
    }
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['csv', 'xlsx', 'xls'].includes(ext)) {
      setErrorMsg('Only .csv, .xlsx, and .xls files are accepted.')
      return
    }
    setErrorMsg('')
    try {
      const parsed = ext === 'csv' ? await parseCSV(file) : await parseXLSX(file)
      const detected = detectColumns(parsed.headers)
      setHeaders(parsed.headers)
      setRawRows(parsed.rows)
      setColMap(detected)
      setIsAgorot(buildDefaultAgorot(parsed.rows, detected))
      setStatus('preview')
    } catch {
      setErrorMsg('Failed to parse file. Make sure it is a valid CSV or Excel file.')
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    // Reset so re-uploading the same filename triggers onChange again
    e.target.value = ''
  }

  function cellValue(row: string[], field: FieldKey): string {
    const idx = colMap[field]
    return idx !== undefined && idx >= 0 ? (row[idx]?.trim() ?? '') : ''
  }

  const importRows = rawRows.slice(0, MAX_ROWS)

  // All NIS rows (used to decide which rows show the toggle)
  const nisRowSet = new Set<number>(
    importRows.reduce<number[]>((acc, row, i) => {
      if (isNISValue(cellValue(row, 'currency'))) acc.push(i)
      return acc
    }, [])
  )

  // For a NIS row, return its current agorot state.
  // Falls back to price>1000 heuristic for rows not yet explicitly toggled.
  function getIsAgorot(row: string[], i: number): boolean {
    if (i in isAgorot) return isAgorot[i]
    const price = toNum(cellValue(row, 'buy_price'))
    return price !== undefined && price > 1000
  }

  async function confirm() {
    if ((colMap['ticker'] ?? -1) < 0) {
      setErrorMsg('Please map the Ticker column before importing.')
      return
    }
    setStatus('submitting')
    setErrorMsg('')

    const holdings: HoldingInput[] = importRows
      .map((row, i) => {
        let buyPrice = toNum(cellValue(row, 'buy_price'))
        if (nisRowSet.has(i) && getIsAgorot(row, i) && buyPrice !== undefined) {
          buyPrice = buyPrice / 100
        }
        return {
          ticker: cellValue(row, 'ticker'),
          name:     cellValue(row, 'name')     || undefined,
          quantity: toNum(cellValue(row, 'quantity')),
          currency: normalizeCurrency(cellValue(row, 'currency')),
          buy_price: buyPrice,
          category: cellValue(row, 'category') || undefined,
        }
      })
      .filter(h => h.ticker.length > 0)

    try {
      await importPortfolio(holdings)
      setStatus('done')
      setTimeout(onBack, 1800)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Import failed. Please try again.')
      setStatus('preview')
    }
  }

  function reset() {
    setStatus('idle')
    setHeaders([])
    setRawRows([])
    setIsAgorot({})
    setErrorMsg('')
  }

  const previewRows = rawRows.slice(0, 10)

  return (
    <div className="min-h-screen bg-gray-950 text-white px-4 py-10 flex flex-col items-center">
      <div className="w-full max-w-5xl">

        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={onBack}
            className="text-gray-400 hover:text-white transition-colors text-sm"
          >
            ← Back
          </button>
          <h1 className="text-2xl font-bold">Import Holdings</h1>
        </div>

        {/* Error banner */}
        {errorMsg && (
          <div className="mb-5 px-4 py-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm">
            {errorMsg}
          </div>
        )}

        {/* Success */}
        {status === 'done' && (
          <div className="px-6 py-8 rounded-lg bg-green-900/40 border border-green-700 text-green-300 text-center text-lg">
            Import complete — navigating back…
          </div>
        )}

        {/* Dropzone */}
        {status === 'idle' && (
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-20 text-center cursor-pointer transition-colors ${
              isDragOver
                ? 'border-blue-500 bg-blue-950/20'
                : 'border-gray-700 hover:border-gray-500 hover:bg-gray-900/30'
            }`}
          >
            <p className="text-gray-300 text-lg mb-2">Drag & drop a file here, or click to browse</p>
            <p className="text-gray-500 text-sm">.csv · .xlsx · .xls — max 1 MB</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={onFileChange}
            />
          </div>
        )}

        {/* Preview + confirmation */}
        {(status === 'preview' || status === 'submitting') && (
          <>
            {/* Row cap warning */}
            {rawRows.length > MAX_ROWS && (
              <div className="mb-5 px-4 py-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
                Your file has <strong>{rawRows.length}</strong> holdings. We support up to {MAX_ROWS}; only
                the first {MAX_ROWS} will be imported. Edit your file and re-upload to choose which{' '}
                {MAX_ROWS}, or proceed.
              </div>
            )}

            {/* Column mapping */}
            <section className="mb-7">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Column Mapping
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {ALL_FIELDS.map(field => (
                  <div key={field} className="flex flex-col gap-1">
                    <label className="text-xs text-gray-400">{FIELD_LABELS[field]}</label>
                    <select
                      value={colMap[field] ?? -1}
                      onChange={e =>
                        setColMap(prev => ({ ...prev, [field]: Number(e.target.value) }))
                      }
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5 focus:outline-none focus:border-gray-500"
                    >
                      <option value={-1}>— not mapped —</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </section>

            {/* Preview table */}
            <section className="mb-7">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Preview — first {Math.min(10, importRows.length)} of {importRows.length} row
                {importRows.length !== 1 ? 's' : ''}
              </h2>
              <div className="overflow-x-auto rounded-lg border border-gray-800">
                <table className="w-full text-sm">
                  <thead className="bg-gray-900 text-gray-400">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-500">#</th>
                      {ALL_FIELDS.map(f => (
                        <th key={f} className="px-3 py-2 text-left font-medium">
                          {FIELD_LABELS[f]}
                        </th>
                      ))}
                      {nisRowSet.size > 0 && (
                        <th className="px-3 py-2 text-left font-medium">Price in</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, i) => {
                      const isNIS = nisRowSet.has(i)
                      const agorot = isNIS && getIsAgorot(row, i)
                      return (
                        <tr
                          key={i}
                          className={`border-t border-gray-800 ${isNIS ? 'bg-amber-950/10' : ''}`}
                        >
                          <td className="px-3 py-2 text-gray-600">{i + 1}</td>
                          {ALL_FIELDS.map(f => {
                            const val = cellValue(row, f)
                            return (
                              <td key={f} className="px-3 py-2 text-gray-200">
                                {val || <span className="text-gray-600">—</span>}
                              </td>
                            )
                          })}
                          {nisRowSet.size > 0 && (
                            <td className="px-3 py-2">
                              {isNIS ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setIsAgorot(prev => ({ ...prev, [i]: true }))}
                                    className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                                      agorot
                                        ? 'bg-amber-500 text-gray-950'
                                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                                    }`}
                                  >
                                    Agorot
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setIsAgorot(prev => ({ ...prev, [i]: false }))}
                                    className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                                      !agorot
                                        ? 'bg-gray-200 text-gray-950'
                                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                                    }`}
                                  >
                                    Shekels
                                  </button>
                                </div>
                              ) : null}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {/* Note for NIS rows beyond the 10-row preview */}
              {(() => {
                const hiddenNIS = [...nisRowSet].filter(i => i >= 10).length
                return hiddenNIS > 0 ? (
                  <p className="mt-2 text-xs text-amber-600">
                    {hiddenNIS} NIS holding{hiddenNIS !== 1 ? 's' : ''} beyond the preview will use the
                    default unit (price &gt; 1,000 → Agorot, else Shekels). Start over and re-upload if
                    you need to change them.
                  </p>
                ) : null
              })()}
            </section>

            {/* Action buttons */}
            <div className="flex items-center gap-4">
              <button
                onClick={confirm}
                disabled={status === 'submitting'}
                className="px-6 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === 'submitting'
                  ? 'Importing…'
                  : `Import ${importRows.length} holding${importRows.length !== 1 ? 's' : ''}`}
              </button>
              <button
                onClick={reset}
                disabled={status === 'submitting'}
                className="px-4 py-3 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                Start over
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
