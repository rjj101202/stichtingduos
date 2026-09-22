// Inline bewerkmodus voor ingelogde beheerders.
// Elk element met data-edit="type:id:veld" wordt bewerkbaar (contenteditable).
(function () {
  var toggle = document.getElementById('edit-toggle');
  var controls = document.getElementById('edit-controls');
  var saveBtn = document.getElementById('edit-save');
  var cancelBtn = document.getElementById('edit-cancel');
  var statusEl = document.getElementById('edit-status');
  if (!toggle) return;

  var editables = Array.prototype.slice.call(document.querySelectorAll('[data-edit]'));
  if (!editables.length) return;
  toggle.hidden = false;

  var originals = new Map();
  var editing = false;

  function enterEdit() {
    editing = true;
    document.body.classList.add('editing');
    toggle.classList.add('active');
    toggle.textContent = '✏️ Bewerkmodus aan';
    controls.hidden = false;
    editables.forEach(function (el) {
      originals.set(el, el.innerHTML);
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'false');
      el.addEventListener('input', markDirty);
      // Links niet laten navigeren tijdens bewerken
      el.addEventListener('click', blockLinks, true);
    });
    window.addEventListener('beforeunload', warnUnsaved);
  }

  function exitEdit(restore) {
    editing = false;
    document.body.classList.remove('editing');
    toggle.classList.remove('active');
    toggle.textContent = '✏️ Bewerken';
    controls.hidden = true;
    editables.forEach(function (el) {
      if (restore && originals.has(el)) el.innerHTML = originals.get(el);
      el.removeAttribute('contenteditable');
      el.classList.remove('edit-dirty');
      el.removeEventListener('input', markDirty);
      el.removeEventListener('click', blockLinks, true);
    });
    originals.clear();
    window.removeEventListener('beforeunload', warnUnsaved);
  }

  function markDirty(e) {
    e.currentTarget.classList.add('edit-dirty');
  }

  function blockLinks(e) {
    var a = e.target.closest && e.target.closest('a');
    if (a && editing) e.preventDefault();
  }

  function warnUnsaved(e) {
    var dirty = editables.some(function (el) { return el.classList.contains('edit-dirty'); });
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  }

  toggle.addEventListener('click', function () {
    if (editing) exitEdit(true); else enterEdit();
  });

  cancelBtn.addEventListener('click', function () { exitEdit(true); });

  saveBtn.addEventListener('click', function () {
    var changes = [];
    editables.forEach(function (el) {
      if (!el.classList.contains('edit-dirty')) return;
      var key = el.getAttribute('data-edit');
      var isText = /:(title|text)$/.test(key);
      changes.push({ key: key, value: isText ? el.textContent.trim() : el.innerHTML.trim() });
    });
    if (!changes.length) { exitEdit(false); return; }
    statusEl.textContent = 'Opslaan…';
    saveBtn.disabled = true;
    fetch('/admin/api/inline-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: changes }),
      credentials: 'same-origin',
    }).then(function (r) { return r.json(); }).then(function (res) {
      saveBtn.disabled = false;
      if (res.ok) {
        statusEl.textContent = '✓ Opgeslagen';
        exitEdit(false);
        location.reload();
      } else {
        statusEl.textContent = 'Er ging iets mis bij het opslaan van sommige velden.';
        console.error(res);
      }
    }).catch(function (err) {
      saveBtn.disabled = false;
      statusEl.textContent = 'Opslaan mislukt: ' + err.message;
    });
  });
})();
