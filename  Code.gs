/***** 設定區 *****/
const SPREADSHEET_ID = '1O0YjKzvl_dlPMHAQpsEiKTjKJZ21wdYhuSth78GbCCo'; // 用來存聊天紀錄
const TZ = 'Asia/Taipei';
const KEYWORDS = /(?:💩|便便|大便|poop)/gi;
const PROPS = PropertiesService.getScriptProperties();
function readToken_() {
  const t = PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!t) throw new Error('缺少 LINE_CHANNEL_ACCESS_TOKEN（Script Properties）');
  return t;
}
const GROUP_IDS_KEY = 'POOP_GROUP_IDS'; // 綁定的群組清單(JSON陣列)

/***** 小工具：群組清單 *****/
function getGroupIds() {
  const raw = PROPS.getProperty(GROUP_IDS_KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function saveGroupIds(ids) { PROPS.setProperty(GROUP_IDS_KEY, JSON.stringify(Array.from(new Set(ids)))); }
function addGroupId(gid) { const ids = getGroupIds(); if (!ids.includes(gid)) { ids.push(gid); saveGroupIds(ids);} }
function rmGroupId(gid) { saveGroupIds(getGroupIds().filter(x => x !== gid)); }

/***** Google Sheet 取用 *****/
function getSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const name = 'messages';
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['ts_iso', 'ts_local', 'groupId', 'userId', 'text', 'poop_count']);
  }
  return sheet;
}

/***** LINE API 小工具 *****/
function replyText(replyToken, text) {
  if (!replyToken) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + readToken_() },
    contentType: 'application/json',
    payload: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    muteHttpExceptions: true
  });
}
function pushText(to, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + readToken_() },
    contentType: 'application/json',
    payload: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    muteHttpExceptions: true
  });
}
function getDisplayName(groupId, userId) {
  try {
    const res = UrlFetchApp.fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + readToken_() },
      muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText() || '{}');
    return data.displayName || (userId || '').slice(-6);
  } catch (e) { return (userId || '').slice(-6); }
}

/***** Webhook 入口：記錄訊息＋處理指令 *****/
function doPost(e) {
  const out = ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    if (!raw) return out; // Verify / 健檢 → 直接 200
    const body = JSON.parse(raw);
    (body.events || []).forEach(ev => {
      if (!ev.source || ev.source.type !== 'group' || !ev.source.groupId) return;
      const gid = ev.source.groupId;

      if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
        const text = ev.message.text || '';
        // 指令
        const t = text.trim();
        if (t === '#bind') { addGroupId(gid); replyText(ev.replyToken, '✅ 已綁定；本群開始紀錄關鍵字。'); return; }
        if (t === '#unbind') { rmGroupId(gid); replyText(ev.replyToken, '🧹 已取消本群的統計。'); return; }
        if (t === '#便便?' || t === '#poop?') {
          replyText(ev.replyToken, '指令：#便便 7d｜#便便 week｜#便便 month｜#便便 YYYY-MM-DD YYYY-MM-DD｜#bind｜#unbind');
          return;
        }
        const m = t.match(/^#便便\s+(\d+)d$/i) || t.match(/^#poop\s+(\d+)d$/i);
        if (m) { replyText(ev.replyToken, buildReport(gid, daysAgo(parseInt(m[1],10)), new Date())); return; }
        if (/^#便便\s+week$/i.test(t)) { replyText(ev.replyToken, buildReport(gid, startOfWeek(), new Date())); return; }
        if (/^#便便\s+month$/i.test(t)) { replyText(ev.replyToken, buildReport(gid, startOfMonth(), new Date())); return; }
        const m2 = t.match(/^#便便\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})$/);
        if (m2) { replyText(ev.replyToken, buildReport(gid, new Date(m2[1] + 'T00:00:00'), new Date(m2[2] + 'T23:59:59'))); return; }

        // 非指令：記錄訊息
        if (getGroupIds().includes(gid)) {
          const poopCount = (text.match(KEYWORDS) || []).length;
          const now = new Date();
          getSheet().appendRow([
            now.toISOString(),
            Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm:ss'),
            gid,
            ev.source.userId || '',
            text,
            poopCount
          ]);
        }
      }
    });
  } catch (err) { console.error('doPost error:', err); }
  return out;
}


function doGet(e) {
  return ContentService.createTextOutput('GAS Webhook is active. Ready for LINE POST requests.');
}

/***** 統計與報表 *****/
function buildReport(groupId, start, end) {
  const values = getSheet().getDataRange().getValues();
  const header = values.shift(); // 去頭
  const startISO = start.toISOString();
  const endISO = end.toISOString();
  const perUser = {};
  let total = 0;
  values.forEach(r => {
    const [ts_iso, , gid, uid, , count] = r;
    if (gid !== groupId) return;
    if (!ts_iso || ts_iso < startISO || ts_iso > endISO) return;
    const c = Number(count) || 0;
    if (!c) return;
    perUser[uid] = (perUser[uid] || 0) + c;
    total += c;
  });

  const rows = Object.entries(perUser)
    .sort((a,b)=>b[1]-a[1])
    .slice(0, 10)
    .map(([uid, c], idx) => `${idx+1}. ${getDisplayName(groupId, uid)}：${c}`);

  const title = `💩 統計 (${fmtDate(start)} ~ ${fmtDate(end)})`;
  if (!rows.length) return `${title}\n這段期間沒有任何關鍵字紀錄～`;
  return `${title}\n總數：${total}\n— 前 10 名 —\n${rows.join('\n')}`;
}

/***** 定時：每天 21:00 檢查，如果是週六就發週報 *****/
function setupWeeklyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction()==='weeklyJob')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('weeklyJob').timeBased().atHour(21).everyDays(1).create();
}
function weeklyJob() {
  const today = new Date();
  // 週六才送（0=Sun,6=Sat）
  if (Utilities.formatDate(today, TZ, 'u') !== '6') return;
  const start = daysAgo(7);
  const ids = getGroupIds();
  ids.forEach(gid => pushText(gid, buildReport(gid, start, today)));
}

/***** 日期工具 *****/
function daysAgo(n){ const d=new Date(); d.setDate(d.getDate()-n); d.setHours(0,0,0,0); return d; }
function startOfWeek(){ const d=new Date(); const day=(d.getDay()+6)%7; d.setDate(d.getDate()-day); d.setHours(0,0,0,0); return d; } // 週一
function startOfMonth(){ const d=new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; }
function fmtDate(d){ return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }

