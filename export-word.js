/**
 * Submission Store & Word Export System
 * ─────────────────────────────────────
 * Persists form submissions as JSON files in a GitHub repository.
 * The browser reads via the GitHub Contents API and writes back
 * via PUT, which triggers a Netlify redeploy automatically.
 *
 * Each form page calls:
 *   SubmissionManager.init('disbursements', 'disbursements.html', 'Disbursements Data Sheet', 'Disbursement-DataSheet')
 *
 * Requires (loaded before this script):
 *   <script src="https://unpkg.com/docx@8.5.0/build/index.umd.js"></script>
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js"></script>
 */

// ── CONFIGURATION ─────────────────────────────────────────────────────────────
//
// GITHUB_TOKEN: Create a fine-grained Personal Access Token at
//   https://github.com/settings/tokens?type=beta
//   Permissions needed: Contents → Read and write (on this repo only).
//   ⚠ This token is visible in browser source. Scope it to this repo only.
//
const GITHUB_CONFIG = {
  owner:   'shane-permalloo',
  repo:    'sicdc-datasheet',
  branch:  'main',
  folder:  'data',                 // subfolder in the repo for JSON files
  // ⚠ No token here — stored as GITHUB_TOKEN in Netlify Environment Variables.
  // API calls are proxied through netlify/functions/github-proxy.js
  siteUrl: 'https://sicdc-datasheet.netlify.app'
};
// ──────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════
// SubmissionStore – GitHub-backed CRUD for one form type
// ═══════════════════════════════════════════════════════
class SubmissionStore {
  constructor(formKey) {
    this.formKey  = formKey;
    this.filePath = GITHUB_CONFIG.folder + '/submissions-' + formKey + '.json';
    this._cache   = null;   // in-memory array
    this._sha     = null;   // current blob SHA required for GitHub PUT
  }

  // ── GitHub API helpers (via Netlify serverless proxy) ───

  get _apiBase() {
    // Requests go to the Netlify Function which injects GITHUB_TOKEN server-side
    return `/.netlify/functions/github-proxy?file=${encodeURIComponent(this.filePath)}`;
  }

  get _headers() {
    return { Accept: 'application/json' };
  }

  /** Fetch the file from GitHub (via proxy) and populate the cache. */
  async load() {
    const res = await fetch(this._apiBase, {
      headers: this._headers
    });
    if (res.status === 404) {
      // File not yet created in repo — start with empty array
      this._cache = [];
      this._sha   = null;
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`GitHub read error ${res.status}: ${err.message || res.statusText}`);
    }
    const json      = await res.json();
    this._sha       = json.sha;
    const decoded   = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ''))));
    try   { this._cache = JSON.parse(decoded); }
    catch { this._cache = []; }
  }

  /** Commit the current cache back to GitHub. */
  async _flush(commitMessage) {
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(this._cache, null, 2))));
    const body    = {
      message: commitMessage || `Update ${this.filePath}`,
      content,
      branch: GITHUB_CONFIG.branch
    };
    if (this._sha) body.sha = this._sha;

    const res = await fetch(this._apiBase, {
      method:  'PUT',
      headers: { ...this._headers, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // 409 = SHA conflict (another user saved concurrently) — re-load and retry
      if (res.status === 409) throw Object.assign(new Error('conflict'), { isConflict: true });
      throw new Error(`GitHub write error ${res.status}: ${err.message || res.statusText}`);
    }
    const json  = await res.json();
    this._sha   = json.content.sha;   // update SHA for the next write
  }

  /** Flush with automatic retry on SHA conflict (re-fetch, re-apply, re-commit). */
  async _flushWithRetry(applyFn, commitMessage) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await this.load();   // re-fetch latest before retrying
      applyFn();                            // re-apply the change to fresh cache
      try {
        await this._flush(commitMessage);
        return;
      } catch (e) {
        if (!e.isConflict || attempt === 2) throw e;
      }
    }
  }

  // ── Synchronous reads (from in-memory cache) ──
  getAll()    { return this._cache || []; }
  getById(id) { return (this._cache || []).find(s => s.id === id) || null; }

  // ── Async writes ──
  async add(data) {
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      savedAt: new Date().toISOString(),
      data
    };
    await this._flushWithRetry(
      () => { if (!this._cache.find(e => e.id === entry.id)) this._cache.push(entry); },
      `Add submission to ${this.filePath}`
    );
    return entry;
  }

  async update(id, data) {
    let updated = null;
    await this._flushWithRetry(() => {
      const idx = this._cache.findIndex(s => s.id === id);
      if (idx !== -1) {
        this._cache[idx].data    = data;
        this._cache[idx].savedAt = new Date().toISOString();
        updated = this._cache[idx];
      }
    }, `Update submission ${id} in ${this.filePath}`);
    return updated;
  }

  async remove(id) {
    await this._flushWithRetry(
      () => { this._cache = this._cache.filter(s => s.id !== id); },
      `Delete submission ${id} from ${this.filePath}`
    );
  }
}

