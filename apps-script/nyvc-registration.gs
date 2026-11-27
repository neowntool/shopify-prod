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
 *  - neOwn orders: each registration becomes an order through ORDER_API_URL (see "neOwn orders").
 *  - Confirmation email: once a prod order number comes back, the parent gets the registration
 *    email from contact@neown.in (see "Confirmation email"). Off until CONFIRMATION_EMAILS = on.
 *
 * Setup (once):
 *  1. Open the sheet → Extensions → Apps Script, paste this file, save.
 *  2. Project Settings → Script Properties → add:
 *       MSG91_AUTHKEY      your MSG91 auth key
 *       MSG91_TEMPLATE_ID  your DLT-approved MSG91 OTP template ID
 *     Optional: SHEET_NAME (default "Sheet1"), OTP_EXPIRY_MINUTES (default 10),
 *       VIDEO_FOLDER_ID (Drive folder for videos; default: a "NYVC Videos" folder it makes),
 *       MAX_VIDEO_MB (default 500),
 *       ORDER_API_URL (neOwn order API; dev or prod URL. Blank = orders are not sent),
       CONFIRMATION_EMAILS (on = email parents after the order; anything else = off),
       EMAIL_FROM (default contact@neown.in).
 *  3. Select the "setup" function at the top and click Run once (approve access to Sheets, Drive
 *     and external requests). It creates the video tabs and the "NYVC Videos" Drive folder.
 *  4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.
 *  5. Copy the web app URL into the theme: NYVC page → "NYVC: Registration form" section →
 *     "Registration script URL".
 * After editing this file, use Deploy → Manage deployments → Edit → New version, so the
 * URL stays the same.
 */

var COLUMNS = [
  'Submitted At (IST)', 'Registration ID', 'Child Name', 'Date of Birth', 'Age (years)', 'Gender',
  'School', 'Standard', 'Division / Section', 'Parent / Guardian Name', 'Email', 'Phone',
  'Phone Verified', 'Page', 'UTM Source', 'UTM Medium', 'UTM Campaign',
  'Order Status', 'Order No', 'Order Env', 'Order Synced At (IST)', 'Order Error', 'Order Attempts',
  'Email Status', 'Email Sent At (IST)', 'Email Error'
];

/** Run once from the editor (select "setup" → Run): approves Drive access and makes the
 *  "Video Deadlines" and "Video Submissions" tabs and the "NYVC Videos" Drive folder. */
function setup() {
  regMap_(sheet_());
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
    gender: clean_(f.gender, 10).toLowerCase(),
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
    var map = regMap_(sheet);
    sheet.appendRow(rowArray_({
      'Submitted At (IST)': now, 'Registration ID': id, 'Child Name': data.childName, 'Date of Birth': data.dob,
      'Age (years)': ageFromDob_(data.dob), 'Gender': data.gender === 'male' ? 'Male' : 'Female',
      'School': data.school, 'Standard': data.standard, 'Division / Section': data.division,
      'Parent / Guardian Name': data.parentName, 'Email': data.email, 'Phone': data.phone, 'Phone Verified': 'Yes',
      'Page': data.page, 'UTM Source': data.utmSource, 'UTM Medium': data.utmMedium, 'UTM Campaign': data.utmCampaign
    }, map));
    var rowNo = sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }
  sendNewOrder_(rowNo); // create the neOwn order now; the 10-minute timer retries if this fails
  return { ok: true, id: id };
}

function validate_(d) {
  if (!d.childName || d.childName.length < 2) return { field: 'child_name', message: "Enter the child's full name." };
  var dobMsg = dobProblem_(d.dob);
  if (dobMsg) return { field: 'dob', message: dobMsg };
  if (d.gender !== 'male' && d.gender !== 'female') return { field: 'gender', message: "Select the child's gender." };
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
  var child = normName_(d.childName);
  var hit = regRows_(sheet, regMap_(sheet)).filter(function (r) {
    return String(r['Phone']).replace(/\D/g, '').slice(-10) === d.phone && normName_(r['Child Name']) === child;
  })[0];
  return hit ? String(hit['Registration ID']) : null;
}

