/**
 * neOwn Young Voices Championship (NYVC) registration backend.
 *
 * Runs as a Google Apps Script web app bound to the registrations Google Sheet.
 *  - send_otp: sends a 6-digit OTP to the parent's phone through MSG91.
 *  - resend_otp: asks MSG91 to resend it.
 *  - register: verifies the OTP with MSG91 and, only if it is correct, appends the
 *    registration to the sheet. Rows can't be added without a valid OTP.
 *
 * Setup (once):
 *  1. Open the sheet → Extensions → Apps Script, paste this file, save.
 *  2. Project Settings → Script Properties → add:
 *       MSG91_AUTHKEY      your MSG91 auth key
 *       MSG91_TEMPLATE_ID  your DLT-approved MSG91 OTP template ID
 *     Optional: SHEET_NAME (default "Sheet1"), OTP_EXPIRY_MINUTES (default 10).
 *  3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.
 *  4. Copy the web app URL into the theme: NYVC page → "NYVC: Registration form" section →
 *     "Registration script URL".
 * After editing this file, use Deploy → Manage deployments → Edit → New version, so the
 * URL stays the same.
 */

var COLUMNS = [
  'Submitted At (IST)', 'Registration ID', 'Child Name', 'Date of Birth', 'Age (years)',
  'School', 'Standard', 'Division / Section', 'Parent / Guardian Name', 'Email', 'Phone',
  'Phone Verified', 'Page', 'UTM Source', 'UTM Medium', 'UTM Campaign'
];

function doGet() {
  return json_({ ok: true, service: 'nyvc-registration' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: 'Something went wrong. Please try again.' });
  }
  try {
    switch (body.action) {
      case 'send_otp': return json_(sendOtp_(body));
      case 'resend_otp': return json_(resendOtp_(body));
      case 'register': return json_(register_(body));
      default: return json_({ ok: false, error: 'bad_request', message: 'Something went wrong. Please try again.' });
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'server_error', message: 'Something went wrong on our side. Please try again in a minute.' });
  }
}

/* ---------- OTP ---------- */

function sendOtp_(body) {
  var mobile = cleanMobile_(body.phone);
  if (!mobile) return { ok: false, error: 'invalid_phone', message: 'Enter a valid 10-digit mobile number.' };

  // Don't spend an OTP on someone who is already registered.
  var childName = clean_(body.child_name, 80);
  if (childName && findExisting_(sheet_(), { phone: mobile, childName: childName })) return alreadyRegistered_(childName);

  var limit = rateLimit_('send', mobile, [[30, 1, 'Please wait 30 seconds before requesting another OTP.'], [3600, 5, 'Too many OTP requests for this number. Please try again in an hour.']]);
  if (limit) return limit;
  var global = rateLimit_('send', 'all', [[3600, 400, 'We are getting a lot of requests right now. Please try again shortly.']]);
  if (global) return global;

  var props = props_();
  var url = 'https://control.msg91.com/api/v5/otp?template_id=' + encodeURIComponent(props.templateId) +
    '&mobile=91' + mobile + '&otp_length=6&otp_expiry=' + props.expiry;
  var res = msg91_('post', url, props.authkey);
  if (res.type === 'success') return { ok: true };
  console.warn('MSG91 send failed: ' + JSON.stringify(res));
  return { ok: false, error: 'otp_send_failed', message: 'We could not send the OTP. Please check the number and try again.' };
}

