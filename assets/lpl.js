/* LP (Lovable) sections: reveal animations, plan picker, plan finder quiz, age tabs,
   savings calculator, count-up stats and FAQ. Each lpl-* section loads this file; it runs once
   and re-initialises a section when the theme editor reloads it. */
(function () {
  if (window.__lplLoaded) return;
  window.__lplLoaded = true;

  var TONES = ['pink', 'violet', 'cyan', 'lime', 'orange', 'teal'];
  var ON = ['border-primary', 'bg-primary', 'text-primary-foreground'];

  function $$(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  // root may be the document or a section that the theme editor reloaded
  function pick(root, sel) { return root.matches && root.matches(sel) ? root : root.querySelector(sel); }
  function rupees(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }
  function fill(tpl, map) { return String(tpl || '').replace(/\[(\w+)\]/g, function (m, k) { return k in map ? map[k] : m; }); }
  function setClasses(el, add, remove) {
    remove.forEach(function (c) { el.classList.remove(c); });
    add.forEach(function (c) { el.classList.add(c); });
  }

  /* ---------- plan data shared by the picker, quiz and calculator ---------- */
  function readPlans() {
    var node = document.querySelector('[data-lpl-plan-data]');
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }
  function findPlan(plans, audience, books) {
    for (var i = 0; i < (plans || []).length; i++) {
      if (plans[i].audience === audience && Number(plans[i].books) === Number(books)) return plans[i];
    }
    return null;
  }

  /* ---------- reveal on scroll ---------- */
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.setAttribute('data-shown', 'true');
      io.unobserve(e.target);
      if (e.target.matches('[data-lpl-count]')) countUp(e.target);
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 }) : null;

  function reveal(root) {
    $$(root, '[data-shown="false"], [data-lpl-count]').forEach(function (el) {
      if (io) io.observe(el); else el.setAttribute('data-shown', 'true');
    });
  }

  function countUp(el) {
    var raw = el.getAttribute('data-lpl-count') || '';
    var m = raw.match(/^(\D*)(\d+(?:\.\d+)?)(.*)$/);
    if (!m || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var target = parseFloat(m[2]), start = null, dur = 1400;
    function step(t) {
      if (start === null) start = t;
      var p = Math.min(1, (t - start) / dur), eased = 1 - Math.pow(1 - p, 3);
      el.textContent = m[1] + Math.round(target * eased) + m[3];
      if (p < 1) requestAnimationFrame(step);
    }
    el.textContent = m[1] + '0' + m[3];
    requestAnimationFrame(step);
  }

  /* ---------- monthly plan picker ---------- */
  function initPlans(root) {
    var box = pick(root, '[data-lpl-plans]');
    if (!box || box.__lpl) return;
    box.__lpl = true;
    var plans = readPlans() || [];
    var d = box.dataset;
    var state = { audience: d.defaultAudience || 'single', books: Number(d.defaultBooks) || 5 };
    var audBtns = $$(box, '[data-lpl-aud]'), bookBtns = $$(box, '[data-lpl-books]');
    var cta = box.querySelector('[data-lpl-plan-cta]');

    function paint() {
      if (!findPlan(plans, state.audience, state.books)) {
        var first = plans.filter(function (p) { return p.audience === state.audience; })[0];
        if (first) state.books = Number(first.books);
      }
      var plan = findPlan(plans, state.audience, state.books);
      audBtns.forEach(function (b) {
        var on = b.dataset.lplAud === state.audience;
        b.setAttribute('aria-checked', on);
        setClasses(b, on ? ON : ['border-foreground/40', 'bg-transparent', 'text-foreground', 'hover:border-foreground'],
                      on ? ['border-foreground/40', 'bg-transparent', 'text-foreground', 'hover:border-foreground'] : ON);
      });
      bookBtns.forEach(function (b) {
        var n = Number(b.dataset.lplBooks), on = n === state.books;
        b.hidden = !findPlan(plans, state.audience, n);
        b.setAttribute('aria-checked', on);
        setClasses(b, on ? ON : ['border-foreground/40', 'bg-transparent', 'text-foreground', 'hover:border-foreground'],
                      on ? ['border-foreground/40', 'bg-transparent', 'text-foreground', 'hover:border-foreground'] : ON);
      });
      var who = state.audience === 'siblings' ? d.labelSiblings : d.labelSingle;
      box.querySelector('[data-lpl-plan-summary]').textContent =
        who + ' · ' + state.books + ' ' + d.booksWord + (state.audience === 'siblings' ? d.each : '');
      box.querySelector('[data-lpl-plan-price]').textContent = plan ? rupees(plan.price) : '';
      if (plan && plan.planId) {
        var sep = d.fallbackUrl.indexOf('?') > -1 ? '&' : '?';
        cta.href = d.fallbackUrl + sep + 'plan=' + encodeURIComponent(plan.planId);
      }
      cta.dataset.planId = plan ? plan.planId : '';
    }

    audBtns.forEach(function (b) { b.addEventListener('click', function () { state.audience = b.dataset.lplAud; paint(); }); });
    bookBtns.forEach(function (b) { b.addEventListener('click', function () { state.books = Number(b.dataset.lplBooks); paint(); }); });

    // Reuse the Reading SIP payment popup when its section is on this page.
    cta.addEventListener('click', function (e) {
      var id = cta.dataset.planId;
      if (d.checkout !== 'popup' || !id) return;
      var card = document.querySelector('.sip-card[data-plan-id="' + id + '"]');
      if (!card) return;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('neown:sip-open', { detail: { planId: id, ctaLocation: 'lp_plans' } }));
    });

    window.addEventListener('lpl:select-plan', function (e) {
      state.audience = e.detail.audience;
      state.books = Number(e.detail.books);
      paint();
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    paint();
  }

  /* ---------- sticky "see plans" bar (phones) ---------- */
  function initStickyBar(root) {
    var bar = root.querySelector('[data-lpl-sticky-bar]');
    if (!bar || bar.__lpl || !('IntersectionObserver' in window)) return;
    bar.__lpl = true;
    var hero = document.querySelector('.lpl h1'), plans = document.querySelector('[data-lpl-plans]');
    var seen = { hero: true, plans: false };
    function paint() {
      var on = !seen.hero && !seen.plans;
      bar.classList.toggle('translate-y-full', !on);
      bar.classList.toggle('pointer-events-none', !on);
      // lift the theme's floating buttons (WhatsApp, back to top) above the bar
      document.documentElement.classList.toggle('lpl-bar-on', on);
    }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { seen[e.target === plans ? 'plans' : 'hero'] = e.isIntersecting; });
      paint();
    });
    if (hero) obs.observe(hero); else seen.hero = false;
    if (plans) obs.observe(plans);
    paint();
  }

  /* ---------- plan finder quiz ---------- */
  function initQuiz(root) {
    var quiz = root.querySelector('[data-lpl-quiz]');
    if (!quiz || quiz.__lpl) return;
    quiz.__lpl = true;
    var d = quiz.dataset;
    var answers = {}, step = 0;
    var steps = $$(quiz, '[data-lpl-quiz-step]'), bars = $$(quiz, '[data-lpl-quiz-bar]');

    function show(n) {
      step = n;
      steps.forEach(function (s) { s.hidden = s.dataset.lplQuizStep !== String(n); });
      bars.forEach(function (b, i) {
        var tone = TONES[i % TONES.length];
        b.classList.add('bg-ink-' + tone);
        setClasses(b, i <= (n === 'result' ? 3 : n) ? ['w-full'] : ['w-0'], i <= (n === 'result' ? 3 : n) ? ['w-0'] : ['w-full']);
      });
    }
    function open() {
      answers = {};
      $$(quiz, '[data-lpl-quiz-answer]').forEach(clearPick);
      show(0);
      quiz.hidden = false;
      document.documentElement.classList.add('lpl-lock');
    }
    function close() {
      quiz.hidden = true;
      document.documentElement.classList.remove('lpl-lock');
    }
    function clearPick(btn) {
      TONES.forEach(function (t) { btn.classList.remove('border-ink-' + t, 'bg-tint-' + tint(t)); });
      btn.classList.add('border-border', 'bg-background');
    }
    function tint(t) { return t === 'teal' ? 'cyan' : t; }  // there is no teal tint; teal uses the cyan one
    function result() {
      var plans = readPlans() || [];
      var audience = answers[1] === 'siblings' ? 'siblings' : 'single';
      var books = Number(answers[2]) || 5;
      var plan = findPlan(plans, audience, books);
      quiz.querySelector('[data-lpl-quiz-name]').textContent = fill(d.resultName, {
        books: books, who: audience === 'siblings' ? d.whoSiblings : d.whoSingle
      });
      quiz.querySelector('[data-lpl-quiz-price]').textContent = plan ? rupees(plan.price) + d.priceSuffix : '';
      // Sample covers: the age tab matching the first answer, otherwise the book shelf.
      var panel = document.querySelector('[data-lpl-age-panel="' + (answers.ageIndex || 0) + '"]');
      var imgs = panel ? $$(panel, 'img') : [];
      if (imgs.length < 3) imgs = $$(document, '.lpl [data-lpl-shelf] img, .lpl #top-books li:not([aria-hidden]) img');
      var wrap = quiz.querySelector('[data-lpl-quiz-books]');
      wrap.innerHTML = '';
      imgs.slice(0, 3).forEach(function (img) {
        var title = img.getAttribute('alt') || '';
        var fig = document.createElement('figure');
        fig.innerHTML = '<div class="rounded-2xl bg-card p-2"><img loading="lazy" class="aspect-[3/4] w-full rounded-md object-cover shadow-[var(--shadow-book)]"></div>' +
                        '<figcaption class="mt-1.5 line-clamp-2 text-[11px] font-medium leading-tight text-muted-foreground"></figcaption>';
        fig.querySelector('img').src = img.currentSrc || img.src;
        fig.querySelector('img').alt = title;
        fig.querySelector('figcaption').textContent = title.replace(/ book cover$/, '');
        wrap.appendChild(fig);
      });
      quiz.__plan = { audience: audience, books: books };
      show('result');
    }

    $$(root, '[data-lpl-quiz-open]').forEach(function (b) { b.addEventListener('click', open); });
    $$(quiz, '[data-lpl-quiz-close]').forEach(function (b) { b.addEventListener('click', close); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !quiz.hidden) close(); });
    steps.forEach(function (s) {
      var n = Number(s.dataset.lplQuizStep);
      $$(s, '[data-lpl-quiz-answer]').forEach(function (btn, i) {
        btn.addEventListener('click', function () {
          $$(s, '[data-lpl-quiz-answer]').forEach(clearPick);
          var tone = TONES[i % TONES.length];
          btn.classList.remove('border-border', 'bg-background');
          btn.classList.add('border-ink-' + tone, 'bg-tint-' + tint(tone));
          answers[n] = btn.dataset.lplQuizAnswer;
          if (n === 0) answers.ageIndex = i;
          if (n < 2) show(n + 1); else result();
        });
      });
    });
    $$(quiz, '[data-lpl-quiz-back]').forEach(function (b) { b.addEventListener('click', function () { show(Math.max(0, step - 1)); }); });
    quiz.querySelector('[data-lpl-quiz-restart]').addEventListener('click', function () { show(0); });
    quiz.querySelector('[data-lpl-quiz-go]').addEventListener('click', function () {
      close();
      if (quiz.__plan) window.dispatchEvent(new CustomEvent('lpl:select-plan', { detail: quiz.__plan }));
    });
  }

  /* ---------- books by age tabs ---------- */
  function initAges(root) {
    var box = pick(root, '[data-lpl-ages]');
    if (!box || box.__lpl) return;
    box.__lpl = true;
    var tabs = $$(box, '[data-lpl-age-tab]');
    var browse = box.querySelector('[data-lpl-age-browse]');
    // "Browse books" opens the selected tab's collection, or the section's own link when the tab has none.
    function pointBrowse(tab) {
      if (browse) browse.href = (tab && tab.dataset.collectionUrl) || browse.dataset.defaultHref;
    }
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) {
          var on = t === tab, tone = t.dataset.tone;
          t.setAttribute('aria-selected', on);
          setClasses(t, on ? ['bg-ink-' + tone, 'text-background'] : ['text-muted-foreground', 'hover:text-foreground'],
                        on ? ['text-muted-foreground', 'hover:text-foreground'] : ['bg-ink-' + tone, 'text-background']);
        });
        $$(box, '[data-lpl-age-panel]').forEach(function (p) { p.hidden = p.dataset.lplAgePanel !== tab.dataset.lplAgeTab; });
        pointBrowse(tab);
      });
    });
    pointBrowse(tabs[0]);
  }

  /* ---------- savings calculator ---------- */
  function initSavings(root) {
    var box = pick(root, '[data-lpl-savings]');
    if (!box || box.__lpl) return;
    box.__lpl = true;
    var d = box.dataset;
    var plans = readPlans();
    if (!plans || !plans.length) {
      plans = String(d.fallbackPrices || '').split(/\n/).map(function (line) {
        var p = line.split('|').map(function (x) { return x.trim(); });
        return p.length >= 3 ? { audience: p[0], books: Number(p[1]), price: Number(p[2]) } : null;
      }).filter(Boolean);
    }
    var avg = Number(d.avgPrice) || 450, kgPer = parseFloat(d.kgPerBook) || 0.3;
    var range = box.querySelector('[data-lpl-sv-months]');
    var state = { audience: 'single', books: Number(d.defaultBooks) || 5, months: Number(d.defaultMonths) || 12 };
    var OFF = ['border-border', 'bg-background', 'text-foreground'];

    function out(sel, text) { var el = box.querySelector(sel); if (el) el.textContent = text; }
    function paint() {
      $$(box, '[data-lpl-sv-kids]').forEach(function (b) {
        var on = b.dataset.lplSvKids === state.audience;
        b.setAttribute('aria-pressed', on);
        setClasses(b, on ? ON : OFF, on ? OFF : ON);
      });
      $$(box, '[data-lpl-sv-books]').forEach(function (b) {
        var on = Number(b.dataset.lplSvBooks) === state.books;
        b.setAttribute('aria-pressed', on);
        setClasses(b, on ? ON : OFF, on ? OFF : ON);
      });
      var plan = findPlan(plans, state.audience, state.books);
      var monthly = plan ? Number(plan.price) : 0;
      var count = state.books * state.months * (state.audience === 'siblings' ? 2 : 1);
      var buying = count * avg, neown = monthly * state.months, saved = Math.max(0, buying - neown);
      var pct = buying ? Math.round(saved / buying * 100) : 0;
      out('[data-lpl-sv-months-out]', state.months + ' ' + (state.months === 1 ? d.month : d.months));
      out('[data-lpl-sv-estimate]', fill(d.estimate, { count: count, avg: rupees(avg), monthly: rupees(monthly) }));
      out('[data-lpl-sv-saved]', rupees(saved));
      out('[data-lpl-sv-less]', fill(d.less, { percent: pct, count: count, buying: rupees(buying) }));
      out('[data-lpl-sv-buying]', rupees(buying));
      out('[data-lpl-sv-neown]', rupees(neown));
      out('[data-lpl-sv-kg]', fill(d.kg, { kg: Math.round(count * kgPer) }));
      out('[data-lpl-sv-count]', String(count));
      var bar = box.querySelector('[data-lpl-sv-bar]');
      if (bar) bar.style.width = (buying ? Math.min(100, neown / buying * 100) : 0) + '%';
      if (range) {
        range.value = state.months;
        var pctRange = (state.months - range.min) / ((range.max - range.min) || 1) * 100;
        range.style.setProperty('--lpl-range', pctRange + '%');
      }
    }
    $$(box, '[data-lpl-sv-kids]').forEach(function (b) { b.addEventListener('click', function () { state.audience = b.dataset.lplSvKids; paint(); }); });
    $$(box, '[data-lpl-sv-books]').forEach(function (b) { b.addEventListener('click', function () { state.books = Number(b.dataset.lplSvBooks); paint(); }); });
    if (range) range.addEventListener('input', function () { state.months = Number(range.value); paint(); });
    paint();
  }

  /* ---------- FAQ accordion (one open at a time) ---------- */
  function initFaq(root) {
    var box = pick(root, '[data-lpl-faq]');
    if (!box || box.__lpl) return;
    box.__lpl = true;
    var qs = $$(box, '[data-lpl-faq-q]');
    qs.forEach(function (q) {
      q.addEventListener('click', function () {
        var open = q.getAttribute('aria-expanded') !== 'true';
        qs.forEach(function (o) {
          var on = o === q && open;
          o.setAttribute('aria-expanded', on);
          o.closest('[data-state]').setAttribute('data-state', on ? 'open' : 'closed');
          document.getElementById(o.getAttribute('aria-controls')).hidden = !on;
        });
      });
    });
  }

  function init(root) {
    root = root || document;
    reveal(root);
    initPlans(root);
    initStickyBar(root);
    initQuiz(root);
    initAges(root);
    initSavings(root);
    initFaq(root);
    // The hero heading animates in straight away.
    $$(root, '.lpl h1[data-shown="false"]').forEach(function (h) {
      requestAnimationFrame(function () { h.setAttribute('data-shown', 'true'); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
  else init();
  document.addEventListener('shopify:section:load', function (e) { init(e.target); });
})();