function findById_(sheet, id) {
  return regRows_(sheet, regMap_(sheet)).some(function (r) { return String(r['Registration ID']) === id; });
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
    var map = headerMap_(sheet, SUBMISSION_COLUMNS);
    var last = sheet.getLastRow();
    if (last > 1) { // earlier uploads for this child are no longer the latest
      var ids = sheet.getRange(2, map['Registration ID'], last - 1, 1).getValues();
      var latest = sheet.getRange(2, map['Latest'], last - 1, 1).getValues();
      var changed = false;
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === up.childId && latest[i][0] !== 'No') { latest[i][0] = 'No'; changed = true; }
      }
      if (changed) sheet.getRange(2, map['Latest'], last - 1, 1).setValues(latest);
    }
    sheet.appendRow(rowArray_({
      'Uploaded At (IST)': now, 'Registration ID': up.childId, 'Child Name': kid.childName || '', 'School': kid.school || '',
      'Standard': kid.standard || '', 'Division / Section': kid.division || '', 'Phone': kid.phone || '',
      'File Name': file.getName(), 'Size (MB)': Math.round(file.getSize() / MB * 10) / 10, 'Drive Link': file.getUrl(),
      'Latest': 'Yes', 'Promo Consent': up.consent ? 'Yes' : 'No'
    }, map));
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
  var seen = {}, out = [];
  regRows_(sheet, regMap_(sheet)).forEach(function (r) {
    if (String(r['Phone']).replace(/\D/g, '').slice(-10) !== mobile) return;
    var id = String(r['Registration ID'] || '');
    var key = normName_(r['Child Name']);
    if (!id || seen[key]) return; // same child registered twice: keep the first
    seen[key] = true;
    out.push({ id: id, childName: String(r['Child Name']), school: String(r['School']), standard: String(r['Standard']),
      division: String(r['Division / Section']), phone: mobile });
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
    regRows_(reg, regMap_(reg)).forEach(function (r) { if (r['School']) schools[r['School']] = true; });
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
    sheet.getRange(1, SUBMISSION_COLUMNS.indexOf('Phone') + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  }
  headerMap_(sheet, SUBMISSION_COLUMNS); // adds any missing heading at the end
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

/* ---------- neOwn orders ----------
 * Each registration row becomes a Young Voice Championship order in the neOwn system through
 * ORDER_API_URL (script property). The URL decides the environment: a "dev-" host is dev,
 * anything else is prod. A row sent to dev is sent again once the URL points to prod.
 *
 * The API is not idempotent (every call makes a new order and a new child), so each row is
 * marked "Sending" before the call and is never resent automatically unless the API clearly
 * answered with an error. If no answer came back, the row is marked "Check" for the team.
 *
 * Statuses: Sent · Failed (API answered with an error; retried up to 3 times) ·
 *           Check (no answer; may or may not exist, look it up before clearing) ·
 *           Waiting for gender · Skip (typed by the team: never send, e.g. tests or duplicates) ·
 *           (blank = not sent yet). Clear the status to send a row again.
 */

var ORDER_MAX_ATTEMPTS = 3;
var ORDER_GAP_MS = 7000; // the API allows 10 calls a minute

/** Run from the editor: sends ONE row (the first one ready), for a first test. */
function sendOneOrder() {
  var r = syncOrders_(1);
  console.log(JSON.stringify(r));
}

/** Run from the editor: sends every row that is ready (stops after ~5 minutes; run again for more). */
function sendAllOrders() {
  var r = syncOrders_(1000);
  console.log(JSON.stringify(r));
}

/** Run once from the editor: every 10 minutes, send rows that are ready (new ones, failures to retry). */
function startOrderSync() {
  stopOrderSync();
  ScriptApp.newTrigger('orderSyncTick').timeBased().everyMinutes(10).create();
  console.log('Order sync runs every 10 minutes.');
}
function stopOrderSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'orderSyncTick') ScriptApp.deleteTrigger(t); });
}
function orderSyncTick() { syncOrders_(1000); }