function resendOtp_(body) {
  var mobile = cleanMobile_(body.phone);
  if (!mobile) return { ok: false, error: 'invalid_phone', message: 'Enter a valid 10-digit mobile number.' };
  var limit = rateLimit_('send', mobile, [[30, 1, 'Please wait 30 seconds before requesting another OTP.'], [3600, 5, 'Too many OTP requests for this number. Please try again in an hour.']]);
  if (limit) return limit;
  var props = props_();
  var res = msg91_('get', 'https://control.msg91.com/api/v5/otp/retry?retrytype=text&mobile=91' + mobile, props.authkey);
  if (res.type === 'success') return { ok: true };
  // If MSG91 has no active OTP to retry (e.g. it expired), send a fresh one.
  var fresh = msg91_('post', 'https://control.msg91.com/api/v5/otp?template_id=' + encodeURIComponent(props.templateId) +
    '&mobile=91' + mobile + '&otp_length=6&otp_expiry=' + props.expiry, props.authkey);
  if (fresh.type === 'success') return { ok: true };
  console.warn('MSG91 resend failed: ' + JSON.stringify(res) + ' / ' + JSON.stringify(fresh));
  return { ok: false, error: 'otp_send_failed', message: 'We could not resend the OTP. Please try again.' };
}

function verifyOtp_(mobile, otp) {
  var cache = CacheService.getScriptCache();
  if (cache.get('verified:' + mobile)) return true; // already verified in the last 10 min (safe retry)
  var props = props_();
  var res = msg91_('get', 'https://control.msg91.com/api/v5/otp/verify?otp=' + encodeURIComponent(otp) + '&mobile=91' + mobile, props.authkey);
  if (res.type === 'success') {
    cache.put('verified:' + mobile, '1', 600);
    return true;
  }
  return false;
}

/* ---------- Registration ---------- */

function register_(body) {
  var f = body.form || {};
  var data = {
    id: clean_(body.id, 40),
    childName: clean_(f.child_name, 80),
    dob: clean_(f.dob, 10),
    school: clean_(f.school, 120),
    standard: clean_(f.standard, 20),
    division: clean_(f.division, 20),
    parentName: clean_(f.parent_name, 80),
    email: clean_(f.email, 120).toLowerCase(),
    phone: cleanMobile_(f.phone),
    page: clean_(body.page, 200),
    utmSource: clean_(body.utm_source, 80),
    utmMedium: clean_(body.utm_medium, 80),
    utmCampaign: clean_(body.utm_campaign, 120)
  };
  var otp = String(body.otp || '').replace(/\D/g, '');

  var invalid = validate_(data);
  if (invalid) return { ok: false, error: 'invalid_form', field: invalid.field, message: invalid.message };
  if (otp.length !== 6) return { ok: false, error: 'invalid_otp', message: 'Enter the 6-digit OTP.' };

  var limit = rateLimit_('verify', data.phone, [[600, 5, 'Too many wrong attempts. Please request a new OTP in 10 minutes.']]);
  if (limit) return limit;
  if (!verifyOtp_(data.phone, otp)) return { ok: false, error: 'wrong_otp', message: 'That OTP is incorrect or has expired. Please check and try again.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = sheet_();
    if (data.id && findById_(sheet, data.id)) return { ok: true, id: data.id }; // same browser retrying a save that worked
    if (findExisting_(sheet, data)) return alreadyRegistered_(data.childName);

    var id = data.id || ('NYVC-' + Utilities.getUuid().slice(0, 8).toUpperCase());
    var now = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([
      now, id, data.childName, data.dob, ageFromDob_(data.dob), data.school, data.standard, data.division,
      data.parentName, data.email, data.phone, 'Yes', data.page, data.utmSource, data.utmMedium, data.utmCampaign
    ].map(safeCell_));
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

function validate_(d) {
  if (!d.childName || d.childName.length < 2) return { field: 'child_name', message: "Enter the child's full name." };
  var dobMsg = dobProblem_(d.dob);
  if (dobMsg) return { field: 'dob', message: dobMsg };
  if (!d.school) return { field: 'school', message: 'Select the school.' };
  if (!d.standard) return { field: 'standard', message: 'Select the standard.' };
  if (!d.division) return { field: 'division', message: 'Enter the division or section.' };
  if (!d.parentName || d.parentName.length < 2) return { field: 'parent_name', message: "Enter the parent or guardian's name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) return { field: 'email', message: 'Enter a valid email address.' };
  if (!d.phone) return { field: 'phone', message: 'Enter a valid 10-digit mobile number.' };
  return null;
}

/** Same phone number + same child name already in the sheet (siblings on one phone are allowed). */
function findExisting_(sheet, d) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var rows = sheet.getRange(2, 2, last - 1, 10).getValues(); // B..K
  var child = normName_(d.childName);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[9]).replace(/\D/g, '').slice(-10) === d.phone && normName_(r[1]) === child) return String(r[0]);
  }
  return null;
}

