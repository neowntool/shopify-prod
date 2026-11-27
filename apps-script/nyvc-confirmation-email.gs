/**
 * NYVC registration confirmation email. A separate file in the same Apps Script project as
 * nyvc-registration.gs (it uses that file's helpers); it doesn't change how registrations or orders work.
 *
 * Every 10 minutes it looks for rows whose neOwn order is Sent on prod (Order No filled) and emails the
 * parent from EMAIL_FROM (default contact@neown.in) with the Parent Guide PDF attached. Each row is
 * emailed once; the result is written in the Email Status / Email Sent At (IST) / Email Error columns
 * (added at the end of the sheet on first run).
 *
 * Dates come from the "Video Deadlines" tab, per school (or the "All schools" row):
 *   "Registration Close Date (DD/MM/YYYY)" → Select 2 books by; books reach the school 2 days later.
 *   "Last Date for Video (DD/MM/YYYY)"     → Video submission deadline.
 *
 * Email Status: Sent · Waiting for dates (school's dates not filled yet; sent once they are) ·
 *   No email · Failed (see Email Error; clear the status to try again) · Sending (stopped mid-send;
 *   check contact@'s Sent folder before clearing) · Skip (type it yourself: never email this row).
 *   Blank = not sent yet.
 *
 * Setup:
 *  1. Apps Script editor → Files → + → Script, name it "nyvc-confirmation-email", paste this file, save.
 *  2. Run sendTestEmail (approve Gmail access). It emails YOU the first order's email, marked [TEST].
 *  3. Script Properties → add CONFIRMATION_EMAILS = on. (EMAIL_FROM is optional.)
 *  4. Run startEmailSync once. To pause: stopEmailSync, or set CONFIRMATION_EMAILS to off.
 * No new deployment is needed: the timer runs the saved code, not the web app version.
 */

var EMAIL_COLUMNS = ['Email Status', 'Email Sent At (IST)', 'Email Error'];

/** Run once: every 10 minutes, email the rows that are ready. */
function startEmailSync() {
  stopEmailSync();
  ScriptApp.newTrigger('emailSyncTick').timeBased().everyMinutes(10).create();
  console.log('Confirmation emails run every 10 minutes' + (emailsOn_() ? '.' : ', but CONFIRMATION_EMAILS is not "on" yet, so nothing is sent.'));
}
function stopEmailSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'emailSyncTick') ScriptApp.deleteTrigger(t); });
}
function emailSyncTick() {
  if (!emailsOn_()) return;
  var lock = LockService.getUserLock(); // its own lock: never makes registrations or orders wait
  if (!lock.tryLock(1000)) return;
  try { var r = syncEmails_(Date.now()); if (r.sent || r.failed) console.log(JSON.stringify(r)); } finally { lock.releaseLock(); }
}

/** Sheet columns by heading, including the email columns (added at the end if missing). */
function emailMap_(sheet) { return headerMap_(sheet, COLUMNS.concat(EMAIL_COLUMNS)); }

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
EMAIL.logo = 'https://cdn.shopify.com/s/files/1/0687/8557/0066/files/newon_logo.png?v=1794374895';
EMAIL.whatsappIcon = 'https://cdn.shopify.com/s/files/1/0687/8557/0066/files/logos_whatsapp-icon.png?v=1769157724';
var CLOSE_DATE_HEADING = 'Registration Close Date (DD/MM/YYYY)';
var VIDEO_DATE_HEADING = 'Last Date for Video (DD/MM/YYYY)';

/** Run from the editor: sends the email for the first prod "Sent" row to YOU (not the parent), to check it.
 *  Also the first run that asks for Gmail permission. Nothing is written to the sheet. */
function sendTestEmail() {
  var sheet = sheet_(), map = emailMap_(sheet);
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
  var lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) throw new Error('Busy; try again in a minute.');
  try { console.log(JSON.stringify(syncEmails_(Date.now()))); } finally { lock.releaseLock(); }
}

function emailsOn_() {
  return String(PropertiesService.getScriptProperties().getProperty('CONFIRMATION_EMAILS') || '').trim().toLowerCase() === 'on';
}

/** Emails ready rows until ~5 minutes after `started`. Call while holding the user lock. */
function syncEmails_(started) {
  var out = { sent: 0, waiting_for_dates: 0, failed: 0, no_email: 0 };
  var sheet = sheet_(), map = emailMap_(sheet), ctx = null;
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

  var html = emailHtml_({ parent: parent, child: child, std: std, school: school, cat: cat, prompts: prompts,
    dates: [['Select 2 books by', close, 0], ['Books delivered to school', close, 2], ['Video submission deadline', video, 0]] });
  return { subject: subject, text: text, html: html };
}