function orderApi_() {
  var url = PropertiesService.getScriptProperties().getProperty('ORDER_API_URL') || '';
  if (!/^https:\/\//.test(url)) return null;
  return { url: url, env: /\/\/dev[-.]/i.test(url) ? 'dev' : 'prod' };
}

function genderOf_(v) {
  var g = String(v || '').trim().toLowerCase();
  g = { boy: 'male', m: 'male', girl: 'female', f: 'female' }[g] || g;
  return g === 'male' || g === 'female' ? g : '';
}

/** Sends up to `max` ready rows. Never runs twice at the same time. */
function syncOrders_(max) {
  var api = orderApi_();
  if (!api) return { ok: false, message: 'ORDER_API_URL script property is not set.' };
  // A separate lock from registrations, so a long run never makes parents wait.
  var runLock = LockService.getDocumentLock();
  if (!runLock.tryLock(1000)) return { ok: false, message: 'Busy; try again in a minute.' };
  var started = Date.now(), sent = 0, failed = 0, checked = 0, waiting = 0;
  try {
    var sheet = sheet_();
    var map = regMap_(sheet);
    var rows = regRows_(sheet, map);
    var stale = Date.now() - 10 * 60 * 1000;
    for (var i = 0; i < rows.length && sent + failed < max; i++) {
      if (Date.now() - started > 5 * 60 * 1000) break; // stay inside Apps Script's 6-minute limit
      var r = rows[i];
      if (!r['Registration ID']) continue;
      var status = String(r['Order Status'] || ''), env = String(r['Order Env'] || '');
      var attempts = Number(r['Order Attempts'] || 0);
      if (status === 'Sending') { // stuck from a run that never finished
        var at = r['Order Synced At (IST)'];
        var atMs = at instanceof Date ? at.getTime() : Date.parse(String(at).replace(' ', 'T') + '+05:30');
        if (!(atMs > stale)) {
          setOrderCells_(sheet, map, r.__row, { 'Order Status': 'Check', 'Order Error': 'No answer recorded from the API. Look the parent up in the neOwn system before clearing this.' });
          checked++;
        }
        continue;
      }
      if (status === 'Check' || status === 'Skip') continue; // Skip: the team marked it (test or duplicate row)
      if (status === 'Sent' && env === api.env) continue;
      if (status === 'Failed' && env === api.env && attempts >= ORDER_MAX_ATTEMPTS) continue;
      var gender = genderOf_(r['Gender']);
      if (!gender) {
        if (status !== 'Waiting for gender') setOrderCells_(sheet, map, r.__row, { 'Order Status': 'Waiting for gender', 'Order Error': 'Fill the Gender column (Male or Female).' });
        waiting++;
        continue;
      }
      if (sent + failed > 0) Utilities.sleep(ORDER_GAP_MS);
      var res = sendOrder_(api, sheet, map, r, gender, env === api.env ? attempts : 0);
      if (res === 'Sent') sent++; else if (res === 'Failed') failed++; else checked++;
    }
    var mail = api.env === 'prod' && emailsOn_() ? syncEmails_(started) : null;
    return { ok: true, env: api.env, sent: sent, failed: failed, check: checked, waiting_for_gender: waiting, emails: mail };
  } finally {
    runLock.releaseLock();
  }
}

function sendOrder_(api, sheet, map, r, gender, attempts) {
  var payload = {
    user: {
      phone: String(r['Phone'] || '').replace(/\D/g, '').slice(-10),
      name: String(r['Parent / Guardian Name'] || '').trim(),
      email: String(r['Email'] || '').trim()
    },
    child: {
      name: String(r['Child Name'] || '').trim(), gender: gender, dob: dobIso_(r['Date of Birth']),
      schoolName: String(r['School'] || '').trim(), standard: String(r['Standard'] || '').replace(/\D/g, '')
    }
  };
  if (!payload.user.email) delete payload.user.email;
  if (!payload.child.dob) delete payload.child.dob;

  setOrderCells_(sheet, map, r.__row, { 'Order Status': 'Sending', 'Order Env': api.env, 'Order Synced At (IST)': new Date(), 'Order Error': '', 'Order Attempts': attempts + 1 });
  SpreadsheetApp.flush(); // the mark must be saved before the call, so a crash can't cause a second order

  var res;
  try {
    res = UrlFetchApp.fetch(api.url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  } catch (e) {
    setOrderCells_(sheet, map, r.__row, { 'Order Status': 'Check', 'Order Synced At (IST)': new Date(), 'Order Error': 'No answer from the API (' + String(e.message || e).slice(0, 150) + '). Look the parent up in the neOwn system before clearing this.' });
    return 'Check';
  }
  var code = res.getResponseCode(), text = res.getContentText(), body = {};
  try { body = JSON.parse(text); } catch (e) {}
  if (code >= 200 && code < 300 && body && body.success) {
    setOrderCells_(sheet, map, r.__row, { 'Order Status': 'Sent', 'Order No': String(body.orderNo || ''), 'Order Synced At (IST)': new Date(), 'Order Error': '' });
    return 'Sent';
  }
  setOrderCells_(sheet, map, r.__row, { 'Order Status': 'Failed', 'Order Synced At (IST)': new Date(), 'Order Error': ('HTTP ' + code + ': ' + apiError_(body, text)).slice(0, 500) });
  return 'Failed';
}

/** Readable message out of the API's validation error shape. */
function apiError_(body, text) {
  var m = body && body.message;
  if (m && m.message && m.message.forEach) {
    var out = [];
    (function walk(list) {
      list.forEach(function (x) {
        var node = x.message && x.message.children ? x.message : x;
        if (node.constraints) Object.keys(node.constraints).forEach(function (k) { out.push(node.constraints[k]); });
        if (node.children && node.children.length) walk(node.children);
      });
    })(m.message);
    if (out.length) return out.join('; ');
  }
  if (typeof m === 'string') return m;
  return String(text || '').slice(0, 300);
}

function setOrderCells_(sheet, map, rowNo, v) {
  Object.keys(v).forEach(function (k) {
    var val = v[k];
    if (val instanceof Date) val = Utilities.formatDate(val, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
    sheet.getRange(rowNo, map[k]).setValue(val);
  });
}

/** DD/MM/YYYY (or a date cell) → YYYY-MM-DD. */
function dobIso_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim());
  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
}

/** Called right after a registration is saved: sends it at once (any failure is retried by the timer). */
function sendNewOrder_(rowNo) {
  try {
    var api = orderApi_();
    if (!api) return;
    var lock = LockService.getDocumentLock();
    if (!lock.tryLock(3000)) return; // a sync run is busy; the timer will pick it up
    try {
      var sheet = sheet_();
      var map = regMap_(sheet);
      var r = rowObj_(sheet.getRange(rowNo, 1, 1, map.__width).getValues()[0], map);
      r.__row = rowNo;
      if (r['Order Status']) return;
      var gender = genderOf_(r['Gender']);
      if (!gender) return;
      if (sendOrder_(api, sheet, map, r, gender, 0) === 'Sent' && api.env === 'prod' && emailsOn_()) {
        var fresh = rowObj_(sheet.getRange(rowNo, 1, 1, map.__width).getValues()[0], map);
        fresh.__row = rowNo;
        sendConfirmation_(sheet, map, fresh, emailContext_());
      }
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    console.error('sendNewOrder_ failed: ' + (e && e.stack || e));
  }
}

/* ---------- Confirmation email ----------
 * Once a row's order is Sent on prod, the parent gets the registration confirmation email, with the
 * Parent Guide PDF attached. Sent from EMAIL_FROM (default contact@neown.in): that address must be the
 * Google account that owns this script, or a "Send mail as" address in that account's Gmail.
 *
 * Dates come from the "Video Deadlines" tab, per school (or the "All schools" row):
 *   "Registration Close Date (DD/MM/YYYY)" → Select 2 books by; books reach the school 2 days later.
 *   "Last Date for Video (DD/MM/YYYY)"     → Video submission deadline.
 *
 * Email Status: Sent · Waiting for dates (school's dates not filled yet; sent once they are) ·
 *   No email · Failed (see Email Error; clear the status to try again) · Sending (stopped mid-send;
 *   check the contact@ Sent folder before clearing) · Skip (typed by the team). Blank = not sent yet.
 *
 * To start: Script Properties → CONFIRMATION_EMAILS = on. Run sendTestEmail first (it goes to you).
 */

var EMAIL = {
  whatsappGroup: 'https://chat.whatsapp.com/D6nzF5crdsoCZ8dcnfYxGb',
  whatsappHelp: '+91 93244 55972',
  whatsappHelpLink: 'https://wa.me/919324455972',
  appAndroid: 'https://play.google.com/store/apps/details?id=com.neown',
  appIos: 'https://apps.apple.com/in/app/neown/id6483860525',
  guide: 'https://cdn.shopify.com/s/files/1/0687/8557/0066/files/neOwn_Young_Voices_Championship_-_Parent_Guide.pdf?v=1795780334',
  guideName: 'neOwn_Young_Voices_Championship_-_Parent_Guide.pdf',
  prompts: {
    A: 'https://cdn.shopify.com/s/files/1/0687/8557/0066/files/neOwn_Young_Voices_Championship_Category_A_Grades_3_4.pdf?v=1795774634',
    B: 'https://cdn.shopify.com/s/files/1/0687/8557/0066/files/neOwn_Young_Voices_ChampionshipCategory_B_Grades_5_6.pdf?v=1795774634',
    C: 'https://cdn.shopify.com/s/files/1/0687/8557/0066/files/neOwn_Young_Voices_ChampionshipCategory_C_Grades_7_8.pdf?v=1795774634'
  }
};
var CLOSE_DATE_HEADING = 'Registration Close Date (DD/MM/YYYY)';
var VIDEO_DATE_HEADING = 'Last Date for Video (DD/MM/YYYY)';

/** Run from the editor: sends the email for the first prod "Sent" row to YOU (not the parent), to check it.
 *  Also the first run that asks for Gmail permission. Nothing is written to the sheet. */
function sendTestEmail() {
  var sheet = sheet_(), map = regMap_(sheet);
  var r = regRows_(sheet, map).filter(function (x) { return x['Order Status'] === 'Sent' && x['Order No']; })[0];
  if (!r) throw new Error('No row with an order number yet.');
  var ctx = emailContext_();
  var mail = buildEmail_(r, ctx);
  if (mail.missing) throw new Error('Fill ' + mail.missing + ' for "' + r['School'] + '" in the Video Deadlines tab first.');
  var me = Session.getEffectiveUser().getEmail();
  GmailApp.sendEmail(me, '[TEST] ' + mail.subject, mail.text, mailOptions_(mail, ctx));
  console.log('Test email for row ' + r.__row + ' sent to ' + me + ' from ' + (ctx.from || me));
}

/** Run from the editor: emails every row that is ready (prod order Sent, email not sent yet). */
function sendAllEmails() {
  if (!emailsOn_()) throw new Error('Set the CONFIRMATION_EMAILS script property to on first.');
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(5000)) throw new Error('Busy; try again in a minute.');
  try { console.log(JSON.stringify(syncEmails_(Date.now()))); } finally { lock.releaseLock(); }
}

function emailsOn_() {
  return String(PropertiesService.getScriptProperties().getProperty('CONFIRMATION_EMAILS') || '').trim().toLowerCase() === 'on';
}

/** Emails ready rows until ~5 minutes after `started`. Call while holding the document lock. */
function syncEmails_(started) {
  var out = { sent: 0, waiting_for_dates: 0, failed: 0, no_email: 0 };
  var sheet = sheet_(), map = regMap_(sheet), ctx = null;
  var rows = regRows_(sheet, map);
  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - started > 5 * 60 * 1000) break;
    var r = rows[i], st = String(r['Email Status'] || '');
    if (r['Order Status'] !== 'Sent' || r['Order Env'] !== 'prod' || !r['Order No']) continue;
    if (st && st !== 'Waiting for dates') continue;
    ctx = ctx || emailContext_();
    var res = sendConfirmation_(sheet, map, r, ctx);
    var key = { 'Sent': 'sent', 'Waiting for dates': 'waiting_for_dates', 'Failed': 'failed', 'No email': 'no_email' }[res];
    if (key) out[key]++;
    if (res === 'Failed' && ctx.fatal) break; // e.g. sender not set up: every row would fail the same way
  }
  return out;
}