function findById_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  return sheet.getRange(2, 2, last - 1, 1).getValues().some(function (r) { return String(r[0]) === id; });
}

function normName_(v) { return String(v || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function alreadyRegistered_(childName) {
  return {
    ok: false, error: 'already_registered',
    message: childName + ' is already registered with this phone number, so you don\'t need to register again. To change any details, please contact the neOwn team.'
  };
}

/** Returns a helpful message if the date of birth is not usable, or '' if it is fine. */
function dobProblem_(dob) {
  var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dob || '');
  if (!m) return 'Enter the date of birth as DD/MM/YYYY, for example 15/08/2015.';
  var d = new Date(+m[3], +m[2] - 1, +m[1]);
  if (d.getDate() !== +m[1] || d.getMonth() !== +m[2] - 1) return 'This date does not exist. Check the day and month (DD/MM/YYYY).';
  if (d > new Date()) return 'The date of birth cannot be in the future.';
  var age = ageFromDob_(dob);
  if (age < 4) return 'The child must be at least 4 years old. Check the year of birth.';
  if (age > 18) return 'The championship is for school students up to 18 years old. Check the year of birth.';
  return '';
}

/* ---------- Helpers ---------- */

function sheet_() {
  var name = PropertiesService.getScriptProperties().getProperty('SHEET_NAME') || 'Sheet1';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
    sheet.getRange('D:D').setNumberFormat('@');
    sheet.getRange('K:K').setNumberFormat('@');
  }
  return sheet;
}

function props_() {
  var p = PropertiesService.getScriptProperties();
  var authkey = p.getProperty('MSG91_AUTHKEY');
  var templateId = p.getProperty('MSG91_TEMPLATE_ID');
  if (!authkey || !templateId) throw new Error('MSG91_AUTHKEY / MSG91_TEMPLATE_ID script properties are not set');
  return { authkey: authkey, templateId: templateId, expiry: Number(p.getProperty('OTP_EXPIRY_MINUTES') || 10) };
}

function msg91_(method, url, authkey) {
  var res = UrlFetchApp.fetch(url, {
    method: method,
    headers: { authkey: authkey, accept: 'application/json' },
    contentType: 'application/json',
    payload: method === 'post' ? '{}' : undefined,
    muteHttpExceptions: true
  });
  try { return JSON.parse(res.getContentText()); } catch (e) { return { type: 'error', message: res.getContentText() }; }
}

/** windows: [[seconds, max, message], ...]. Returns an error object when over the limit. */
function rateLimit_(kind, key, windows) {
  var cache = CacheService.getScriptCache();
  for (var i = 0; i < windows.length; i++) {
    var w = windows[i];
    var k = 'rl:' + kind + ':' + key + ':' + w[0];
    var n = Number(cache.get(k) || 0);
    if (n >= w[1]) return { ok: false, error: 'rate_limited', message: w[2] };
  }
  for (var j = 0; j < windows.length; j++) {
    var w2 = windows[j];
    var k2 = 'rl:' + kind + ':' + key + ':' + w2[0];
    cache.put(k2, String(Number(cache.get(k2) || 0) + 1), w2[0]);
  }
  return null;
}

function cleanMobile_(v) {
  var d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Stops spreadsheet formula injection (cells starting with = + - @). */
function safeCell_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function ageFromDob_(dob) {
  var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dob || '');
  if (!m) return '';
  var d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  if (d.getDate() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1) return '';
  var now = new Date();
  var age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
