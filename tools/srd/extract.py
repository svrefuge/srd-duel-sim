"""Extract ordered, font-annotated lines from the SRD 5.2.1 PDF."""
import fitz

FOOTER_Y = 738.0
COL_SPLIT = 300.0


def load_lines(pdf):
    """Return [{'p','col','y','spans':[{'f','sz','t','x','x1'}]}] in reading order.

    MuPDF's own line grouping is authoritative: italic labels and the regular
    text beside them have slightly different bbox tops, so re-clustering spans
    by y would split one visual line into an italics-only and a regulars-only
    line. Lines are only re-ordered here, never regrouped.
    """
    doc = fitz.open(pdf)
    out = []
    for pno, page in enumerate(doc):
        rows = []
        for b in page.get_text('dict')['blocks']:
            if b['type'] != 0:
                continue
            for l in b['lines']:
                spans = [s for s in l['spans'] if s['text'].strip()]
                if not spans:
                    continue
                y0 = min(s['bbox'][1] for s in spans)
                if y0 >= FOOTER_Y:
                    continue
                x0 = min(s['bbox'][0] for s in spans)
                rows.append({
                    'p': pno, 'col': 0 if x0 < COL_SPLIT else 1, 'y': round(y0, 1),
                    'spans': [{'f': s['font'], 'sz': round(s['size'], 1), 't': s['text'],
                               'x': round(s['bbox'][0], 1), 'x1': round(s['bbox'][2], 1)}
                              for s in sorted(spans, key=lambda s: s['bbox'][0])]})
        rows.sort(key=lambda r: (r['col'], r['y']))
        out.extend(rows)
    return out


def line_text(line):
    """Concatenate spans, restoring the space the PDF encodes as an x-gap."""
    out = ''
    prev_end = None
    for s in line['spans']:
        if out and prev_end is not None and s['x'] - prev_end > 1.2 \
                and not out.endswith(' ') and not s['t'].startswith(' '):
            out += ' '
        out += s['t']
        prev_end = s['x1']
    return out


def is_name(line):
    s = line['spans'][0]
    return s['f'] == 'GillSans-SemiBold' and s['sz'] == 14.8


def is_group(line):
    s = line['spans'][0]
    return s['f'] == 'GillSans-SemiBold' and s['sz'] >= 17.0


def is_body(line):
    """Cambria is the chapter body font; stat blocks never use it."""
    return line['spans'][0]['f'].startswith('Cambria')


def load_words(pdf):
    """Per-page word boxes: {page: [[x0,y0,x1,y1,text], ...]}.

    The ability table encodes score/modifier/save purely by column position, so
    each number needs its own x; span-level text is too coarse.
    """
    doc = fitz.open(pdf)
    out = {}
    for pno, page in enumerate(doc):
        ws = []
        for w in page.get_text('words'):
            x0, y0, x1, y1, text = w[0], w[1], w[2], w[3], w[4]
            if y0 >= FOOTER_Y or not text.strip():
                continue
            ws.append([round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1), text])
        out[str(pno)] = ws
    return out