/** Sends one row's email and records the result. Returns the Email Status written. */
function sendConfirmation_(sheet, map, r, ctx) {
  var st = String(r['Email Status'] || '');
  if (st && st !== 'Waiting for dates') return st;
  var to = String(r['Email'] || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return setEmailCells_(sheet, map, r.__row, 'No email', 'No valid email address in the Email column.');
  var mail = buildEmail_(r, ctx);
  if (mail.missing) {
    if (st !== 'Waiting for dates') setEmailCells_(sheet, map, r.__row, 'Waiting for dates', 'Fill ' + mail.missing + ' for this school in the Video Deadlines tab.');
    return 'Waiting for dates';
  }
  if (ctx.error) { ctx.fatal = true; setEmailCells_(sheet, map, r.__row, '', ctx.error); return 'Failed'; } // status left blank: retried once fixed
  setEmailCells_(sheet, map, r.__row, 'Sending', '');
  SpreadsheetApp.flush(); // saved before sending, so a crash can't send it twice
  try {
    GmailApp.sendEmail(to, mail.subject, mail.text, mailOptions_(mail, ctx));
  } catch (e) {
    return setEmailCells_(sheet, map, r.__row, 'Failed', String(e.message || e).slice(0, 300));
  }
  return setEmailCells_(sheet, map, r.__row, 'Sent', '', new Date());
}

function setEmailCells_(sheet, map, rowNo, status, error, at) {
  var v = { 'Email Status': status, 'Email Error': error };
  if (at) v['Email Sent At (IST)'] = at;
  setOrderCells_(sheet, map, rowNo, v);
  return status;
}

/** Shared per run: the sender, the school dates and the Parent Guide PDF. */
function emailContext_() {
  var ctx = { dates: schoolDates_(), from: '', error: '' };
  var want = (PropertiesService.getScriptProperties().getProperty('EMAIL_FROM') || 'contact@neown.in').trim().toLowerCase();
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (want !== me) {
    var aliases = GmailApp.getAliases().map(function (a) { return String(a).toLowerCase(); });
    if (aliases.indexOf(want) === -1) ctx.error = want + ' is not a "Send mail as" address in the Gmail of ' + me + '. Add it there (Gmail → Settings → Accounts) or run the script from ' + want + '.';
    else ctx.from = want;
  }
  try {
    var res = UrlFetchApp.fetch(EMAIL.guide, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) ctx.guide = res.getBlob().setName(EMAIL.guideName);
  } catch (e) {}
  if (!ctx.guide && !ctx.error) ctx.error = 'Could not download the Parent Guide PDF to attach.';
  return ctx;
}

function mailOptions_(mail, ctx) {
  var o = { htmlBody: mail.html, name: 'Team neOwn', attachments: [ctx.guide] };
  if (ctx.from) { o.from = ctx.from; o.replyTo = ctx.from; }
  return o;
}

/** Video Deadlines tab → { school: { close: 'yyyy-MM-dd', video: 'yyyy-MM-dd' } }, adding the close-date column if missing. */
function schoolDates_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEADLINES_SHEET) || (deadlines_(), SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEADLINES_SHEET));
  var map = headerMap_(sheet, ['School', VIDEO_DATE_HEADING, CLOSE_DATE_HEADING]);
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var out = {};
  var last = sheet.getLastRow();
  if (last < 2) return out;
  sheet.getRange(2, 1, last - 1, map.__width).getValues().forEach(function (v) {
    var o = rowObj_(v, map), school = normName_(o['School']);
    if (school) out[school] = { close: deadlineIso_(o[CLOSE_DATE_HEADING], tz), video: deadlineIso_(o[VIDEO_DATE_HEADING], tz) };
  });
  return out;
}

