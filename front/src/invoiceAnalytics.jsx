import { useState } from 'react';
import { BarChart3, Upload, Mail, Check, AlertCircle, AlertTriangle, Loader } from 'lucide-react';

const ROLES = [
  { key: 'amount', label: 'Amount' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'invoice', label: 'Invoice number' },
  { key: 'date', label: 'Date' },
];

const formatAmount = (value) =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const renderBars = (items, labelKey) => {
  const max = Math.max(...items.map((item) => Math.abs(item.total)), 1);
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item[labelKey]}>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-700 truncate mr-3" title={item[labelKey]}>
              {item[labelKey]}
              {item.count !== undefined && (
                <span className="text-gray-400"> · {item.count} invoice{item.count === 1 ? '' : 's'}</span>
              )}
            </span>
            <span className="font-medium text-gray-800">{formatAmount(item.total)}</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[#FE6059] to-rose-500 rounded-full"
              style={{ width: `${(Math.abs(item.total) / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

const renderInvoiceRow = (row, index) => (
  <li key={index} className="flex flex-wrap justify-between gap-x-4 text-sm text-gray-700">
    <span>
      {[row.vendor, row.invoice && `#${row.invoice}`, row.date].filter(Boolean).join(' · ') || 'Invoice'}
      <span className="text-gray-400"> ({row.source})</span>
    </span>
    <span className="font-medium text-gray-800">{formatAmount(row.amount)}</span>
  </li>
);

export default function InvoiceAnalytics() {
  const [mode, setMode] = useState('upload'); // "upload" or "email"
  const [files, setFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [mapping, setMapping] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const reset = () => {
    setResult(null);
    setMapping({});
    setError('');
  };

  const handleModeChange = (newMode) => {
    setMode(newMode);
    setFiles([]);
    reset();
  };

  const handleFiles = (fileList) => {
    const pdfs = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    reset();
    if (!pdfs.length) {
      setError('Please choose PDF files.');
      return;
    }
    setFiles(pdfs);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  // columnOverrides is only sent when the user re-runs the analysis with their own column choices
  const analyze = async (columnOverrides) => {
    setLoading(true);
    setError('');
    const formData = new FormData();
    formData.append('source', mode);
    if (mode === 'upload') {
      files.forEach((f) => formData.append('files', f));
    } else if (!columnOverrides) {
      formData.append('refresh', 'true');
    }
    if (columnOverrides) {
      ROLES.forEach(({ key }) => formData.append(`${key}_column`, columnOverrides[key] || ''));
    }

    try {
      const response = await fetch('http://localhost:5000/invoice_analytics', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        throw new Error(data.error || 'Failed to analyze invoices. ' + response.statusText);
      }
      setResult(data);
      setMapping(data.mapping);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const canAnalyze = !loading && (mode === 'email' || files.length > 0);
  const flagCount = result?.summary
    ? result.duplicates.length + result.unusual_amounts.length + result.unusual_vendors.length
    : 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#FFF8F8] to-[#FFF0F0] py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        {/* Header Section */}
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <div className="bg-white p-3 rounded-full shadow-lg">
              <BarChart3 size={32} className="text-[#FE6059]" />
            </div>
          </div>
          <h1 className="text-3xl font-extrabold text-gray-800 sm:text-4xl mb-2">
            Invoice Analytics
          </h1>
          <div className="h-1 w-16 bg-gradient-to-r from-[#FE6059] to-rose-500 mx-auto rounded-full mb-4"></div>
          <p className="mt-3 text-lg text-gray-600 max-w-2xl mx-auto">
            Summarize spending, catch duplicate invoices, and flag unusual amounts or vendors
          </p>
        </div>

        {/* Mode Toggle Section */}
        <div className="bg-white rounded-xl shadow-lg p-1.5 flex w-full max-w-md mx-auto mb-8">
          <button
            onClick={() => handleModeChange('upload')}
            className={`flex-1 flex items-center justify-center space-x-2 px-4 py-3 rounded-lg transition-all duration-300 ${
              mode === 'upload'
                ? 'bg-[#FE6059] text-white shadow-md'
                : 'bg-transparent text-gray-600 hover:bg-gray-100'
            }`}
          >
            <Upload size={18} />
            <span>Upload PDFs</span>
          </button>
          <button
            onClick={() => handleModeChange('email')}
            className={`flex-1 flex items-center justify-center space-x-2 px-4 py-3 rounded-lg transition-all duration-300 ${
              mode === 'email'
                ? 'bg-[#FE6059] text-white shadow-md'
                : 'bg-transparent text-gray-600 hover:bg-gray-100'
            }`}
          >
            <Mail size={18} />
            <span>From Emails</span>
          </button>
        </div>

        {/* Input Card */}
        <div className="bg-white rounded-xl shadow-lg overflow-hidden border border-gray-100 mb-8">
          {mode === 'upload' && (
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
              onDrop={handleDrop}
              className={`p-8 transition-all duration-300 border-b border-gray-100 ${
                isDragging ? 'bg-[#FE6059]/5 border-[#FE6059] border-dashed' : 'hover:bg-gray-50'
              }`}
            >
              <div className="flex flex-col items-center justify-center text-center space-y-4">
                <div className={`p-4 rounded-full ${
                  files.length ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'
                }`}>
                  {files.length ? <Check size={28} /> : <Upload size={28} />}
                </div>
                <div className="space-y-1">
                  <h3 className="text-lg font-medium text-gray-800">
                    {files.length
                      ? `${files.length} file${files.length === 1 ? '' : 's'} ready`
                      : 'Upload your PDF invoices'}
                  </h3>
                  <p className="text-sm text-gray-500">
                    {files.length
                      ? files.map((f) => f.name).join(', ')
                      : 'Drag and drop one or more files here, or click to select'}
                  </p>
                </div>
                <label className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[#FE6059] hover:bg-[#FE6059]/90 cursor-pointer transform hover:-translate-y-0.5 transition-all duration-200">
                  <span>{files.length ? 'Change Files' : 'Select Files'}</span>
                  <input
                    type="file"
                    accept="application/pdf"
                    multiple
                    onChange={(e) => handleFiles(e.target.files)}
                    className="sr-only"
                  />
                </label>
              </div>
            </div>
          )}

          <div className="p-6 bg-gray-50 flex justify-center">
            <button
              onClick={() => analyze()}
              disabled={!canAnalyze}
              className={`flex items-center justify-center px-8 py-3 rounded-lg shadow-md transition-all duration-300 ${
                canAnalyze
                  ? 'bg-gradient-to-r from-[#FE6059] to-rose-500 text-white hover:-translate-y-0.5 hover:shadow-lg'
                  : 'bg-gray-200 cursor-not-allowed text-gray-500'
              }`}
            >
              {loading ? (
                <><Loader size={20} className="mr-2 animate-spin" /> Analyzing...</>
              ) : mode === 'upload' ? (
                <><BarChart3 size={20} className="mr-2" /> Analyze Invoices</>
              ) : (
                <><Mail size={20} className="mr-2" /> Fetch &amp; Analyze Emails</>
              )}
            </button>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-8 overflow-hidden rounded-lg shadow-md">
            <div className="flex items-center p-4 bg-red-50 border-l-4 border-red-500">
              <AlertCircle className="text-red-500 h-5 w-5 flex-shrink-0" />
              <p className="ml-3 text-sm text-red-700">{error}</p>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-8">
            {/* Column Mapping */}
            <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6">
              <h3 className="text-lg font-medium text-gray-800 mb-1">Columns used</h3>
              <p className="text-sm text-gray-500 mb-4">
                These were detected automatically. Change them if they look wrong.
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {ROLES.map(({ key, label }) => (
                  <label key={key} className="text-sm text-gray-600">
                    {label}
                    <select
                      value={mapping[key] || ''}
                      onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
                      className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1.5 text-gray-800"
                    >
                      <option value="">Not used</option>
                      {result.columns.map((col) => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <button
                onClick={() => analyze(mapping)}
                disabled={loading}
                className="mt-4 text-sm px-4 py-2 border border-gray-200 rounded-md hover:bg-gray-50 text-gray-700 transition-colors disabled:opacity-50"
              >
                Re-analyze with these columns
              </button>
              {result.message && (
                <p className="mt-4 text-sm text-amber-700">{result.message}</p>
              )}
              {result.skipped.length > 0 && (
                <p className="mt-4 text-sm text-amber-700">
                  No readable table found in: {result.skipped.join(', ')}
                </p>
              )}
            </div>

            {result.summary && (
              <>
                {/* Spending Summary */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    ['Total spend', formatAmount(result.summary.total)],
                    ['Invoices', result.summary.invoice_count],
                    ['Average', formatAmount(result.summary.average)],
                    ['Largest', formatAmount(result.summary.largest)],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-white rounded-xl shadow-lg border border-gray-100 p-5">
                      <p className="text-sm text-gray-500">{label}</p>
                      <p className="mt-1 text-xl font-bold text-gray-800 truncate" title={value}>{value}</p>
                    </div>
                  ))}
                </div>

                {result.by_vendor.length > 0 && (
                  <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6">
                    <h3 className="text-lg font-medium text-gray-800 mb-4">Top vendors by spend</h3>
                    {renderBars(result.by_vendor, 'vendor')}
                  </div>
                )}

                {result.by_month.length > 0 && (
                  <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6">
                    <h3 className="text-lg font-medium text-gray-800 mb-4">Spend by month</h3>
                    {renderBars(result.by_month, 'month')}
                  </div>
                )}

                {/* Flags */}
                <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6">
                  <div className="flex items-center mb-4">
                    {flagCount > 0
                      ? <AlertTriangle size={20} className="text-amber-500" />
                      : <Check size={20} className="text-green-600" />}
                    <h3 className="ml-2 text-lg font-medium text-gray-800">
                      {flagCount > 0 ? `${flagCount} item${flagCount === 1 ? '' : 's'} to review` : 'Nothing unusual found'}
                    </h3>
                  </div>

                  {result.duplicates.length > 0 && (
                    <div className="mb-6">
                      <h4 className="text-sm font-semibold text-gray-800 mb-2">Possible duplicate invoices</h4>
                      <div className="space-y-3">
                        {result.duplicates.map((group, index) => (
                          <div key={index} className="p-3 rounded-lg bg-amber-50 border border-amber-100">
                            <p className="text-xs font-medium text-amber-800 mb-2">{group.reason}</p>
                            <ul className="space-y-1">{group.rows.map(renderInvoiceRow)}</ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.unusual_amounts.length > 0 && (
                    <div className="mb-6">
                      <h4 className="text-sm font-semibold text-gray-800 mb-2">Unusual amounts</h4>
                      <div className="space-y-3">
                        {result.unusual_amounts.map((row, index) => (
                          <div key={index} className="p-3 rounded-lg bg-amber-50 border border-amber-100">
                            <p className="text-xs font-medium text-amber-800 mb-2">{row.reason}</p>
                            <ul>{renderInvoiceRow(row, index)}</ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.unusual_vendors.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800 mb-2">Unusual vendors</h4>
                      <ul className="space-y-2">
                        {result.unusual_vendors.map((item, index) => (
                          <li key={index} className="p-3 rounded-lg bg-amber-50 border border-amber-100 text-sm text-gray-700">
                            <span className="font-medium text-gray-800">{item.vendor}</span> — {item.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
