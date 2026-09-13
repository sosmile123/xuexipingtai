/* auth.js — 智慧学习平台 · 安全模块 v1
 * 被 index.html / admin.html / learning.html 共用。
 *
 * 解决的安全问题：
 *  1) 强密码哈希：PBKDF2-SHA256 + 随机盐（12 万次迭代），兼容并自动升级旧的 32 位弱哈希
 *  2) 会话：带过期时间（12h）+ 完整性签名；权限判定一律以「用户库」为准，不信任会话里的 role
 *  3) 登录限流：连续失败 5 次锁定 5 分钟（防暴力破解）
 *  4) HTML 转义：防存储型 XSS（昵称/作业/评语等跨设备传播的字段）
 *  5) 本地滚动备份：防误删/恶意覆盖，支持一键恢复
 *  6) 弱口令识别：默认口令（1234/admin123 等）识别与强制修改
 */
(function () {
  var A = window.SWAuth = {};
  var USER_DB_KEY = 'sw_users';
  var SESSION_KEY = 'sw_session';
  var SESSION_TTL = 12 * 3600 * 1000;   // 会话有效期 12 小时
  var SIG_SALT = 'sw_sig_v1_2026';      // 仅用于提高"手改 JSON"的门槛
  var PBKDF2_ITER = 120000;
  var MAX_FAIL = 5;                     // 连续失败次数上限
  var LOCK_MS = 5 * 60 * 1000;          // 锁定时长

  // ================= 1. HTML 转义（防 XSS） =================
  A.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"'`]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c];
    });
  };
  // 用于 JS 字符串上下文（onclick="fn('...')"）
  A.escJs = function (s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
  };

  // ================= 2. 用户库读写 =================
  A.loadUsers = function () {
    try { return JSON.parse(localStorage.getItem(USER_DB_KEY)) || {}; } catch (e) { return {}; }
  };
  A.saveUsers = function (u) { localStorage.setItem(USER_DB_KEY, JSON.stringify(u)); };

  // ================= 3. 密码哈希 =================
  function toB64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function fromB64(str) {
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function subtleOK() {
    try { return !!(window.crypto && window.crypto.subtle && window.isSecureContext); } catch (e) { return false; }
  }

  // 旧版弱哈希：仅用于兼容校验 + 自动升级，不再用于新密码
  A.legacyHash = function (str) {
    var hash = 0; str = String(str);
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); hash = ((hash << 5) - hash) + c; hash |= 0; }
    return 'h_' + Math.abs(hash).toString(36);
  };
  A.isLegacy = function (stored) { return /^h_/.test(String(stored || '')); };

  // 生成强哈希（异步）
  A.hash = async function (pwd) {
    pwd = String(pwd);
    if (!subtleOK()) return A.legacyHash(pwd); // 非 HTTPS/file:// 场景降级
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pwd), 'PBKDF2', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256
    );
    return 'pbkdf2$' + PBKDF2_ITER + '$' + toB64(salt) + '$' + toB64(bits);
  };

  // 校验密码（异步，兼容旧格式）
  A.verify = async function (pwd, stored) {
    stored = String(stored || '');
    if (/^pbkdf2\$/.test(stored)) {
      if (!subtleOK()) return false;
      try {
        var p = stored.split('$');
        var iter = parseInt(p[1], 10) || PBKDF2_ITER;
        var salt = fromB64(p[2]);
        var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pwd)), 'PBKDF2', false, ['deriveBits']);
        var bits = await crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, key, 256
        );
        var got = toB64(bits), want = p[3] || '';
        if (got.length !== want.length) return false;
        var diff = 0;
        for (var i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
        return diff === 0; // 定长比较，避免时序侧信道
      } catch (e) { return false; }
    }
    return A.legacyHash(pwd) === stored;
  };

  // 密码强度校验
  A.checkStrength = function (pwd) {
    pwd = String(pwd || '');
    if (pwd.length < 6) return '密码至少 6 位';
    if (pwd.length < 8 && !/[^a-zA-Z0-9]/.test(pwd) && !(/\d/.test(pwd) && /[a-zA-Z]/.test(pwd))) {
      return '密码太简单：请用 8 位以上，或 6 位以上且包含字母和数字';
    }
    if (/^(123456|1234567|12345678|111111|000000|abcdef|admin123|password|qwerty|123123|888888)$/i.test(pwd)) {
      return '该密码过于常见，请更换';
    }
    return null; // 通过
  };

  // 是否为已知默认弱口令（用于强制修改）
  A.weakDefaultOf = function (stored, uname) {
    var cands = ['1234', '123456', 'admin123', 'admin', '0000', 'password', '888888'];
    if (uname) cands.push(String(uname));
    for (var i = 0; i < cands.length; i++) {
      if (A.legacyHash(cands[i]) === stored) return cands[i];
    }
    return null;
  };

  // ================= 4. 会话管理 =================
  function sign(payload) {
    var s = payload + '|' + SIG_SALT, h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
  }
  A.setSession = function (obj) {
    var o = {};
    for (var k in obj) o[k] = obj[k];
    o.loginAt = Date.now();
    o.exp = Date.now() + SESSION_TTL;
    o.sig = sign(String(o.username) + '|' + o.exp);
    localStorage.setItem(SESSION_KEY, JSON.stringify(o));
    return o;
  };
  A.getSession = function () {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
    if (!s || !s.username) return null;
    if (!s.exp || Date.now() > s.exp) { A.clearSession(); return null; }        // 过期
    if (s.sig !== sign(String(s.username) + '|' + s.exp)) { A.clearSession(); return null; } // 被篡改
    return s;
  };
  A.clearSession = function () { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} };

  // 当前登录身份：role 一律以用户库为准（防止改 session 提权）
  A.authUser = function () {
    var s = A.getSession(); if (!s) return null;
    var u = A.loadUsers()[s.username]; if (!u) return null;
    return { username: s.username, displayName: u.displayName || s.username, role: u.role, record: u, session: s };
  };
  A.isAdmin = function () { var a = A.authUser(); return !!(a && a.role === 'admin'); };
  A.isParent = function () { var a = A.authUser(); return !!(a && (a.role === 'parent' || a.role === 'admin')); };
  A.isStudent = function () { var a = A.authUser(); return !!(a && a.role === 'student'); };
  A.myFamily = function () {
    var a = A.authUser(); if (!a) return null;
    var fams = {};
    try { fams = JSON.parse(localStorage.getItem('sw_families')) || {}; } catch (e) {}
    for (var fk in fams) {
      if (fams[fk] && fams[fk].members && fams[fk].members.indexOf(a.username) >= 0) return fk;
    }
    return null;
  };

  // ================= 5. 登录限流 =================
  function lockKey(u) { return 'sw_lock_' + u; }
  A.lockRemain = function (uname) {  // 返回剩余锁定秒数，0=未锁定
    try {
      var d = JSON.parse(localStorage.getItem(lockKey(uname)) || 'null');
      if (d && d.until && Date.now() < d.until) return Math.ceil((d.until - Date.now()) / 1000);
    } catch (e) {}
    return 0;
  };
  A.recordFail = function (uname) {
    var d = { n: 0, until: 0 };
    try { d = JSON.parse(localStorage.getItem(lockKey(uname)) || 'null') || d; } catch (e) {}
    d.n = (d.n || 0) + 1;
    if (d.n >= MAX_FAIL) { d.until = Date.now() + LOCK_MS; d.n = 0; }
    try { localStorage.setItem(lockKey(uname), JSON.stringify(d)); } catch (e) {}
    return A.lockRemain(uname);
  };
  A.clearFail = function (uname) { try { localStorage.removeItem(lockKey(uname)); } catch (e) {} };
  A.failRemain = function (uname) {  // 剩余可尝试次数
    try {
      var d = JSON.parse(localStorage.getItem(lockKey(uname)) || 'null');
      var n = (d && d.n) ? d.n : 0;
      return Math.max(0, MAX_FAIL - n);
    } catch (e) { return MAX_FAIL; }
  };

  // ================= 6. 本地滚动备份（防误删/恶意覆盖） =================
  var BAK_KEYS = ['sw_users', 'sw_families'];
  var BAK_MAX = 3;
  A.backup = function () {
    try {
      var snap = { at: Date.now(), data: {} };
      for (var i = 0; i < BAK_KEYS.length; i++) snap.data[BAK_KEYS[i]] = localStorage.getItem(BAK_KEYS[i]);
      var id = 'sw_bak_' + snap.at;
      localStorage.setItem(id, JSON.stringify(snap));
      var list = [];
      try { list = JSON.parse(localStorage.getItem('sw_bak_list') || '[]'); } catch (e) {}
      list.unshift(id);
      while (list.length > BAK_MAX) { var old = list.pop(); localStorage.removeItem(old); }
      localStorage.setItem('sw_bak_list', JSON.stringify(list));
      return true;
    } catch (e) { return false; }
  };
  A.listBackups = function () {
    try { return JSON.parse(localStorage.getItem('sw_bak_list') || '[]'); } catch (e) { return []; }
  };
  A.restoreBackup = function (id) {
    try {
      var snap = JSON.parse(localStorage.getItem(id) || 'null');
      if (!snap || !snap.data) return false;
      for (var k in snap.data) { if (snap.data[k] != null) localStorage.setItem(k, snap.data[k]); }
      return true;
    } catch (e) { return false; }
  };

  // ================= 7. 数据校验（导入/写入前） =================
  A.validateUsersShape = function (obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    var n = 0;
    for (var k in obj) {
      n++;
      if (n > 5000) return false;                       // 规模上限，防超大数据炸库
      var u = obj[k];
      if (!u || typeof u !== 'object') return false;
      if (typeof u.role !== 'string') return false;
    }
    return true;
  };
  A.validateFamiliesShape = function (obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    for (var k in obj) {
      var f = obj[k];
      if (!f || typeof f !== 'object') return false;
      if (f.members != null && !Array.isArray(f.members)) return false;
    }
    return true;
  };
  // 清除不应进入云端/界面的敏感字段（如历史遗留的重置验证码）
  A.stripSensitive = function (users) {
    var changed = false;
    for (var k in users) {
      var d = users[k] && users[k].data;
      if (d && d._resetCode) { delete d._resetCode; changed = true; }
    }
    return changed;
  };

  A.version = 'auth-v1';
})();