// ═══════════════════════════════════════════════════════
// Form data collection helpers
// ═══════════════════════════════════════════════════════

/** Collect field-group data from the DOM as {label, value} pairs */
function _collectFormFields() {
  const fieldGroups = document.querySelectorAll('.field-group');
  const fields = [];

  fieldGroups.forEach(group => {
    const labelEl = group.querySelector('.field-label');
    if (!labelEl) return;
    const label = labelEl.textContent.replace(/\*/g, '').trim();
    const input = group.querySelector('.field-input');
    if (!input) return;

    let value = '';
    if (input.tagName === 'SELECT') {
      const selected = input.options[input.selectedIndex];
      value = (selected && !selected.disabled) ? selected.text : '';
    } else if (input.type === 'checkbox') {
      value = input.checked ? 'Yes' : 'No';
    } else {
      value = input.value || '';
    }

    if (!value && input.disabled && input.placeholder) {
      value = input.placeholder;
    }

    fields.push({ label, value });
  });

  return fields;
}

/** Collect CRUD table data from .related-section blocks */
function _collectCrudTables() {
  const crudTables = [];

  document.querySelectorAll('.related-section').forEach(section => {
    const title = section.querySelector('.section-title')?.textContent?.trim() || 'Related Items';
    const table = section.querySelector('.crud-table');
    if (!table) return;

    const headers = [];
    const skipIndices = new Set();
    table.querySelectorAll('thead th').forEach((th, i) => {
      if (th.classList.contains('no-print') || th.textContent.trim() === 'Actions') {
        skipIndices.add(i);
      } else {
        headers.push(th.textContent.trim());
      }
    });

    const rows = [];
    table.querySelectorAll('tbody tr:not(.empty-row)').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('td').forEach((td, i) => {
        if (skipIndices.has(i)) return;
        const inp = td.querySelector('input, select');
        if (inp) {
          cells.push(
            inp.tagName === 'SELECT'
              ? (inp.options[inp.selectedIndex]?.text || '')
              : inp.value
          );
        } else {
          cells.push(td.textContent.trim());
        }
      });
      if (cells.length > 0 && cells.some(c => c)) rows.push(cells);
    });

    crudTables.push({ title, headers, rows });
  });

  return crudTables;
}

