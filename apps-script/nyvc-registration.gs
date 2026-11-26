/**
 * neOwn Young Voices Championship (NYVC) registration backend.
 *
 * Runs as a Google Apps Script web app bound to the registrations Google Sheet.
 *  - send_otp: sends a 6-digit OTP to the parent's phone through MSG91.
 *  - resend_otp: asks MSG91 to resend it.
 *  - register: verifies the OTP with MSG91 and, only if it is correct, appends the
 *    registration to the sheet. Rows can't be added without a valid OTP.
 *  - upload_*: video submission. Only registered phone numbers get an OTP; after it, the video
 *    goes to Google Drive as NYVC Videos / School / Standard / "Child - Div X - date time.mp4",
 *    and each upload is logged in the "Video Submissions" tab.
 *  - "Video Deadlines" tab (made on first use): the team sets each school's last date there.
 *
 * Setup (once):
 *  1. Open the sheet → Extensions → Apps Script, paste this file, save.
 *  2. Project Settings → Script Properties → add:
 *       MSG91_AUTHKEY      your MSG91 auth key
 *       MSG91_TEMPLATE_ID  your DLT-approved MSG91 OTP template ID
 *     Optional: SHEET_NAME (default "Sheet1"), OTP_EXPIRY_MINUTES (default 10),
 *       VIDEO_FOLDER_ID (Drive folder for videos; default: a "NYVC Videos" folder it makes),
 *       MAX_VIDEO_MB (default 500).
 *  3. Select the "setup" function at the top and click Run once (approve access to Sheets, Drive
 *     and external requests). It creates the video tabs and the "NYVC Videos" Drive folder.
 *  4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.
 *  5. Copy the web app URL into the theme: NYVC page → "NYVC: Registration form" section →
 *     "Registration script URL".
 * After editing this file, use Deploy → Manage deployments → Edit → New version, so the
 * URL stays the same.
 */

var COLUMNS = [
  'Submitted At (IST)', 'Registration ID', 'Child Name', 'Date of Birth', 'Age (years)',
  'School', 'Standard', 'Division / Section', 'Parent / Guardian Name', 'Email', 'Phone',
  'Phone Verified', 'Page', 'UTM Source', 'UTM Medium', 'UTM Campaign'
];

/** Run once from the editor (select "setup" → Run): approves Drive access and makes the
 *  "Video Deadlines" and "Video Submissions" tabs and the "NYVC Videos" Drive folder. */
function setup() {
  sheet_();
  deadlines_();
  submissionsSheet_();
  console.log('Videos folder: ' + rootFolder_().getUrl());
}

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
      case 'upload_lookup': return json_(uploadLookup_(body));
      case 'upload_verify': return json_(uploadVerify_(body));
      case 'upload_start': return json_(uploadStart_(body));
      case 'upload_chunk': return json_(uploadChunk_(body));
      case 'upload_finish': return json_(uploadFinish_(body));
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
  return sendOtpTo_(mobile);
}

