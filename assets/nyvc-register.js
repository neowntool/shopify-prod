/* neOwn Young Voices Championship: registration popup (details → OTP → save → thank-you page).
   Talks to the NYVC Google Apps Script web app; the MSG91 key lives there, never here. */
(function () {
  'use strict';
  var root = document.querySelector('[data-nyvc-reg]');
  if (!root || root.__nyvc) return;
  root.__nyvc = true;

  var endpoint = (root.getAttribute('data-endpoint') || '').trim();
  var thankYou = root.getAttribute('data-thank-you') || '/pages/nyvc-thank-you';
  var dialog = root.querySelector('.nyvc-reg-dialog');
  var form = root.querySelector('.nyvc-reg-form');
  var otpForm = root.querySelector('.nyvc-reg-otp');
  var detailsBtn = form.querySelector('.nyvc-reg-btn');
  var otpBtn = otpForm.querySelector('.nyvc-reg-btn');
  var otpInputs = [].slice.call(otpForm.querySelectorAll('[data-otp]'));
  var resendBtn = otpForm.querySelector('[data-resend]');
  var resendLabel = otpForm.querySelector('[data-resend-label]');
  var lastFocus = null;
  var resendTimer = null;
  var regId = null;
  var STORE = 'nyvc_registration';

  /* ---------- open / close ---------- */
  function open() {
    lastFocus = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add('nyvc-reg-open');
    showStep(1);
    setTimeout(function () { var f = form.querySelector('input'); if (f) f.focus(); }, 30);
  }
  function close() {
    root.hidden = true;
    document.documentElement.classList.remove('nyvc-reg-open');
    if (location.hash === '#nyvc-form') history.replaceState(null, '', location.pathname + location.search);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href$="#nyvc-form"], [data-nyvc-form]');
    if (a) { e.preventDefault(); open(); }
  });
  root.addEventListener('click', function (e) { if (e.target.closest('[data-nyvc-close]')) close(); });
  document.addEventListener('keydown', function (e) {
    if (root.hidden) return;
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') trapFocus(e);
  });
  function trapFocus(e) {
    var els = [].slice.call(dialog.querySelectorAll('button, input, select, a[href]')).filter(function (el) {
      return !el.disabled && el.offsetParent !== null;
    });
    if (!els.length) return;
    var first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  if (location.hash === '#nyvc-form') open();

  function showStep(n) {
    form.hidden = n !== 1;
    otpForm.hidden = n !== 2;
    dialog.classList.toggle('is-otp', n === 2);
    root.querySelector('[data-step-dot="2"]').classList.toggle('is-active', n === 2);
    dialog.scrollTop = 0;
  }

  /* ---------- details form ---------- */
  var fields = ['child_name', 'dob', 'gender', 'school', 'standard', 'division', 'parent_name', 'email', 'phone'];
  function val(name) { var el = form.elements[name]; return el ? String(el.value || '').trim() : ''; }
  function setErr(name, msg) {
    var p = root.querySelector('[data-err="' + name + '"]');
    if (p) { p.textContent = msg || ''; p.classList.remove('is-info'); }
    var el = form.elements[name];
    if (el && el.setAttribute) {
      el.classList.toggle('is-invalid', !!msg);
      if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    }
  }
  /* Returns a helpful message if the date of birth is not usable, or '' if it is fine. */
  function dobProblem(dob) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dob);
    if (!m) return 'Enter the date of birth as DD/MM/YYYY, for example 15/08/2015.';
    var d = new Date(+m[3], +m[2] - 1, +m[1]);
    if (d.getDate() !== +m[1] || d.getMonth() !== +m[2] - 1) return 'This date does not exist. Check the day and month (DD/MM/YYYY).';
    var now = new Date();
    if (d > now) return 'The date of birth cannot be in the future.';
    var age = now.getFullYear() - d.getFullYear();
    if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
    if (age < 4) return 'The child must be at least 4 years old. Check the year of birth.';
    if (age > 18) return 'The championship is for school students up to 18 years old. Check the year of birth.';
    return '';
  }
  function check(name) {
    var v = val(name);
    switch (name) {
      case 'child_name': return v.length >= 2 ? '' : "Enter the child's full name.";
      case 'dob': return dobProblem(v);
      case 'gender': return v ? '' : "Select the child's gender.";
      case 'school': return v ? '' : 'Select the school.';
      case 'standard': return v ? '' : 'Select the standard.';
      case 'division': return v ? '' : 'Enter the division or section.';
      case 'parent_name': return v.length >= 2 ? '' : "Enter the parent or guardian's name.";
      case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Enter a valid email address.';
      case 'phone': return /^[6-9]\d{9}$/.test(v) ? '' : 'Enter a valid 10-digit mobile number.';
    }
    return '';
  }
  function allFilled() { return fields.every(function (f) { return val(f) !== ''; }); }
  function refreshDetailsBtn() { detailsBtn.disabled = !allFilled(); }

  form.elements.dob.addEventListener('input', function (e) {
    var d = this.value.replace(/\D/g, '').slice(0, 8);
    var out = d.slice(0, 2);
    if (d.length > 2) out += '/' + d.slice(2, 4);
    if (d.length > 4) out += '/' + d.slice(4);
    if (e.inputType && e.inputType.indexOf('delete') === 0) out = this.value.replace(/[^\d/]/g, '').slice(0, 10);
    this.value = out;
  });
  /* Pasted or autofilled numbers like "+91 98765 43210", "091-98765-43210" or "919876543210"
     become "9876543210". A leading 91 or 0 is only kept while the number is still being typed. */
  function cleanPhone(v) {
    var d = String(v || '').replace(/\D/g, '').slice(0, 14);
    var m = /^(?:0091|091|91|0)(\d{10})$/.exec(d);
    if (m) return m[1];
    return /^(?:0|91)/.test(d) && d.length <= 12 ? d : d.slice(0, 10);
  }
  form.elements.phone.addEventListener('input', function () { this.value = cleanPhone(this.value); });
  form.addEventListener('input', function (e) { if (e.target.name) setErr(e.target.name, ''); setErr('form', ''); refreshDetailsBtn(); });
  form.addEventListener('change', refreshDetailsBtn);
  fields.forEach(function (f) {
    var el = form.elements[f];
    el && el.addEventListener('blur', function () { if (val(f)) setErr(f, check(f)); });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var firstBad = null;
    fields.forEach(function (f) { var m = check(f); setErr(f, m); if (m && !firstBad) firstBad = f; });
    if (firstBad) { form.elements[firstBad].focus(); return; }
    if (!endpoint) { setErr('form', 'Registration is not open yet. Please try again later.'); return; }
    busy(detailsBtn, true, 'Sending OTP…');
    call({ action: 'send_otp', phone: val('phone'), child_name: val('child_name') }).then(function (r) {
      busy(detailsBtn, false);
      if (!r.ok && r.error === 'already_registered') { alreadyRegistered(r.message); return; }
      if (!r.ok) { setErr(r.error === 'invalid_phone' ? 'phone' : 'form', r.message); return; }
      root.querySelector('[data-otp-phone]').textContent = '+91 ' + val('phone');
      clearOtp();
      showStep(2);
      startResendTimer();
      otpInputs[0].focus();
    }, function () { busy(detailsBtn, false); setErr('form', 'Could not connect. Please check your internet and try again.'); });
  });

  /* ---------- OTP ---------- */
  function otpValue() { return otpInputs.map(function (i) { return i.value; }).join(''); }
  function clearOtp() { otpInputs.forEach(function (i) { i.value = ''; }); otpBtn.disabled = true; setOtpErr(''); info(''); }
  function setOtpErr(m) { root.querySelector('[data-err="otp"]').textContent = m || ''; otpInputs.forEach(function (i) { i.classList.toggle('is-invalid', !!m); }); }
  function info(m) { root.querySelector('[data-otp-info]').textContent = m || ''; }
  function fillFrom(index, digits) {
    for (var k = 0; k < digits.length && index + k < otpInputs.length; k++) { otpInputs[index + k].value = digits[k]; otpInputs[index + k].__prev = digits[k]; }
    var next = Math.min(index + digits.length, otpInputs.length - 1);
    otpInputs[next].focus();
  }
  otpInputs.forEach(function (input, idx) {
    input.addEventListener('input', function () {
      var d = this.value.replace(/\D/g, '');
      if (d.length > 1) {
        /* Autofill or paste puts the whole code in one box; typing over a filled box adds one digit. */
        if (d.length === 2 && this.__prev) d = d.replace(this.__prev, '') || d.slice(-1);
        if (d.length > 1) { this.value = ''; fillFrom(idx, d.slice(0, 6 - idx)); }
        else { this.value = d; if (idx < 5) otpInputs[idx + 1].focus(); }
      }
      else { this.value = d; if (d && idx < 5) otpInputs[idx + 1].focus(); }
      otpInputs.forEach(function (i) { i.__prev = i.value; });
      setOtpErr('');
      otpBtn.disabled = otpValue().length !== 6;
      if (otpValue().length === 6 && document.activeElement === otpInputs[5]) otpForm.requestSubmit ? otpForm.requestSubmit() : otpBtn.click();
    });
    input.addEventListener('focus', function () { this.select(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !this.value && idx > 0) { otpInputs[idx - 1].value = ''; otpInputs[idx - 1].focus(); otpBtn.disabled = true; }
      if (e.key === 'ArrowLeft' && idx > 0) otpInputs[idx - 1].focus();
      if (e.key === 'ArrowRight' && idx < 5) otpInputs[idx + 1].focus();
    });
    input.addEventListener('paste', function (e) {
      var t = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '');
      if (!t) return;
      e.preventDefault();
      fillFrom(0, t.slice(0, 6));
      otpBtn.disabled = otpValue().length !== 6;
    });
  });

  otpForm.querySelector('[data-edit-phone]').addEventListener('click', function () {
    stopResendTimer();
    showStep(1);
    form.elements.phone.focus();
    form.elements.phone.select();
  });

  function startResendTimer() {
    stopResendTimer();
    var left = 30;
    resendBtn.disabled = true;
    resendLabel.textContent = 'Resend OTP in ' + left + 's';
    resendTimer = setInterval(function () {
      left--;
      if (left <= 0) { stopResendTimer(); return; }
      resendLabel.textContent = 'Resend OTP in ' + left + 's';
    }, 1000);
  }
  function stopResendTimer() {
    if (resendTimer) clearInterval(resendTimer);
    resendTimer = null;
    resendBtn.disabled = false;
    resendLabel.textContent = 'Resend OTP';
  }
  resendBtn.addEventListener('click', function () {
    resendBtn.disabled = true;
    setOtpErr('');
    call({ action: 'resend_otp', phone: val('phone') }).then(function (r) {
      if (!r.ok) { setOtpErr(r.message); resendBtn.disabled = false; return; }
      info('A new OTP has been sent.');
      startResendTimer();
    }, function () { resendBtn.disabled = false; setOtpErr('Could not connect. Please try again.'); });
  });

  otpForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (otpBtn.disabled && otpValue().length !== 6) return;
    if (otpValue().length !== 6) { setOtpErr('Enter the 6-digit OTP.'); return; }
    if (otpBtn.getAttribute('aria-busy') === 'true') return;
    regId = regId || ('NYVC-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase());
    var data = {};
    fields.forEach(function (f) { data[f] = val(f); });
    var params = new URLSearchParams(location.search);
    info('');
    busy(otpBtn, true, 'Verifying…');
    call({
      action: 'register', id: regId, otp: otpValue(), form: data, page: location.pathname,
      utm_source: params.get('utm_source') || '', utm_medium: params.get('utm_medium') || '', utm_campaign: params.get('utm_campaign') || ''
    }).then(function (r) {
      if (!r.ok) {
        busy(otpBtn, false);
        if (r.error === 'invalid_form' && r.field) { showStep(1); setErr(r.field, r.message); return; }
        if (r.error === 'already_registered') { stopResendTimer(); showStep(1); alreadyRegistered(r.message); return; }
        setOtpErr(r.message);
        return;
      }
      var saved = { id: r.id || regId, child_name: data.child_name, standard: data.standard, school: data.school };
      try { sessionStorage.setItem(STORE, JSON.stringify(saved)); } catch (err) {}
      try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch (err) {}
      try { (window.dataLayer = window.dataLayer || []).push({ event: 'nyvc_registration', nyvc_standard: data.standard }); } catch (err) {}
      busy(otpBtn, true, 'Verified! Taking you to the next step…');
      var url = thankYou + (thankYou.indexOf('?') === -1 ? '?' : '&') + 'ref=' + encodeURIComponent(saved.id);
      location.href = url;
    }, function () { busy(otpBtn, false); setOtpErr('Could not connect. Please check your internet and try again.'); });
  });

  /* Same phone + child name is already in the sheet: say so instead of sending an OTP. */
  function alreadyRegistered(msg) {
    var box = root.querySelector('[data-err="form"]');
    box.textContent = '';
    box.classList.add('is-info');
    var strong = document.createElement('strong');
    strong.textContent = 'Already registered';
    box.appendChild(strong);
    box.appendChild(document.createTextNode(msg || 'This child is already registered with this phone number.'));
    box.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- helpers ---------- */
  function busy(btn, on, label) {
    if (!btn.__label) btn.__label = btn.textContent;
    btn.disabled = !!on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    btn.textContent = on ? (label || btn.__label) : btn.__label;
    if (!on && btn === detailsBtn) refreshDetailsBtn();
    if (!on && btn === otpBtn) btn.disabled = otpValue().length !== 6;
  }
  /* text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight. */
  function call(payload) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : null;
    return fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) { if (t) clearTimeout(t); return res.json(); });
  }
})();
