import gc
import os
import re
import logging
import tempfile
from difflib import SequenceMatcher

import camelot
import pandas as pd
import PyPDF2
from flask import Blueprint, request, jsonify
from flask_cors import cross_origin

from invoice_extractor import pdf_cache, fetch_and_cache_pdfs

logger = logging.getLogger(__name__)

invoice_analytics_bp = Blueprint('invoice_analytics_bp', __name__)

MAX_FILES = 20
# Pairwise name comparison is quadratic, so it is capped
MAX_VENDORS_COMPARED = 300
FILE_COLUMN = '_file'

# Roles are detected in this order so "Invoice Date" is claimed as the date, not the invoice number
COLUMN_KEYWORDS = {
    'date': ['date'],
    'amount': ['total', 'amount', 'price', 'cost', 'value', 'due'],
    'vendor': ['vendor', 'supplier', 'seller', 'payee', 'merchant', 'company', 'from', 'name'],
    'invoice': ['invoice', 'inv', 'bill', 'reference', 'ref', 'number', 'no', '#'],
}


def read_invoice_rows(pdf_path, source):
    """Reads every table in a PDF into one DataFrame, using the first row as headers."""
    with open(pdf_path, 'rb') as pdf_file:
        total_pages = len(PyPDF2.PdfReader(pdf_file).pages)
    tables = camelot.read_pdf(pdf_path, pages=f'1-{total_pages}', flavor='stream')
    if not tables or len(tables) == 0:
        raise ValueError("No table found in the PDF.")

    headers = [str(h).strip() for h in tables[0].df.iloc[0]]
    frames = []
    for table in tables:
        df = table.df
        if df.shape[1] != len(headers):
            continue
        frames.append(df)
    rows = pd.concat(frames, ignore_index=True)
    # Headers repeat on every page
    rows = rows[~(rows.apply(lambda col: col.str.strip()) == headers).all(axis=1)]
    rows.columns = headers
    rows = rows.loc[:, [h != '' for h in headers]]
    rows = rows.loc[:, ~rows.columns.duplicated()].copy()
    rows[FILE_COLUMN] = source
    return rows


def read_invoice_pdf(pdf_bytes, source):
    """Writes the PDF to a temporary file for Camelot and returns its table rows."""
    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
        tmp.write(pdf_bytes)
    try:
        return read_invoice_rows(tmp.name, source)
    finally:
        # Camelot keeps the PDF open until its objects are collected, which blocks deletion on Windows
        gc.collect()
        try:
            os.remove(tmp.name)
        except OSError:
            logger.warning("Could not remove temporary file %s", tmp.name)


def detect_columns(columns):
    """Guesses which column holds the amount, vendor, invoice number and date."""
    mapping = {}
    for role, keywords in COLUMN_KEYWORDS.items():
        mapping[role] = None
        for keyword in keywords:
            match = next(
                (col for col in columns
                 if col not in mapping.values()
                 and keyword in re.findall(r'[a-z]+|#', col.lower())),
                None
            )
            if match:
                mapping[role] = match
                break
    return mapping


def parse_amount(value):
    """Converts text like '$1,234.50', '1.234,50' or '(99.00)' to a float, or None."""
    text = str(value).strip()
    negative = bool(re.match(r'^\(.*\)$|^\D*-', text))
    digits = re.sub(r'[^\d.,]', '', text)
    if ',' in digits and '.' in digits:
        # Whichever separator comes last is the decimal point
        if digits.rfind(',') > digits.rfind('.'):
            digits = digits.replace('.', '').replace(',', '.')
        else:
            digits = digits.replace(',', '')
    elif ',' in digits:
        head, _, tail = digits.rpartition(',')
        digits = f"{head.replace(',', '')}.{tail}" if len(tail) in (1, 2) else digits.replace(',', '')
    try:
        amount = float(digits)
    except ValueError:
        return None
    return -amount if negative else amount


def to_records(frame):
    return frame[['source', 'invoice', 'vendor', 'date', 'amount']].to_dict('records')


def find_duplicates(data, mapping):
    checks = []
    if mapping['invoice']:
        checks.append(('Same invoice number', ['vendor_key', 'invoice_key'], data['invoice_key'] != ''))
    if mapping['vendor']:
        reason = 'Same vendor, amount and date' if mapping['date'] else 'Same vendor and amount'
        checks.append((reason, ['vendor_key', 'amount', 'date'], data['vendor_key'] != ''))

    duplicates = []
    reported = set()
    for reason, keys, usable in checks:
        for _, group in data[usable].groupby(keys):
            rows = frozenset(group.index)
            if len(group) > 1 and rows not in reported:
                reported.add(rows)
                duplicates.append({'reason': reason, 'rows': to_records(group)})
    return duplicates


def find_unusual_amounts(data):
    if len(data) < 4:
        return []
    q1, median, q3 = data['amount'].quantile([0.25, 0.5, 0.75])
    # Floor the spread so near-identical amounts don't make small differences look unusual
    spread = max(q3 - q1, abs(median) * 0.25)
    low, high = q1 - 1.5 * spread, q3 + 1.5 * spread
    unusual = []
    for record in to_records(data[(data['amount'] < low) | (data['amount'] > high)]):
        direction = 'above' if record['amount'] > high else 'below'
        record['reason'] = f"Well {direction} the typical amount ({median:,.2f})"
        unusual.append(record)
    return unusual