/** Populate form from saved data */
function _populateForm(data) {
  const fieldGroups = document.querySelectorAll('.field-group');
  const saved = data.fields || [];

  fieldGroups.forEach((group, i) => {
    const labelEl = group.querySelector('.field-label');
    if (!labelEl) return;
    const label = labelEl.textContent.replace(/\*/g, '').trim();
    const input = group.querySelector('.field-input');
    if (!input || input.disabled) return;

    const match = saved.find(f => f.label === label);
    if (!match) return;

    if (input.tagName === 'SELECT') {
      for (let opt of input.options) {
        if (opt.text === match.value) { input.selectedIndex = opt.index; break; }
      }
    } else if (input.type === 'checkbox') {
      input.checked = match.value === 'Yes';
    } else {
      // Use native setter to trigger any change listeners
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (nativeSetter) nativeSetter.call(input, match.value);
      else input.value = match.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

/** Clear all form inputs */
function _clearForm() {
  const fieldGroups = document.querySelectorAll('.field-group');
  fieldGroups.forEach(group => {
    const input = group.querySelector('.field-input');
    if (!input || input.disabled) return;
    if (input.tagName === 'SELECT') {
      input.selectedIndex = 0;
    } else if (input.type === 'checkbox') {
      input.checked = false;
    } else if (!input.readOnly) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

// ═══════════════════════════════════════════════════════
// Submissions panel UI
// ═══════════════════════════════════════════════════════

function _renderSubmissionsPanel(store) {
  const panel = document.getElementById('submissionsPanel');
  if (!panel) return;

  const submissions = store.getAll();
  const repoLabel   = `${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo} → ${store.filePath}`;

  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;
                background:#f1f5f9;border-bottom:1px solid #e2e8f0;font-size:0.8rem;
                border-radius:10px 10px 0 0;">
      <span style="color:#475569;">
        ⚙ <strong>GitHub</strong>: ${_escapeHtml(repoLabel)}
        &nbsp;·&nbsp; ${submissions.length} submission${submissions.length !== 1 ? 's' : ''}
      </span>
      <button class="btn btn-ghost btn-sm" onclick="SubmissionManager.refresh()" title="Reload latest data from GitHub">
        ↻ Refresh
      </button>
    </div>`;

  if (submissions.length === 0) {
    html += `
      <div style="text-align:center;color:#94a3b8;padding:20px;font-size:0.88rem;">
        No submissions yet. Fill the form and click "Save Submission".
      </div>`;
  } else {
    html += `
      <table class="crud-table" style="min-width:auto;border-radius:0 0 10px 10px;">
        <thead>
          <tr>
            <th>#</th>
            <th>Saved At</th>
            <th>Summary</th>
            <th class="no-print">Actions</th>
          </tr>
        </thead>
        <tbody>`;

    submissions.forEach((sub, idx) => {
      const date    = new Date(sub.savedAt);
      const dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        + ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      const summary = (sub.data.fields || [])
        .filter(f => f.value
          && f.label !== 'Disbursement Status'
          && f.label !== 'Loan Facility Account Status'
          && f.label !== 'LOC Status'
          && f.label !== 'Repayment Status')
        .slice(0, 3)
        .map(f => f.value)
        .join(' | ');

      html += `
          <tr>
            <td>${idx + 1}</td>
            <td style="white-space:nowrap;">${dateStr}</td>
            <td>${_escapeHtml(summary) || '—'}</td>
            <td class="no-print">
              <div class="actions">
                <button type="button" class="btn btn-ghost btn-sm"
                        onclick="SubmissionManager.loadSubmission('${sub.id}')">Edit</button>
                <button type="button" class="btn btn-danger btn-sm"
                        onclick="SubmissionManager.deleteSubmission('${sub.id}')">Delete</button>
              </div>
            </td>
          </tr>`;
    });

    html += '</tbody></table>';
  }

  panel.innerHTML = html;
}

function _escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════
// Word document generation (all submissions in one doc)
// ═══════════════════════════════════════════════════════

function _generateWordDoc(store, formTitle, fileName, formHtmlFile) {
  const {
    Document, Packer, Paragraph, TextRun, ExternalHyperlink,
    Table, TableRow, TableCell,
    WidthType, HeadingLevel, ShadingType, BorderStyle
  } = docx;

  const submissions = store.getAll();
  if (submissions.length === 0) {
    alert('No saved submissions to export. Save at least one submission first.');
    return;
  }

  const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: 'D0D5DD' };
  const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  const children = [];

  // Document title
  children.push(new Paragraph({
    children: [new TextRun({ text: formTitle, bold: true, size: 32, font: 'Calibri' })],
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 100 }
  }));

  children.push(new Paragraph({
    children: [new TextRun({
      text: 'Generated: ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        + '  |  Total submissions: ' + submissions.length,
      italics: true, color: '888888', size: 18, font: 'Calibri'
    })],
    spacing: { after: 400 }
  }));

  // Each submission as its own block
  submissions.forEach((sub, idx) => {
    const date = new Date(sub.savedAt);
    const dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    // Section heading with separator
    if (idx > 0) {
      children.push(new Paragraph({
        children: [new TextRun({ text: '─'.repeat(60), color: 'CCCCCC', size: 16, font: 'Calibri' })],
        spacing: { before: 400, after: 200 }
      }));
    }

    children.push(new Paragraph({
      children: [new TextRun({
        text: `Submission #${idx + 1}  —  ${dateStr}`,
        bold: true, size: 24, font: 'Calibri'
      })],
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 80 }
    }));

    // Edit reference — hyperlink when siteUrl is set, plain ID when not configured
    if (GITHUB_CONFIG.siteUrl) {
      const editUrl = GITHUB_CONFIG.siteUrl.replace(/\/$/, '') + '/' + formHtmlFile + '?edit=' + encodeURIComponent(sub.id);
      children.push(new Paragraph({
        children: [
          new ExternalHyperlink({
            children: [new TextRun({
              text: '✎ Click to edit this submission',
              color: '2563EB', underline: { type: 'single' }, size: 18, font: 'Calibri'
            })],
            link: editUrl
          })
        ],
        spacing: { after: 200 }
      }));
    } else {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: 'Submission ID: ', bold: true, size: 18, font: 'Calibri', color: '64748B' }),
          new TextRun({ text: sub.id, size: 18, font: 'Courier New', color: '475569' }),
          new TextRun({ text: '  — To edit, open the form in your browser and click Edit in the Saved Submissions panel.', italics: true, size: 16, font: 'Calibri', color: '94A3B8' })
        ],
        spacing: { after: 200 }
      }));
    }

    // Field table
    const fields = sub.data.fields || [];
    if (fields.length > 0) {
      const tableRows = fields.map(f => new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({
              children: [new TextRun({ text: f.label, bold: true, size: 20, font: 'Calibri' })],
              spacing: { before: 60, after: 60 }
            })],
            width: { size: 40, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.SOLID, color: 'F8F9FC' },
            borders
          }),
          new TableCell({
            children: [new Paragraph({
              children: [new TextRun({ text: f.value || '—', size: 20, font: 'Calibri' })],
              spacing: { before: 60, after: 60 }
            })],
            width: { size: 60, type: WidthType.PERCENTAGE },
            borders
          })
        ]
      }));

      children.push(new Table({
        rows: tableRows,
        width: { size: 100, type: WidthType.PERCENTAGE }
      }));
    }

    // CRUD tables within this submission
    const crudTables = sub.data.crudTables || [];
    crudTables.forEach(ct => {
      children.push(new Paragraph({ text: '', spacing: { before: 200 } }));
      children.push(new Paragraph({
        children: [new TextRun({ text: ct.title, bold: true, size: 22, font: 'Calibri' })],
        heading: HeadingLevel.HEADING_3,
        spacing: { after: 100 }
      }));

      if (!ct.rows || ct.rows.length === 0) {
        children.push(new Paragraph({
          children: [new TextRun({ text: 'No items', italics: true, color: '999999', size: 20, font: 'Calibri' })],
          spacing: { after: 100 }
        }));
      } else {
        const headerRow = new TableRow({
          children: ct.headers.map(h => new TableCell({
            children: [new Paragraph({
              children: [new TextRun({ text: h, bold: true, size: 18, font: 'Calibri' })],
              spacing: { before: 50, after: 50 }
            })],
            shading: { type: ShadingType.SOLID, color: 'F1F5F9' },
            borders
          }))
        });

        const dataRows = ct.rows.map(row => new TableRow({
          children: row.map(cell => new TableCell({
            children: [new Paragraph({
              children: [new TextRun({ text: cell || '—', size: 18, font: 'Calibri' })],
              spacing: { before: 50, after: 50 }
            })],
            borders
          }))
        }));

        children.push(new Table({
          rows: [headerRow, ...dataRows],
          width: { size: 100, type: WidthType.PERCENTAGE }
        }));
      }
    });
  });

  // Generate and download
  const doc = new Document({ sections: [{ children }] });

  Packer.toBlob(doc).then(blob => {
    // Fixed filename (no date) so the same 4 files are always overwritten/found at the same path
    saveAs(blob, fileName + '.docx');
  });
}

