/* OakView Mail — small progressive enhancements. No frameworks. */
(function () {
  'use strict';

  // Mobile sidebar toggle
  var menuBtn = document.getElementById('menuBtn');
  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      document.body.classList.toggle('nav-open');
    });
    document.addEventListener('click', function (e) {
      if (document.body.classList.contains('nav-open') && !e.target.closest('#sidebar') && !e.target.closest('#menuBtn')) {
        document.body.classList.remove('nav-open');
      }
    });
  }

  // Auto-dismiss flash messages
  document.querySelectorAll('.flash').forEach(function (el) {
    setTimeout(function () {
      el.style.transition = 'opacity .4s ease';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 420);
    }, 6000);
  });

  // Confirm destructive actions
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });
  document.querySelectorAll('a[data-confirm], button[data-confirm]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (!window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Copy-to-clipboard
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(btn.getAttribute('data-copy')).then(function () {
        var original = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = original; }, 1400);
      });
    });
  });

  // Character counters: <textarea data-counter="#target">
  document.querySelectorAll('[data-counter]').forEach(function (el) {
    var target = document.querySelector(el.getAttribute('data-counter'));
    if (!target) return;
    var update = function () { target.textContent = el.value.length; };
    el.addEventListener('input', update);
    update();
  });

  // Live preview: <textarea data-preview="#frame"> renders into an iframe
  document.querySelectorAll('[data-preview-into]').forEach(function (el) {
    var frame = document.querySelector(el.getAttribute('data-preview-into'));
    if (!frame) return;
    var render = function () {
      var doc = frame.contentDocument || frame.contentWindow.document;
      doc.open(); doc.write(el.value || '<p style="font-family:sans-serif;color:#888;padding:20px;">Nothing to preview yet.</p>'); doc.close();
    };
    el.addEventListener('input', debounce(render, 350));
    render();
  });

  // Auto-submit filter forms on change
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { el.form && el.form.requestSubmit(); });
  });

  // Inbox: bulk message selection (select-all, live count, enable delete)
  var bulkForm = document.getElementById('inboxBulkForm');
  if (bulkForm) {
    var boxes = Array.prototype.slice.call(bulkForm.querySelectorAll('.msg-check'));
    var selectAll = document.getElementById('selectAllMsgs');
    var countEl = document.getElementById('bulkCount');
    var deleteBtn = document.getElementById('bulkDeleteBtn');

    var syncBulk = function () {
      var n = boxes.filter(function (c) { return c.checked; }).length;
      if (countEl) countEl.textContent = n + ' selected';
      if (deleteBtn) deleteBtn.disabled = n === 0;
      if (selectAll) {
        selectAll.checked = n > 0 && n === boxes.length;
        selectAll.indeterminate = n > 0 && n < boxes.length;
      }
    };

    boxes.forEach(function (c) { c.addEventListener('change', syncBulk); });
    if (selectAll) {
      selectAll.addEventListener('change', function () {
        boxes.forEach(function (c) { c.checked = selectAll.checked; });
        syncBulk();
      });
    }
    syncBulk();
  }

  // Copy a preview screen (test email helper): fill a hidden field from a select
  document.querySelectorAll('[data-fill]').forEach(function (el) {
    var source = document.querySelector(el.getAttribute('data-fill'));
    if (source) source.value = source.value || el.value;
  });

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      var args = arguments, self = this;
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
})();