/** Email HTML: tables and inline styles only, so Gmail, Outlook and phone mail apps show it the same. */
function emailHtml_(v) {
  var P = '#6730ef', P10 = '#efeaff', PINK = '#ff2fac', INK = '#2b2340', MUTED = '#6a6a7a', LINE = '#ece8f7';
  var font = "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;";
  var btn = function (href, label, bg, color) {
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;margin:10px 8px 0 0;"><tr>' +
      '<td style="border-radius:999px;background:' + bg + ';"><a href="' + esc_(href) + '" style="' + font + 'display:inline-block;padding:11px 20px;font-size:14px;font-weight:700;color:' + (color || '#ffffff') + ';text-decoration:none;border-radius:999px;">' + label + '</a></td>' +
      '</tr></table>';
  };
  var parts = function (iso, plus) {
    var p = iso.split('-'), dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + (plus || 0), 12);
    return { day: Utilities.formatDate(dt, 'Asia/Kolkata', 'd'), mon: Utilities.formatDate(dt, 'Asia/Kolkata', 'MMM').toUpperCase(),
      full: Utilities.formatDate(dt, 'Asia/Kolkata', 'EEEE, d MMMM yyyy') };
  };
  var dateRows = v.dates.map(function (d, i) {
    var x = parts(d[1], d[2]);
    return '<tr><td style="padding:' + (i ? '12px' : '0') + ' 0 0;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        '<td width="58" valign="middle" style="width:58px;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="58"><tr><td align="center" style="background:' + P + ';border-radius:12px;padding:8px 0;' + font + 'color:#ffffff;">' +
            '<div style="font-size:22px;line-height:24px;font-weight:800;">' + x.day + '</div>' +
            '<div style="font-size:11px;line-height:14px;font-weight:700;letter-spacing:1px;">' + x.mon + '</div>' +
          '</td></tr></table>' +
        '</td>' +
        '<td valign="middle" style="padding-left:14px;' + font + '">' +
          '<div style="font-size:15px;line-height:20px;font-weight:700;color:' + INK + ';">' + d[0] + '</div>' +
          '<div style="font-size:13px;line-height:18px;color:' + MUTED + ';">' + x.full + '</div>' +
        '</td></tr></table>' +
      '</td></tr>';
  }).join('');
  var step = function (n, title, body, buttons) {
    return '<tr><td style="padding:0 0 22px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        '<td width="40" valign="top" style="width:40px;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="30" height="30" style="width:30px;height:30px;border-radius:50%;background:' + PINK + ';' + font + 'font-size:15px;font-weight:800;color:#ffffff;">' + n + '</td></tr></table>' +
        '</td>' +
        '<td valign="top" style="' + font + '">' +
          '<div style="font-size:16px;line-height:22px;font-weight:700;color:' + INK + ';padding-top:4px;">' + title + '</div>' +
          '<div style="font-size:14px;line-height:21px;color:' + MUTED + ';padding-top:4px;">' + body + '</div>' +
          (buttons || '') +
        '</td></tr></table>' +
      '</td></tr>';
  };
  var section = function (title) {
    return '<div style="' + font + 'font-size:12px;line-height:16px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:' + P + ';padding:0 0 14px;">' + title + '</div>';
  };

  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>' +
  '<body style="margin:0;padding:0;background:#f4f1fb;">' +
  '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc_(v.child) + ' is in, Category ' + v.cat + '. Your key dates and 3 quick next steps inside.</div>' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1fb;"><tr><td align="center" style="padding:24px 12px;">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">' +

  // Header
  '<tr><td align="center" style="background:' + P + ';border-radius:20px 20px 0 0;padding:30px 24px 34px;">' +
    '<img src="' + EMAIL.logo + '" width="120" alt="neOwn" style="display:block;width:120px;height:auto;border:0;margin:0 auto 22px;">' +
    '<div style="' + font + 'font-size:13px;line-height:18px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#dceb5f;">Young Voices Championship</div>' +
    '<div style="' + font + 'font-size:30px;line-height:36px;font-weight:800;color:#ffffff;padding-top:8px;">You\'re registered! 🎉</div>' +
  '</td></tr>' +

  // Body
  '<tr><td style="background:#ffffff;padding:28px 28px 8px;">' +
    '<div style="' + font + 'font-size:16px;line-height:24px;color:' + INK + ';">Hi ' + esc_(v.parent) + ',</div>' +
    '<div style="' + font + 'font-size:15px;line-height:23px;color:' + MUTED + ';padding-top:8px;">Welcome aboard! Here are the details of your registration.</div>' +

    // Child card
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;background:' + P10 + ';border-radius:16px;"><tr><td style="padding:20px 22px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        '<td valign="middle" style="' + font + '">' +
          '<div style="font-size:12px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:' + P + ';">Participant</div>' +
          '<div style="font-size:22px;line-height:28px;font-weight:800;color:' + INK + ';padding-top:4px;">' + esc_(v.child) + '</div>' +
          '<div style="font-size:14px;line-height:20px;color:' + MUTED + ';padding-top:2px;">' + esc_(v.std) + ' · ' + esc_(v.school) + '</div>' +
        '</td>' +
        '<td valign="middle" align="right" width="84" style="width:84px;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right"><tr><td align="center" style="background:' + PINK + ';border-radius:14px;padding:8px 12px;' + font + 'color:#ffffff;">' +
            '<div style="font-size:10px;line-height:12px;font-weight:700;letter-spacing:1px;">CATEGORY</div>' +
            '<div style="font-size:28px;line-height:32px;font-weight:800;">' + v.cat + '</div>' +
          '</td></tr></table>' +
        '</td></tr></table>' +
    '</td></tr></table>' +

    // Subscription
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;"><tr><td style="border:1px dashed ' + P + ';border-radius:14px;padding:13px 16px;' + font + 'font-size:14px;line-height:21px;color:' + INK + ';">' +
      '🎁 <strong>Your free 1-month neOwn subscription is now active.</strong> No additional fee is required.' +
    '</td></tr></table>' +
  '</td></tr>' +

  // Key dates
  '<tr><td style="background:#ffffff;padding:22px 28px 6px;">' +
    '<div style="border-top:1px solid ' + LINE + ';padding-top:24px;">' + section('Your key dates') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + dateRows + '</table>' +
  '</td></tr>' +

  // Steps
  '<tr><td style="background:#ffffff;padding:22px 28px 4px;">' +
    '<div style="border-top:1px solid ' + LINE + ';padding-top:24px;">' + section('What to do now') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
      step(1, 'Join the parents\' WhatsApp group', 'All updates and clarifications are shared here.',
        btn(EMAIL.whatsappGroup, 'Join WhatsApp group', '#25d366')) +
      step(2, 'Choose 2 books in the neOwn app',
        'Log in with your registered mobile number, open the <strong style="color:' + INK + ';">“Young Voices Championship”</strong> catalogue and select exactly 2 books. Both are compulsory. Books will be delivered to the school and have to be returned after 1 month.',
        btn(EMAIL.appAndroid, 'Get it on Android', INK) + btn(EMAIL.appIos, 'Get it on iPhone', INK)) +
      step(3, 'Download your category prompts', 'Your child will make the video on one of the two books, answering one prompt.',
        btn(v.prompts, 'Category ' + v.cat + ' prompts (PDF)', P)) +
    '</table>' +
  '</td></tr>' +

  // Guide
  '<tr><td style="background:#ffffff;padding:0 28px 28px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff4fb;border-radius:14px;"><tr><td style="padding:16px 18px;' + font + 'font-size:14px;line-height:21px;color:' + INK + ';">' +
      '📎 <strong>The full step-by-step Parent Guide is attached</strong>, including recording tips and what happens after you submit. Please read it carefully.' +
    '</td></tr></table>' +
  '</td></tr>' +

  // Help + sign-off
  '<tr><td style="background:#ffffff;border-radius:0 0 20px 20px;padding:0 28px 30px;">' +
    '<div style="border-top:1px solid ' + LINE + ';padding-top:22px;' + font + 'font-size:14px;line-height:22px;color:' + MUTED + ';">' +
      'Questions? WhatsApp us on <a href="' + EMAIL.whatsappHelpLink + '" style="color:' + P + ';font-weight:700;text-decoration:none;">' + EMAIL.whatsappHelp + '</a>' +
    '</div>' +
    '<div style="' + font + 'font-size:16px;line-height:24px;color:' + INK + ';padding-top:16px;">Happy reading!<br><strong>Team neOwn</strong></div>' +
  '</td></tr>' +

  '<tr><td align="center" style="padding:18px 12px 0;' + font + 'font-size:12px;line-height:18px;color:#9a94ad;">' +
    'You\'re receiving this because you registered ' + esc_(v.child) + ' for the neOwn Young Voices Championship.<br>' +
    '<a href="https://neown.in" style="color:#9a94ad;">neown.in</a>' +
  '</td></tr>' +

  '</table></td></tr></table></body></html>';
}