// ═══════════════════════════════════════════════════════
// SubmissionManager – public API used by each form page
// ═══════════════════════════════════════════════════════
const SubmissionManager = {
  _store: null,
  _formHtmlFile: null,
  _formTitle: null,
  _fileName: null,
  _editingId: null,

  /**
   * Initialize the submission system for a form page.
   * Loads the JSON file from GitHub on page load.
   */
  async init(formKey, formHtmlFile, formTitle, fileName) {
    this._store        = new SubmissionStore(formKey);
    this._formHtmlFile = formHtmlFile;
    this._formTitle    = formTitle;
    this._fileName     = fileName;
    this._editingId    = null;

    // Show loading state
    const panel = document.getElementById('submissionsPanel');
    if (panel) panel.innerHTML = `<div style="padding:16px;color:#94a3b8;font-size:0.88rem;text-align:center;">Loading submissions from GitHub…</div>`;

    try {
      await this._store.load();
    } catch (e) {
      if (panel) panel.innerHTML = `<div style="padding:16px;color:#dc2626;font-size:0.88rem;background:#fef2f2;border-radius:8px;">
        <strong>Could not load data from GitHub.</strong><br>${_escapeHtml(e.message)}<br>
        <small>Check that the token in GITHUB_CONFIG is set correctly.</small></div>`;
      return;
    }

    // Check for ?edit=<id> in URL (from Word doc hyperlinks)
    const editId = new URLSearchParams(window.location.search).get('edit');
    if (editId) {
      const sub = this._store.getById(editId);
      if (sub) {
        this._editingId = editId;
        setTimeout(() => {
          _populateForm(sub.data);
          this._updateSaveButtonLabel();
          if (typeof window._loadCrudTablesFromData === 'function') {
            window._loadCrudTablesFromData(sub.data.crudTables || []);
          }
        }, 100);
      }
    }

    this._renderPanel();
    this._updateSaveButtonLabel();
  },

  /** Re-fetch the latest data from GitHub and refresh the panel. */
  async refresh() {
    const panel = document.getElementById('submissionsPanel');
    if (panel) panel.innerHTML = `<div style="padding:16px;color:#94a3b8;font-size:0.88rem;text-align:center;">Refreshing…</div>`;
    try {
      await this._store.load();
      this._renderPanel();
    } catch (e) {
      alert('Refresh failed: ' + e.message);
      this._renderPanel();
    }
  },

  /** Save the current form as a new submission, or update the one being edited. */
  async saveSubmission() {
    const data = {
      fields:     _collectFormFields(),
      crudTables: _collectCrudTables()
    };
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      if (this._editingId) {
        await this._store.update(this._editingId, data);
        alert('Submission updated and committed to GitHub.');
      } else {
        const entry = await this._store.add(data);
        this._editingId = entry.id;
        alert('Submission saved to GitHub.');
      }
    } catch (e) {
      alert('Save failed: ' + e.message);
      if (saveBtn) saveBtn.disabled = false;
      return;
    }
    if (saveBtn) saveBtn.disabled = false;
    this._renderPanel();
    this._updateSaveButtonLabel();
  },

  /** Load a submission into the form for editing. */
  loadSubmission(id) {
    const sub = this._store.getById(id);
    if (!sub) { alert('Submission not found.'); return; }
    this._editingId = id;
    _populateForm(sub.data);
    if (typeof window._loadCrudTablesFromData === 'function') {
      window._loadCrudTablesFromData(sub.data.crudTables || []);
    }
    this._updateSaveButtonLabel();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  /** Delete a submission and commit the change to GitHub. */
  async deleteSubmission(id) {
    if (!confirm('Delete this submission? It will be permanently removed from GitHub.')) return;
    try {
      await this._store.remove(id);
    } catch (e) {
      alert('Delete failed: ' + e.message);
      return;
    }
    if (this._editingId === id) {
      this._editingId = null;
      _clearForm();
      this._updateSaveButtonLabel();
    }
    this._renderPanel();
  },

  /** Clear the form for a new blank submission. */
  newSubmission() {
    this._editingId = null;
    _clearForm();
    if (typeof window._loadCrudTablesFromData === 'function') {
      window._loadCrudTablesFromData([]);
    }
    this._updateSaveButtonLabel();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  /** Generate and download the Word document for all saved submissions. */
  downloadWord() {
    _generateWordDoc(this._store, this._formTitle, this._fileName, this._formHtmlFile);
  },

  _renderPanel() {
    _renderSubmissionsPanel(this._store);
    const badge = document.getElementById('submissionCount');
    if (badge) badge.textContent = this._store.getAll().length;
  },

  _updateSaveButtonLabel() {
    const btn = document.getElementById('saveBtn');
    if (!btn) return;
    if (this._editingId) {
      btn.textContent      = '✓ Update Submission';
      btn.style.background = '#d97706';
    } else {
      btn.textContent      = '+ Save Submission';
      btn.style.background = '#16a34a';
    }
  }
};
