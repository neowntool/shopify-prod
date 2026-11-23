/* neOwn Young Voices Championship: video upload popup.
   Phone → (registered? school deadline open?) → OTP → choose child + video → upload to Google Drive.
   The Apps Script web app checks everything; the browser sends the file straight to the Drive upload
   link it gets back, and falls back to sending it through the script in pieces if that is blocked. */
(function () {
  'use strict';
  var root = document.querySelector('[data-nyvc-upload]');
  if (!root || root.__nyvc) return;
  root.__nyvc = true;

  function endpoint() {
    var own = (root.getAttribute('data-endpoint') || '').trim();
    if (own) return own;
    var reg = document.querySelector('[data-nyvc-reg]');
    return reg ? (reg.getAttribute('data-endpoint') || '').trim() : '';
  }

  var dialog = root.querySelector('.nyvc-reg-dialog');
  var steps = {
    phone: root.querySelector('[data-up="phone"]'),
    otp: root.querySelector('[data-up="otp"]'),
    file: root.querySelector('[data-up="file"]'),
    done: root.querySelector('[data-up="done"]')
  };
  var phoneForm = steps.phone, otpForm = steps.otp, fileForm = steps.file;
  var phoneInput = phoneForm.elements.phone;
  var phoneBtn = phoneForm.querySelector('.nyvc-reg-btn');
  var otpBtn = otpForm.querySelector('.nyvc-reg-btn');
  var uploadBtn = fileForm.querySelector('.nyvc-reg-btn');
  var otpInputs = [].slice.call(otpForm.querySelectorAll('[data-otp]'));
  var resendBtn = otpForm.querySelector('[data-resend]');
  var resendLabel = otpForm.querySelector('[data-resend-label]');
  var fileInput = fileForm.querySelector('[data-file-input]');
  var drop = fileForm.querySelector('[data-drop]');
  var kidsBox = fileForm.querySelector('[data-kids]');
  var kidList = fileForm.querySelector('[data-kid-list]');
  var progress = fileForm.querySelector('[data-progress]');

  var state = { token: null, kids: [], kidId: null, file: null, maxMb: 500, uploading: false, xhr: null, cancelled: false };
  var lastFocus = null, resendTimer = null;

  /* ---------- open / close ---------- */
  function open() {
    lastFocus = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add('nyvc-reg-open');
    if (!state.token) showStep('phone');
    setTimeout(function () { var el = dialog.querySelector('[data-up]:not([hidden]) input:not([type="file"]), [data-up]:not([hidden]) .nyvc-reg-btn'); if (el) el.focus(); }, 30);
  }
  function close() {
    if (state.uploading && !window.confirm('Your video is still uploading. Stop the upload and close?')) return;
    if (state.uploading) cancelUpload();
    root.hidden = true;
    document.documentElement.classList.remove('nyvc-reg-open');
    if (location.hash === '#nyvc-upload') history.replaceState(null, '', location.pathname + location.search);
    if (!steps.done.hidden) reset();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function reset() {
    state.token = null; state.kids = []; state.kidId = null; setFile(null);
    clearOtp(); setErr('lookup', ''); setErr('file', '');
    showStep('phone');
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href$="#nyvc-upload"], [data-nyvc-upload-open]');
    if (a) { e.preventDefault(); open(); }
  });
  root.addEventListener('click', function (e) {
    if (e.target.closest('[data-nyvc-close]')) { close(); return; }
    /* "Register now" inside the not-registered notice: swap to the registration popup. */
    if (e.target.closest('a[href$="#nyvc-form"]')) { root.hidden = true; document.documentElement.classList.remove('nyvc-reg-open'); }
  });
  document.addEventListener('keydown', function (e) {
    if (root.hidden) return;
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') trapFocus(e);
  });
  function trapFocus(e) {
    var els = [].slice.call(dialog.querySelectorAll('button, input:not([type="file"]), label[for], a[href]')).filter(function (el) {
      return !el.disabled && el.offsetParent !== null;
    });
    if (!els.length) return;
    var first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  window.addEventListener('beforeunload', function (e) { if (state.uploading) { e.preventDefault(); e.returnValue = ''; } });
  if (location.hash === '#nyvc-upload') open();

  function showStep(name) {
    Object.keys(steps).forEach(function (k) { steps[k].hidden = k !== name; });
    var two = name === 'file' || name === 'done';
    dialog.classList.toggle('is-otp', name !== 'phone');
    root.querySelector('[data-step-dot="2"]').classList.toggle('is-active', two);
    root.querySelector('.nyvc-reg-steps').hidden = name === 'done';
    dialog.scrollTop = 0;
  }

  /* ---------- messages ---------- */
  function setErr(name, msg) {
    var p = root.querySelector('[data-err="' + name + '"]');
    if (!p) return;
    p.textContent = msg || '';
    p.classList.remove('is-info');
    if (name === 'phone') {
      phoneInput.classList.toggle('is-invalid', !!msg);
      if (msg) phoneInput.setAttribute('aria-invalid', 'true'); else phoneInput.removeAttribute('aria-invalid');
    }
  }
  /* Purple notice box: a heading, a message and an optional link. */
  function notice(name, heading, msg, link) {
    var box = root.querySelector('[data-err="' + name + '"]');
    box.textContent = '';
    box.classList.add('is-info');
    var strong = document.createElement('strong');
    strong.textContent = heading;
    box.appendChild(strong);
    box.appendChild(document.createTextNode(msg));
    if (link) {
      var a = document.createElement('a');
      a.href = link.href; a.className = 'nyvc-up-notice-link'; a.textContent = link.label;
      box.appendChild(a);
    }
    box.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- step 1: phone ---------- */
  function phoneVal() { return String(phoneInput.value || '').trim(); }
  phoneInput.addEventListener('input', function () {
    var d = this.value.replace(/\D/g, '');
    if (d.length > 10 && d.indexOf('91') === 0) d = d.slice(2);
    this.value = d.slice(0, 10);
    setErr('phone', ''); setErr('lookup', '');
    phoneBtn.disabled = this.value.length === 0;
  });
  phoneForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!/^[6-9]\d{9}$/.test(phoneVal())) { setErr('phone', 'Enter a valid 10-digit mobile number.'); phoneInput.focus(); return; }
    if (root.getAttribute('data-open') !== 'true' || !endpoint()) {
      notice('lookup', 'Not open yet', root.getAttribute('data-closed-message') || 'Video submission opens soon. Please check back later.');
      return;
    }
    setErr('lookup', '');
    busy(phoneBtn, true, 'Checking…');
    call({ action: 'upload_lookup', phone: phoneVal() }).then(function (r) {
      busy(phoneBtn, false);
      if (!r.ok) {
        if (r.error === 'not_registered') notice('lookup', 'Not registered yet', r.message, document.querySelector('[data-nyvc-reg]') ? { href: '#nyvc-form', label: 'Register now' } : null);
        else if (r.error === 'submission_closed') notice('lookup', 'Video submission is closed', r.message);
        else setErr(r.error === 'invalid_phone' ? 'phone' : 'lookup', r.message);
        return;
      }
      root.querySelector('[data-otp-phone]').textContent = '+91 ' + phoneVal();
      clearOtp();
      showStep('otp');
      startResendTimer();
      otpInputs[0].focus();
    }, function () { busy(phoneBtn, false); setErr('lookup', 'Could not connect. Please check your internet and try again.'); });
  });

  /* ---------- step 1: OTP ---------- */
  function otpValue() { return otpInputs.map(function (i) { return i.value; }).join(''); }
  function clearOtp() { otpInputs.forEach(function (i) { i.value = ''; }); otpBtn.disabled = true; setOtpErr(''); info(''); }
  function setOtpErr(m) { root.querySelector('[data-err="otp"]').textContent = m || ''; otpInputs.forEach(function (i) { i.classList.toggle('is-invalid', !!m); }); }
  function info(m) { root.querySelector('[data-otp-info]').textContent = m || ''; }
  function fillFrom(index, digits) {
    for (var k = 0; k < digits.length && index + k < otpInputs.length; k++) { otpInputs[index + k].value = digits[k]; otpInputs[index + k].__prev = digits[k]; }
    otpInputs[Math.min(index + digits.length, otpInputs.length - 1)].focus();
  }
  otpInputs.forEach(function (input, idx) {
    input.addEventListener('input', function () {
      var d = this.value.replace(/\D/g, '');
      if (d.length > 1) {
        if (d.length === 2 && this.__prev) d = d.replace(this.__prev, '') || d.slice(-1);
        if (d.length > 1) { this.value = ''; fillFrom(idx, d.slice(0, 6 - idx)); }
        else { this.value = d; if (idx < 5) otpInputs[idx + 1].focus(); }
      } else { this.value = d; if (d && idx < 5) otpInputs[idx + 1].focus(); }
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
    stopResendTimer(); showStep('phone'); phoneInput.focus(); phoneInput.select();
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
    resendBtn.disabled = true; setOtpErr('');
    call({ action: 'resend_otp', phone: phoneVal() }).then(function (r) {
      if (!r.ok) { setOtpErr(r.message); resendBtn.disabled = false; return; }
      info('A new OTP has been sent.'); startResendTimer();
    }, function () { resendBtn.disabled = false; setOtpErr('Could not connect. Please try again.'); });
  });
  otpForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (otpValue().length !== 6) { setOtpErr('Enter the 6-digit OTP.'); return; }
    if (otpBtn.getAttribute('aria-busy') === 'true') return;
    info('');
    busy(otpBtn, true, 'Verifying…');
    call({ action: 'upload_verify', phone: phoneVal(), otp: otpValue() }).then(function (r) {
      busy(otpBtn, false);
      if (!r.ok) { setOtpErr(r.message); return; }
      stopResendTimer();
      state.token = r.token;
      state.kids = r.children || [];
      state.maxMb = Number(r.max_mb) || 500;
      renderKids();
      showStep('file');
    }, function () { busy(otpBtn, false); setOtpErr('Could not connect. Please check your internet and try again.'); });
  });

  /* ---------- step 2: child + video ---------- */
  function renderKids() {
    kidList.textContent = '';
    var open = state.kids.filter(function (k) { return k.open; });
    state.kidId = open.length === 1 ? open[0].id : null;
    state.kids.forEach(function (k) {
      var label = document.createElement('label');
      label.className = 'nyvc-up-kid' + (k.open ? '' : ' is-closed');
      var radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'child'; radio.value = k.id; radio.disabled = !k.open;
      radio.checked = state.kidId === k.id;
      radio.addEventListener('change', function () { state.kidId = k.id; setErr('file', ''); refreshUploadBtn(); });
      var text = document.createElement('span');
      text.className = 'nyvc-up-kid-text';
      var name = document.createElement('strong'); name.textContent = k.child_name;
      var meta = document.createElement('span');
      meta.textContent = [k.standard, k.division ? 'Div ' + k.division : '', k.school].filter(Boolean).join(' · ');
      text.appendChild(name); text.appendChild(meta);
      var note = document.createElement('span');
      note.className = 'nyvc-up-kid-note';
      note.textContent = k.open ? (k.last_date ? 'Last date: ' + k.last_date : '') : 'Closed on ' + k.last_date;
      label.appendChild(radio); label.appendChild(text);
      if (note.textContent) label.appendChild(note);
      kidList.appendChild(label);
    });
    kidsBox.classList.toggle('is-single', state.kids.length === 1);
    var hint = fileForm.querySelector('[data-size-hint]');
    if (hint && !hint.__base) hint.__base = hint.textContent;
    if (hint) hint.textContent = (hint.__base ? hint.__base + ' · ' : '') + 'max ' + state.maxMb + ' MB';
    refreshUploadBtn();
  }

  function fmtSize(b) { return b >= 1024 * 1024 * 1024 ? (b / 1073741824).toFixed(1) + ' GB' : (b / 1048576).toFixed(1) + ' MB'; }
  function isVideo(f) { return /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|3gp|mkv|avi)$/i.test(f.name); }
  function setFile(f) {
    state.file = f;
    fileForm.querySelector('[data-drop-empty]').hidden = !!f;
    fileForm.querySelector('[data-drop-file]').hidden = !f;
    drop.classList.toggle('has-file', !!f);
    if (f) {
      fileForm.querySelector('[data-file-name]').textContent = f.name;
      fileForm.querySelector('[data-file-size]').textContent = fmtSize(f.size);
    } else { fileInput.value = ''; }
    refreshUploadBtn();
  }
  function pickFile(f) {
    setErr('file', '');
    if (!f) return;
    if (!isVideo(f)) { setFile(null); setErr('file', 'Please choose a video file (for example MP4 or MOV).'); return; }
    if (f.size > state.maxMb * 1048576) { setFile(null); setErr('file', 'This video is ' + fmtSize(f.size) + '. The limit is ' + state.maxMb + ' MB. Please trim or compress it and try again.'); return; }
    if (f.size === 0) { setFile(null); setErr('file', 'This file looks empty. Please choose the video again.'); return; }
    setFile(f);
  }
  fileInput.addEventListener('change', function () { pickFile(this.files && this.files[0]); });
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { if (state.uploading) return; e.preventDefault(); drop.classList.add('is-drag'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-drag'); });
  });
  drop.addEventListener('drop', function (e) { if (!state.uploading) pickFile(e.dataTransfer && e.dataTransfer.files[0]); });
  function refreshUploadBtn() { if (!state.uploading) uploadBtn.disabled = !(state.file && state.kidId); }

  fileForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (state.uploading) { if (window.confirm('Stop this upload?')) cancelUpload(); return; }
    if (!state.kidId) { setErr('file', 'Please choose the child this video is for.'); return; }
    if (!state.file) { setErr('file', 'Please choose your video.'); return; }
    startUpload();
  });

  /* ---------- upload ---------- */
  function setProgress(done, total, text) {
    var pct = total ? Math.min(100, Math.floor(done / total * 100)) : 0;
    progress.hidden = false;
    progress.querySelector('[data-bar]').style.width = pct + '%';
    progress.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', String(pct));
    progress.querySelector('[data-pct]').textContent = pct + '%';
    if (text) progress.querySelector('[data-progress-text]').textContent = text;
  }
  function lockUi(on) {
    state.uploading = on;
    fileForm.classList.toggle('is-uploading', on);
    [].slice.call(fileForm.querySelectorAll('input')).forEach(function (i) { i.disabled = on || (i.type === 'radio' && !state.kids.filter(function (k) { return k.id === i.value; })[0].open); });
    uploadBtn.disabled = false;
    uploadBtn.textContent = on ? 'Cancel upload' : (uploadBtn.__label || uploadBtn.textContent);
    uploadBtn.classList.toggle('is-cancel', on);
  }
  function cancelUpload() {
    state.cancelled = true;
    if (state.xhr) try { state.xhr.abort(); } catch (err) {}
    lockUi(false);
    progress.hidden = true;
    refreshUploadBtn();
  }
  function fail(msg) {
    lockUi(false);
    progress.hidden = true;
    refreshUploadBtn();
    if (msg && msg.error === 'submission_closed') notice('file', 'Video submission is closed', msg.message);
    else if (msg && msg.error === 'session_expired') { reset(); setErr('lookup', msg.message); }
    else setErr('file', (msg && msg.message) || 'The upload was interrupted. Please check your internet and try again.');
  }

  function startUpload() {
    var f = state.file;
    uploadBtn.__label = uploadBtn.__label || uploadBtn.textContent;
    state.cancelled = false;
    setErr('file', '');
    lockUi(true);
    setProgress(0, f.size, 'Getting ready…');
    call({
      action: 'upload_start', token: state.token, child_id: state.kidId, file_name: f.name, size: f.size,
      mime_type: f.type && /^video\//.test(f.type) ? f.type : guessType(f.name), origin: location.origin
    }).then(function (r) {
      if (state.cancelled) return;
      if (!r.ok) { fail(r); return; }
      var up = { id: r.upload_id, url: r.upload_url, name: r.file_name, chunk: Number(r.proxy_chunk) || 4194304 };
      direct(up, 0, 0);
    }, function () { fail(); });
  }
  function guessType(name) {
    var ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1] || '';
    return { mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp', mkv: 'video/x-matroska', avi: 'video/x-msvideo' }[ext.toLowerCase()] || 'video/mp4';
  }

  /* Send the rest of the file straight to Drive. If Drive refuses the browser, switch to relaying it through the script. */
  function direct(up, offset, tries) {
    var f = state.file;
    var xhr = new XMLHttpRequest();
    var moved = false;
    state.xhr = xhr;
    xhr.open('PUT', up.url, true);
    if (offset > 0) xhr.setRequestHeader('Content-Range', 'bytes ' + offset + '-' + (f.size - 1) + '/' + f.size);
    xhr.upload.onprogress = function (e) { moved = moved || e.loaded > 0; setProgress(offset + e.loaded, f.size, 'Uploading… please keep this window open.'); };
    xhr.onload = function () {
      if (state.cancelled) return;
      if (xhr.status === 200 || xhr.status === 201) {
        var id = ''; try { id = JSON.parse(xhr.responseText).id || ''; } catch (err) {}
        finish(up, id); return;
      }
      recover(up, moved, tries);
    };
    xhr.onerror = function () { if (!state.cancelled) recover(up, moved, tries); };
    xhr.send(offset > 0 ? f.slice(offset) : f);
  }
  /* Ask Drive (through the script) how much arrived, then carry on. */
  function recover(up, directWorked, tries) {
    if (state.cancelled) return;
    progress.querySelector('[data-progress-text]').textContent = 'Checking the upload…';
    relay(up, null, 0, 0).then(function (r) {
      if (!r.ok) { fail(r); return; }
      if (r.done) { finish(up, r.file_id); return; }
      if (directWorked && tries < 3) { setTimeout(function () { direct(up, r.next, tries + 1); }, 1500 * (tries + 1)); return; }
      viaScript(up, r.next, 0);
    }, function () { fail(); });
  }
  function viaScript(up, offset, retries) {
    if (state.cancelled) return;
    var f = state.file;
    var end = Math.min(offset + up.chunk, f.size);
    setProgress(offset, f.size, 'Uploading… please keep this window open.');
    readBase64(f.slice(offset, end)).then(function (b64) {
      return relay(up, b64, offset);
    }).then(function (r) {
      if (state.cancelled) return;
      if (!r.ok) {
        if (r.error === 'upload_failed' && retries < 3) { setTimeout(function () { viaScript(up, offset, retries + 1); }, 2000); return; }
        fail(r); return;
      }
      if (r.done) { setProgress(f.size, f.size); finish(up, r.file_id); return; }
      viaScript(up, r.next, 0);
    }, function () {
      if (state.cancelled) return;
      if (retries < 3) { setTimeout(function () { viaScript(up, offset, retries + 1); }, 2000 * (retries + 1)); return; }
      fail();
    });
  }
  function relay(up, b64, start) {
    return call({ action: 'upload_chunk', token: state.token, upload_id: up.id, start: start, data: b64 || '' }, 120000);
  }
  function readBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function finish(up, fileId) {
    setProgress(1, 1, 'Saving your submission…');
    call({ action: 'upload_finish', token: state.token, upload_id: up.id, file_id: fileId || '' }, 60000).then(function (r) {
      if (!r.ok) { fail(r); return; }
      lockUi(false);
      var kid = state.kids.filter(function (k) { return k.id === state.kidId; })[0] || {};
      root.querySelector('[data-done-text]').textContent = "We've received " + (r.child_name || kid.child_name || 'your child') + "'s video for the neOwn Young Voices Championship.";
      root.querySelector('[data-done-file]').textContent = r.file_name || up.name;
      root.querySelector('[data-done-time]').textContent = r.uploaded_at ? r.uploaded_at.replace(/:\d\d$/, '') + ' IST' : '';
      try { (window.dataLayer = window.dataLayer || []).push({ event: 'nyvc_video_upload', nyvc_standard: kid.standard || '' }); } catch (err) {}
      showStep('done');
      root.querySelector('[data-done-heading]').focus();
    }, function () { fail({ message: 'Your video was uploaded, but we could not confirm it. Please try again; if it keeps failing, contact us.' }); });
  }

  /* ---------- helpers ---------- */
  function busy(btn, on, label) {
    if (!btn.__label) btn.__label = btn.textContent;
    btn.disabled = !!on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    btn.textContent = on ? (label || btn.__label) : btn.__label;
    if (!on && btn === phoneBtn) btn.disabled = phoneVal().length === 0;
    if (!on && btn === otpBtn) btn.disabled = otpValue().length !== 6;
  }
  /* text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight. */
  function call(payload, timeoutMs) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000) : null;
    return fetch(endpoint(), {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) { if (t) clearTimeout(t); return res.json(); });
  }
})();