def find_unusual_vendors(data):
    vendors = data[data['vendor_key'] != '']
    counts = vendors['vendor'].value_counts()
    unusual = []

    one_off = counts[counts == 1]
    # Only meaningful when repeat vendors are the norm
    if len(vendors) >= 5 and len(one_off) <= len(counts) / 2:
        for name in one_off.index:
            unusual.append({'vendor': name, 'reason': 'Only one invoice from this vendor'})

    names = list(counts.index[:MAX_VENDORS_COMPARED])
    normalized = [re.sub(r'[^a-z0-9]', '', name.lower()) for name in names]
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            if normalized[i] and SequenceMatcher(None, normalized[i], normalized[j]).ratio() >= 0.9:
                unusual.append({
                    'vendor': names[j],
                    'reason': f'Name is very similar to "{names[i]}" (possible duplicate or misspelling)'
                })
    return unusual


def analyze_invoices(rows, mapping):
    def column(role):
        name = mapping[role]
        return rows[name].astype(str).str.strip() if name else ''

    data = pd.DataFrame({
        'source': rows[FILE_COLUMN],
        'invoice': column('invoice'),
        'vendor': column('vendor'),
        'date': column('date'),
        'amount': rows[mapping['amount']].map(parse_amount),
    })
    # Total/subtotal lines would double count the spend
    is_total_row = rows.drop(columns=[FILE_COLUMN]).apply(
        lambda col: col.astype(str).str.fullmatch(
            r'\s*(sub|grand)?[\s-]*total(\s+(due|amount|payable))?\s*:?\s*', case=False
        )
    ).any(axis=1)
    data = data[~is_total_row].dropna(subset=['amount'])
    if data.empty:
        raise ValueError(f'No numeric amounts found in column "{mapping["amount"]}".')

    data['amount'] = data['amount'].round(2)
    data['vendor_key'] = data['vendor'].str.lower()
    data['invoice_key'] = data['invoice'].str.lower()

    by_vendor = []
    if mapping['vendor']:
        grouped = data[data['vendor_key'] != ''].groupby('vendor')['amount'].agg(['sum', 'count'])
        by_vendor = [
            {'vendor': vendor, 'total': round(float(row['sum']), 2), 'count': int(row['count'])}
            for vendor, row in grouped.sort_values('sum', ascending=False).head(10).iterrows()
        ]

    by_month = []
    if mapping['date']:
        months = pd.to_datetime(data['date'], errors='coerce').dt.strftime('%Y-%m')
        by_month = [
            {'month': month, 'total': round(float(total), 2)}
            for month, total in data.groupby(months)['amount'].sum().items()
        ]

    return {
        'summary': {
            'invoice_count': int(len(data)),
            'file_count': int(data['source'].nunique()),
            'total': round(float(data['amount'].sum()), 2),
            'average': round(float(data['amount'].mean()), 2),
            'largest': round(float(data['amount'].max()), 2),
        },
        'by_vendor': by_vendor,
        'by_month': by_month,
        'duplicates': find_duplicates(data, mapping),
        'unusual_amounts': find_unusual_amounts(data),
        'unusual_vendors': find_unusual_vendors(data) if mapping['vendor'] else [],
    }


@invoice_analytics_bp.route('/invoice_analytics', methods=['POST'])
@cross_origin()
def invoice_analytics():
    """
    Analyzes invoice PDFs for spending, duplicates and unusual amounts or vendors.
    Form fields:
      - source: 'upload' (PDFs in 'files') or 'email' (invoice PDFs from Gmail)
      - refresh: 'true' to re-fetch from Gmail instead of using the cached PDFs
      - amount_column / vendor_column / invoice_column / date_column: optional overrides
    """
    if request.form.get('source') == 'email':
        try:
            if request.form.get('refresh') == 'true' or not pdf_cache['pdfs']:
                fetch_and_cache_pdfs()
        except Exception:
            logger.exception("Failed to fetch invoices from Gmail")
            return jsonify({"error": "Could not fetch invoices from Gmail. Check the server logs."}), 500
        pdfs = [(pdf['filename'], pdf['content']) for pdf in pdf_cache['pdfs']]
        if not pdfs:
            return jsonify({"error": "No 'invoice' emails/attachments found."}), 404
    else:
        files = [f for f in request.files.getlist('files') if f.filename]
        if not files:
            return jsonify({"error": "No file uploaded."}), 400
        if len(files) > MAX_FILES:
            return jsonify({"error": f"Upload at most {MAX_FILES} files at a time."}), 400
        if not all(f.filename.lower().endswith('.pdf') for f in files):
            return jsonify({"error": "Only PDF files are allowed."}), 400
        pdfs = [(os.path.basename(f.filename), f.read()) for f in files]

    frames, skipped = [], []
    for name, content in pdfs:
        try:
            frames.append(read_invoice_pdf(content, name))
        except Exception:
            logger.exception("Could not read tables from %s", name)
            skipped.append(name)
    if not frames:
        return jsonify({"error": "No readable tables were found in the PDFs."}), 400

    rows = pd.concat(frames, ignore_index=True).fillna('')
    columns = [col for col in rows.columns if col != FILE_COLUMN]

    mapping = detect_columns(columns)
    for role in mapping:
        override = request.form.get(f'{role}_column')
        if override is not None:
            mapping[role] = override if override in columns else None

    result = {'columns': columns, 'mapping': mapping, 'skipped': skipped}
    if not mapping['amount']:
        result['message'] = "Could not tell which column holds the amount. Please choose it."
        return jsonify(result)

    try:
        result.update(analyze_invoices(rows, mapping))
    except ValueError as e:
        result['message'] = str(e)
    except Exception:
        logger.exception("Invoice analysis failed")
        return jsonify({"error": "Failed to analyze the invoices."}), 500
    return jsonify(result)