function sendOtpTo_(mobile) {
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

/* ---------- Video upload ----------
 * Flow: upload_lookup (is this phone registered? is the school's deadline open? → send OTP)
 *       → upload_verify (check OTP, return the children on this phone + a session token)
 *       → upload_start (make School / Standard folders, open a Drive resumable upload)
 *       → the browser sends the file straight to Drive; if the browser can't, upload_chunk relays it
 *       → upload_finish (check the file landed, log it in the "Video Submissions" tab).
 */

var DEADLINES_SHEET = 'Video Deadlines';
var SUBMISSIONS_SHEET = 'Video Submissions';
var SUBMISSION_COLUMNS = [
  'Uploaded At (IST)', 'Registration ID', 'Child Name', 'School', 'Standard', 'Division / Section',
  'Phone', 'File Name', 'Size (MB)', 'Drive Link', 'Latest', 'Promo Consent'
];
var MB = 1024 * 1024;
var PROXY_CHUNK = 4 * MB; // multiple of 256 KB, as Drive requires

function uploadLookup_(body) {
  var mobile = cleanMobile_(body.phone);
  if (!mobile) return { ok: false, error: 'invalid_phone', message: 'Enter a valid 10-digit mobile number.' };
  var lookups = rateLimit_('lookup', 'all', [[3600, 2000, 'We are getting a lot of requests right now. Please try again shortly.']]);
  if (lookups) return lookups;

  var kids = registrationsByPhone_(mobile);
  if (!kids.length) {
    return { ok: false, error: 'not_registered',
      message: 'We could not find a registration for +91 ' + mobile + '. Please register your child first, or use the phone number you registered with.' };
  }
  var deadlines = deadlines_();
  var open = kids.filter(function (k) { return deadlineFor_(k.school, deadlines).open; });
  if (!open.length) return closedMessage_(kids, deadlines);

  return sendOtpTo_(mobile);
}

function uploadVerify_(body) {
  var mobile = cleanMobile_(body.phone);
  if (!mobile) return { ok: false, error: 'invalid_phone', message: 'Enter a valid 10-digit mobile number.' };
  var otp = String(body.otp || '').replace(/\D/g, '');
  if (otp.length !== 6) return { ok: false, error: 'invalid_otp', message: 'Enter the 6-digit OTP.' };
  var limit = rateLimit_('verify', mobile, [[600, 5, 'Too many wrong attempts. Please request a new OTP in 10 minutes.']]);
  if (limit) return limit;
  if (!verifyOtp_(mobile, otp)) return { ok: false, error: 'wrong_otp', message: 'That OTP is incorrect or has expired. Please check and try again.' };

  var kids = registrationsByPhone_(mobile);
  if (!kids.length) return { ok: false, error: 'not_registered', message: 'We could not find a registration for this phone number.' };
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('upl:' + token, JSON.stringify({ phone: mobile }), 21600); // 6 hours
  var deadlines = deadlines_();
  return {
    ok: true, token: token, max_mb: maxMb_(),
    children: kids.map(function (k) {
      var d = deadlineFor_(k.school, deadlines);
      return { id: k.id, child_name: k.childName, school: k.school, standard: k.standard, division: k.division, open: d.open, last_date: d.label };
    })
  };
}

function uploadStart_(body) {
  var sess = uploadSession_(body.token);
  if (!sess) return sessionExpired_();
  var kid = registrationsByPhone_(sess.phone).filter(function (k) { return k.id === String(body.child_id || ''); })[0];
  if (!kid) return { ok: false, error: 'bad_request', message: 'Please choose the child this video is for.' };
  var dl = deadlineFor_(kid.school, deadlines_());
  if (!dl.open) return { ok: false, error: 'submission_closed', message: 'Video submission is closed for ' + kid.school + '. The last date was ' + dl.label + '.' };

  var size = Math.floor(Number(body.size) || 0);
  var max = maxMb_();
  if (size <= 0) return { ok: false, error: 'bad_file', message: 'This file looks empty. Please choose the video again.' };
  if (size > max * MB) return { ok: false, error: 'too_large', message: 'This video is ' + Math.round(size / MB) + ' MB. The limit is ' + max + ' MB.' };
  var mime = clean_(body.mime_type, 100).toLowerCase();
  if (!/^video\/[a-z0-9.+-]+$/.test(mime)) return { ok: false, error: 'not_video', message: 'Please choose a video file.' };
  var origin = clean_(body.origin, 200);
  if (!allowedOrigin_(origin)) return { ok: false, error: 'bad_request', message: 'Something went wrong. Please reload the page and try again.' };

  var extMatch = /\.([a-z0-9]{2,5})$/i.exec(clean_(body.file_name, 200));
  var ext = extMatch ? extMatch[1].toLowerCase() : (mime.split('/')[1] === 'quicktime' ? 'mov' : 'mp4');
  var stamp = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH-mm-ss');
  var name = safeName_(kid.childName + ' - Div ' + kid.division + ' - ' + stamp) + '.' + ext;

  var folder;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    folder = subfolder_(subfolder_(rootFolder_(), safeName_(kid.school)), safeName_(kid.standard));
  } finally {
    lock.releaseLock();
  }

  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ name: name, parents: [folder.getId()], mimeType: mime,
      description: 'NYVC video · ' + kid.id + ' · ' + kid.childName + ' · ' + kid.school + ' · ' + kid.standard }),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(size),
      Origin: origin // lets the visitor's browser send the file straight to this upload link
    },
    muteHttpExceptions: true,
    followRedirects: false
  });
  var headers = res.getAllHeaders();
  var url = headers.Location || headers.location;
  if (res.getResponseCode() !== 200 || !url) {
    console.error('Drive resumable start failed: ' + res.getResponseCode() + ' ' + res.getContentText());
    return { ok: false, error: 'server_error', message: 'We could not start the upload. Please try again in a minute.' };
  }
  var uploadId = Utilities.getUuid();
  CacheService.getScriptCache().put('ups:' + uploadId, JSON.stringify({
    token: String(body.token), url: url, size: size, mime: mime, name: name, folderId: folder.getId(), childId: kid.id,
    consent: body.promo_consent === true
  }), 21600);
  return { ok: true, upload_id: uploadId, upload_url: url, file_name: name, proxy_chunk: PROXY_CHUNK };
}