function categoryOf_(standard) {
  var n = Number(String(standard || '').replace(/\D/g, ''));
  return n === 3 || n === 4 ? 'A' : n === 5 || n === 6 ? 'B' : n === 7 || n === 8 ? 'C' : '';
}

function longDate_(iso, plusDays) {
  var p = iso.split('-');
  return Utilities.formatDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + (plusDays || 0), 12), 'Asia/Kolkata', 'd MMMM yyyy');
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** { subject, text, html } for a row, or { missing: 'what' } when a date or the category is unknown. */
function buildEmail_(r, ctx) {
  var schoolKey = normName_(r['School']);
  var own = ctx.dates[schoolKey] || {}, all = ctx.dates['all schools'] || {};
  var close = own.close || all.close, video = own.video || all.video;
  var cat = categoryOf_(r['Standard']);
  var missing = [];
  if (!close) missing.push('"' + CLOSE_DATE_HEADING + '"');
  if (!video) missing.push('"' + VIDEO_DATE_HEADING + '"');
  if (!cat) return { missing: 'a Standard between 3 and 8 (Category A/B/C)' };
  if (missing.length) return { missing: missing.join(' and ') };

  var child = String(r['Child Name'] || '').trim();
  var parent = String(r['Parent / Guardian Name'] || '').trim();
  var std = 'Std ' + String(r['Standard'] || '').replace(/\D/g, '');
  var school = String(r['School'] || '').trim();
  var d = { books: longDate_(close), delivery: longDate_(close, 2), video: longDate_(video) };
  var prompts = EMAIL.prompts[cat];
  var subject = child + ' is registered for the neOwn Young Voices Championship!';

  var text = [
    'Hi ' + parent + ',', '',
    'Welcome aboard! ' + child + ' (' + std + ', ' + school + ') is now registered for the neOwn Young Voices Championship in Category ' + cat + '.',
    'Your free 1-month neOwn subscription is now active, and no additional fee is required.', '',
    'Your key dates',
    '- Select 2 books by: ' + d.books,
    '- Books will be delivered to school: ' + d.delivery,
    '- Video submission deadline: ' + d.video, '',
    'What to do now',
    '1. Join the official parents\' WhatsApp group: ' + EMAIL.whatsappGroup + '. All updates and clarifications are shared here.',
    '2. Choose 2 books in the neOwn app. Download the neOwn App (Android: ' + EMAIL.appAndroid + ' | iPhone: ' + EMAIL.appIos + '). Log in with your registered mobile number, open the "Young Voices Championship" catalogue and select exactly 2 books. Both are compulsory. Books will be delivered to the school and have to be returned after 1 month.',
    '3. Download your category prompts: ' + prompts + '. Your child will make the video on one of the two books, answering one prompt.', '',
    'The full step-by-step guide is attached as a PDF, including recording tips and what happens after you submit. Please read it carefully.',
    'Questions? WhatsApp us on ' + EMAIL.whatsappHelp + '.', '',
    'Happy reading!', 'Team neOwn'
  ].join('\n');

  var a = function (href, label) { return '<a href="' + esc_(href) + '" style="color:#6c3bd1;font-weight:600;">' + esc_(label) + '</a>'; };
  var p = function (h) { return '<p style="margin:0 0 14px;">' + h + '</p>'; };
  var h3 = function (t) { return '<h3 style="margin:22px 0 10px;font-size:16px;color:#2b1a4f;">' + t + '</h3>'; };
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:600px;">' +
    p('Hi ' + esc_(parent) + ',') +
    p('Welcome aboard! <strong>' + esc_(child) + '</strong> (' + esc_(std) + ', ' + esc_(school) + ') is now registered for the neOwn Young Voices Championship in <strong>Category ' + cat + '</strong>.') +
    p('Your free 1-month neOwn subscription is now active, and no additional fee is required.') +
    h3('Your key dates') +
    '<ul style="margin:0 0 14px;padding-left:20px;">' +
      '<li>Select 2 books by: <strong>' + d.books + '</strong></li>' +
      '<li>Books will be delivered to school: <strong>' + d.delivery + '</strong></li>' +
      '<li>Video submission deadline: <strong>' + d.video + '</strong></li>' +
    '</ul>' +
    h3('What to do now') +
    '<ol style="margin:0 0 14px;padding-left:20px;">' +
      '<li style="margin-bottom:10px;">Join the official parents\' WhatsApp group: ' + a(EMAIL.whatsappGroup, 'join here') + '. All updates and clarifications are shared here.</li>' +
      '<li style="margin-bottom:10px;">Choose 2 books in the neOwn app. Download the neOwn App (' + a(EMAIL.appAndroid, 'Android') + ' | ' + a(EMAIL.appIos, 'iPhone') + '). Log in with your registered mobile number, open the "Young Voices Championship" catalogue and select exactly 2 books. Both are compulsory. Books will be delivered to the school and have to be returned after 1 month.</li>' +
      '<li style="margin-bottom:10px;">Download your category prompts: ' + a(prompts, 'Category ' + cat + ' prompts (PDF)') + '. Your child will make the video on one of the two books, answering one prompt.</li>' +
    '</ol>' +
    p('The full step-by-step guide is attached as a PDF, including recording tips and what happens after you submit. Please read it carefully.') +
    p('Questions? WhatsApp us on ' + a(EMAIL.whatsappHelpLink, EMAIL.whatsappHelp) + '.') +
    p('Happy reading!<br>Team neOwn') +
    '</div>';
  return { subject: subject, text: text, html: html };
}