/** Relays one piece of the file to Drive, for browsers that can't reach Drive directly.
 *  With no data it only asks Drive how much has arrived. */
function uploadChunk_(body) {
  var up = uploadState_(body);
  if (!up) return sessionExpired_();
  var data = body.data ? Utilities.base64Decode(String(body.data)) : [];
  var start = Math.floor(Number(body.start) || 0);
  var headers = {};
  if (data.length) {
    var end = start + data.length - 1;
    if (data.length > PROXY_CHUNK || end >= up.size || (end < up.size - 1 && data.length % (256 * 1024))) {
      return { ok: false, error: 'bad_request', message: 'Something went wrong with the upload. Please try again.' };
    }
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + up.size;
  } else {
    headers['Content-Range'] = 'bytes */' + up.size;
  }
  var res = UrlFetchApp.fetch(up.url, {
    method: 'put', payload: data.length ? data : '', contentType: up.mime, headers: headers, muteHttpExceptions: true, followRedirects: false
  });
  var code = res.getResponseCode();
  if (code === 200 || code === 201) {
    var file = {};
    try { file = JSON.parse(res.getContentText()); } catch (e) {}
    return { ok: true, done: true, file_id: file.id || '' };
  }
  if (code === 308) {
    var all = res.getAllHeaders();
    var range = all.Range || all.range || '';
    var m = /bytes=0-(\d+)/.exec(range);
    return { ok: true, done: false, next: m ? Number(m[1]) + 1 : 0 };
  }
  console.warn('Drive chunk failed: ' + code + ' ' + res.getContentText());
  if (code === 404 || code === 410) return { ok: false, error: 'upload_expired', message: 'The upload link expired. Please start the upload again.' };
  return { ok: false, error: 'upload_failed', message: 'The upload was interrupted. Please try again.' };
}

function uploadFinish_(body) {
  var up = uploadState_(body);
  if (!up) return sessionExpired_();
  var cache = CacheService.getScriptCache();
  var done = cache.get('upf:' + body.upload_id);
  if (done) return JSON.parse(done);

  var file = findUploaded_(up, String(body.file_id || ''));
  if (!file) return { ok: false, error: 'upload_failed', message: 'We could not find your video in our folder. Please upload it again.' };
  var kid = registrationsByPhone_(JSON.parse(cache.get('upl:' + body.token)).phone).filter(function (k) { return k.id === up.childId; })[0] || {};
  var now = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = submissionsSheet_();
    var last = sheet.getLastRow();
    if (last > 1) { // earlier uploads for this child are no longer the latest
      var ids = sheet.getRange(2, 2, last - 1, 1).getValues();
      var latest = sheet.getRange(2, 11, last - 1, 1).getValues();
      var changed = false;
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === up.childId && latest[i][0] !== 'No') { latest[i][0] = 'No'; changed = true; }
      }
      if (changed) sheet.getRange(2, 11, last - 1, 1).setValues(latest);
    }
    sheet.appendRow([
      now, up.childId, kid.childName || '', kid.school || '', kid.standard || '', kid.division || '',
      kid.phone || '', file.getName(), Math.round(file.getSize() / MB * 10) / 10, file.getUrl(), 'Yes',
      up.consent ? 'Yes' : 'No'
    ].map(safeCell_));
  } finally {
    lock.releaseLock();
  }
  var result = { ok: true, file_name: file.getName(), uploaded_at: now, child_name: kid.childName || '' };
  cache.put('upf:' + body.upload_id, JSON.stringify(result), 21600);
  return result;
}

/* ---------- Video upload helpers ---------- */

function registrationsByPhone_(mobile) {
  var sheet = sheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var rows = sheet.getRange(2, 1, last - 1, 11).getValues(); // A..K
  var seen = {}, out = [];
  rows.forEach(function (r) {
    if (String(r[10]).replace(/\D/g, '').slice(-10) !== mobile) return;
    var id = String(r[1]);
    var key = normName_(r[2]);
    if (!id || seen[key]) return; // same child registered twice: keep the first
    seen[key] = true;
    out.push({ id: id, childName: String(r[2]), school: String(r[5]), standard: String(r[6]), division: String(r[7]), phone: mobile });
  });
  return out;
}

/** "Video Deadlines" tab: School | Last Date. A row named "All schools" applies to schools with no row of their own.
 *  A school with no date has no deadline yet (uploads stay open). */
function deadlines_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DEADLINES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(DEADLINES_SHEET);
    sheet.appendRow(['School', 'Last Date for Video (DD/MM/YYYY)', 'Notes']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    var schools = {};
    var reg = sheet_();
    if (reg.getLastRow() > 1) reg.getRange(2, 6, reg.getLastRow() - 1, 1).getValues().forEach(function (r) { if (r[0]) schools[r[0]] = true; });
    Object.keys(schools).forEach(function (s) { sheet.appendRow([s, '', '']); });
    sheet.appendRow(['All schools', '', 'Used for any school without its own row. Leave the date blank for no deadline.']);
    sheet.autoResizeColumns(1, 3);
  }
  var tz = ss.getSpreadsheetTimeZone();
  var map = {};
  var last = sheet.getLastRow();
  if (last < 2) return map;
  sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    var school = normName_(r[0]);
    var iso = deadlineIso_(r[1], tz);
    if (school && iso) map[school] = iso;
  });
  return map;
}

function deadlineIso_(v, tz) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = String(v || '').trim(), m;
  if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s))) return m[3] + '-' + pad_(m[2]) + '-' + pad_(m[1]);
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return s;
  return '';
}

/** Open through the end of the last date (India time). */
function deadlineFor_(school, map) {
  var iso = map[normName_(school)] || map['all schools'];
  if (!iso) return { open: true, label: '' };
  var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var p = iso.split('-');
  var label = Utilities.formatDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12), 'Asia/Kolkata', 'd MMMM yyyy');
  return { open: today <= iso, label: label };
}

function closedMessage_(kids, deadlines) {
  var schools = {};
  kids.forEach(function (k) { schools[k.school] = deadlineFor_(k.school, deadlines).label; });
  var names = Object.keys(schools);
  var msg = names.length === 1
    ? 'Video submission is closed for ' + names[0] + '. The last date was ' + schools[names[0]] + '.'
    : 'Video submission is closed for ' + names.map(function (n) { return n + ' (last date ' + schools[n] + ')'; }).join(' and ') + '.';
  return { ok: false, error: 'submission_closed', message: msg };
}

function uploadSession_(token) {
  var v = token && CacheService.getScriptCache().get('upl:' + token);
  return v ? JSON.parse(v) : null;
}

function uploadState_(body) {
  if (!uploadSession_(body.token)) return null;
  var v = body.upload_id && CacheService.getScriptCache().get('ups:' + body.upload_id);
  var up = v ? JSON.parse(v) : null;
  return up && up.token === String(body.token) ? up : null;
}

function sessionExpired_() {
  return { ok: false, error: 'session_expired', message: 'Your session has expired. Please verify your phone number again.' };
}

/** The Drive file the browser says it uploaded, or the newest matching one in the child's folder. */
function findUploaded_(up, fileId) {
  if (fileId) {
    try {
      var f = DriveApp.getFileById(fileId);
      var parents = f.getParents();
      while (parents.hasNext()) if (parents.next().getId() === up.folderId) return f;
    } catch (e) {}
  }
  var files = DriveApp.getFolderById(up.folderId).getFilesByName(up.name);
  return files.hasNext() ? files.next() : null;
}

function submissionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SUBMISSIONS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SUBMISSIONS_SHEET);
    sheet.appendRow(SUBMISSION_COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, SUBMISSION_COLUMNS.length).setFontWeight('bold');
    sheet.getRange('G:G').setNumberFormat('@');
  }
  // Tabs made before a column was added get the new heading.
  if (sheet.getLastColumn() < SUBMISSION_COLUMNS.length) {
    sheet.getRange(1, 1, 1, SUBMISSION_COLUMNS.length).setValues([SUBMISSION_COLUMNS]).setFontWeight('bold');
  }
  return sheet;
}

/** VIDEO_FOLDER_ID script property, or a "NYVC Videos" folder the script makes in your Drive. */
function rootFolder_() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('VIDEO_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var folder = DriveApp.createFolder('NYVC Videos');
  p.setProperty('VIDEO_FOLDER_ID', folder.getId());
  return folder;
}

function subfolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function maxMb_() {
  return Number(PropertiesService.getScriptProperties().getProperty('MAX_VIDEO_MB') || 500);
}

function allowedOrigin_(o) {
  return /^https:\/\/([a-z0-9-]+\.)*(neown\.in|myshopify\.com|shopifypreview\.com)$/i.test(o) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}

function safeName_(s) {
  return String(s || '').replace(/[\\\/:*?"<>|#%]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Unknown';
}

function pad_(n) { return ('0' + n).slice(-2); }

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