/* ---------- Columns by heading ----------
 * The script finds every column by its heading in row 1, never by position, so the team can move,
 * add or hide columns. A missing heading is added at the end. Don't rename the headings.
 */

/** { heading: columnNumber } for the sheet; adds any of `columns` that are missing, at the end. */
function headerMap_(sheet, columns) {
  var width = Math.max(sheet.getLastColumn(), 1);
  var head = sheet.getRange(1, 1, 1, width).getValues()[0];
  var map = {};
  head.forEach(function (h, i) { var k = String(h).trim(); if (k && !map[k]) map[k] = i + 1; });
  var missing = columns.filter(function (c) { return !map[c]; });
  if (missing.length) {
    var start = head.filter(function (h) { return String(h).trim() !== ''; }).length ? width + 1 : 1;
    sheet.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
    missing.forEach(function (c, i) { map[c] = start + i; });
  }
  map.__width = Math.max(width, start ? start + missing.length - 1 : width);
  return map;
}

/** Row as { heading: value } for the given values array. */
function rowObj_(values, map) {
  var o = {};
  Object.keys(map).forEach(function (k) { if (k !== '__width') o[k] = values[map[k] - 1]; });
  return o;
}

/** Values array placing each { heading: value } in its column. */
function rowArray_(obj, map) {
  var arr = new Array(map.__width);
  for (var i = 0; i < arr.length; i++) arr[i] = '';
  Object.keys(obj).forEach(function (k) { if (map[k]) arr[map[k] - 1] = safeCell_(obj[k]); });
  return arr;
}

/** All data rows of the registrations sheet as objects (with .__row = sheet row number). */
function regRows_(sheet, map) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, map.__width).getValues().map(function (v, i) {
    var o = rowObj_(v, map); o.__row = i + 2; return o;
  });
}

function regMap_(sheet) { return headerMap_(sheet, COLUMNS); }

/* ---------- Helpers ---------- */

function sheet_() {
  var name = PropertiesService.getScriptProperties().getProperty('SHEET_NAME') || 'Sheet1';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
    sheet.getRange(1, COLUMNS.indexOf('Date of Birth') + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    sheet.getRange(1, COLUMNS.indexOf('Phone') + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
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
