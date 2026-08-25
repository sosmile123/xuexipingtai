/*
 * 学生工作台 · 云端同步模块 v4（Supabase 免费版）
 * 把 localStorage 中的「账号(sw_users) / 家庭(sw_families) / 邀请码(sw_invite_code)」
 * 同步到 Supabase Postgres 数据库（表 wb_state），实现跨设备实时同步。
 *
 * 相比 v3（kvdb.io）：
 *   - 单条限制 16KB → Postgres TEXT 上限 1GB，容量无忧（免费 500MB 数据库）
 *   - API 请求无限次（免费档）
 *   - 无需同步码：所有设备打开同一网址即自动同步同一份数据
 *
 * 数据结构（表 wb_state）：
 *   key      text  主键，如 sw_users / sw_families / sw_invite_code
 *   value    text  本地数据 JSON 字符串
 *   version  int8  修改时间戳（越大越新），用于冲突判断
 *
 * 注意：免费项目连续 1 周无访问会自动暂停，到 Supabase 后台点恢复即可。
 */
(function () {
  if (window.__sw_sync_v4) return; // 防重复注入
  window.__sw_sync_v4 = true;

  // iframe（admin.html / learning.html）内不重复劫持父页面 Storage.prototype，
  // 而是：① 劫持本 frame 的 localStorage 写入 → 自动通知父页面推送云端
  //       ② SyncHub.push/pull 代理到父页面真实实现（父页面 index.html 持有真实 SyncHub）
  var _isTop = (window.top === window);
  if (!_isTop) {
    // 本 frame 内写 sw_* key 时，通知父页面统一推送（改密码/改年级/进度/积分等全部生效）
    try {
      var _ls = window.localStorage;
      var _origSetF = _ls.setItem.bind(_ls);
      var _origRemoveF = _ls.removeItem.bind(_ls);
      var _tF = null;
      function _notifyTop() {
        clearTimeout(_tF);
        _tF = setTimeout(function () {
          try {
            // 交给顶层 push 统一处理：未就绪会自动排队，不丢弃（修复：首次拉取未完成时家长端写入被静默丢弃）
            if (window.top && window.top.SyncHub) {
              window.top.SyncHub.push();
            }
          } catch (e) {}
        }, 400);
      }
      _ls.setItem = function (k, v) {
        _origSetF(k, v);
        if (['sw_users', 'sw_families', 'sw_invite_code'].indexOf(k) >= 0) _notifyTop();
      };
      _ls.removeItem = function (k) {
        _origRemoveF(k);
        if (['sw_users', 'sw_families', 'sw_invite_code'].indexOf(k) >= 0) _notifyTop();
      };
    } catch (e) {}
    window.SyncHub = {
      isReady: function () { return !!(window.top && window.top.SyncHub); },
      getCode: function () { return 'supabase-cloud'; },
      enable: function () { return Promise.resolve('supabase-cloud'); },
      bind: function () { return Promise.resolve(true); },
      push: function () {
        try {
          if (window.top && window.top.SyncHub) {
            // 未就绪时顶层 push 会自动排队补发，这里不再丢弃
            return window.top.SyncHub.push();
          }
        } catch (e) {}
        return Promise.resolve(true);
      },
      pull: function (opts) {
        try { if (window.top && window.top.SyncHub) return window.top.SyncHub.pull(opts); } catch (e) {}
        return Promise.resolve(false);
      },
      getVersion: function (k) {
        try { if (window.top && window.top.SyncHub) return window.top.SyncHub.getVersion(k); } catch (e) {}
        return 0;
      }
    };
    return;
  }

  var SUPABASE_URL = 'https://uybqrwrxoyiivndyaugf.supabase.co/rest/v1';
  var SUPABASE_KEY = 'sb_publishable_vmtGZwElbLEL6UyeoWsB3Q_Rv4A0jVM';
  var TABLE = 'wb_state';
  var SYNC_KEYS = ['sw_users', 'sw_families', 'sw_invite_code'];
  var LS = window.localStorage;

  var _origSet = LS.setItem.bind(LS);
  var _origRemove = LS.removeItem.bind(LS);
  var _timer = null;
  var _applyingRemote = false;
  var _pulling = false;
  var _firstPullDone = false; // 首次拉取完成前禁止推送，防止默认数据覆盖云端已注册用户
  var _lastReloadAt = 0; // reload 防抖时间戳

  function verKey(k) { return 'sw_sync_ver_' + k; }
  function getVer(k) { return parseInt(LS.getItem(verKey(k)) || '0', 10) || 0; }
  function setVer(k, v) { _origSet(verKey(k), String(v)); }

  function headers() {
    return {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    };
  }

  function collectState() {
    var s = {};
    for (var i = 0; i < SYNC_KEYS.length; i++) s[SYNC_KEYS[i]] = LS.getItem(SYNC_KEYS[i]);
    return s;
  }
  function applyState(state) {
    for (var i = 0; i < SYNC_KEYS.length; i++) {
      if (state[SYNC_KEYS[i]] != null) _origSet(SYNC_KEYS[i], state[SYNC_KEYS[i]]);
    }
  }

  // 账号级合并：云端账号 ∪ 本地账号（字段级递归合并，不丢数据）
  // 核心修复①：原实现「同名账号整体本地优先」→ 学生端本地账号只要存在（哪怕 data 为空），
  //   pull 时云端新数据被丢弃、push 时把云端成绩/进度整体覆盖清空 → 「家长端设置的内容学生端看不到」。
  // 现改为字段级合并：对象递归、数组按 id 并集（成绩/作业/错题等双方都会追加）、标量非空优先（冲突本地优先）。
  function mergeUsers(localStr, cloudStr) {
    try {
      var L = JSON.parse(localStr || '{}');
      var C = JSON.parse(cloudStr || '{}');
      var M = {};
      var keys = {};
      var k;
      for (k in L) keys[k] = 1;
      for (k in C) keys[k] = 1;
      for (k in keys) {
        if (L[k] == null) M[k] = C[k];
        else if (C[k] == null) M[k] = L[k];
        else M[k] = mergeRec(L[k], C[k]);
      }
      return JSON.stringify(M);
    } catch (e) { return localStr || cloudStr || '{}'; }
  }

  // 递归字段级合并：对象递归；数组按 id（无 id 按 JSON 串）并集去重；标量非空优先、都非空本地优先
  function _isEmpty(v) { return v === undefined || v === null || v === ''; }
  function _arrKey(x) {
    if (x == null) return '_n';
    if (x.id != null && x.id !== '') return 'id:' + x.id;
    if (typeof x === 'string') return 's:' + x;
    return 'j:' + JSON.stringify(x);
  }
  function mergeRec(l, c) {
    if (l == null) return c;
    if (c == null) return l;
    var aL = Array.isArray(l), aC = Array.isArray(c);
    var tL = typeof l, tC = typeof c;
    // 都是普通对象 → 递归
    if (!aL && !aC && tL === 'object' && tC === 'object') {
      var out = {};
      var ks = {};
      var kk;
      for (kk in l) ks[kk] = 1;
      for (kk in c) ks[kk] = 1;
      for (kk in ks) {
        if (l[kk] === undefined) out[kk] = c[kk];
        else if (c[kk] === undefined) out[kk] = l[kk];
        else out[kk] = mergeRec(l[kk], c[kk]);
      }
      return out;
    }
    // 任一是数组 → 按 key 并集
    if (aL || aC) {
      var a1 = aL ? l : [];
      var a2 = aC ? c : [];
      var map = {};
      var i, x, k2;
      for (i = 0; i < a1.length; i++) { x = a1[i]; map[_arrKey(x)] = x; }
      for (i = 0; i < a2.length; i++) { x = a2[i]; k2 = _arrKey(x); if (map[k2] !== undefined) map[k2] = mergeRec(map[k2], x); else map[k2] = x; }
      var out = [];
      for (var mk in map) out.push(map[mk]);
      return out;
    }
    // 标量
    if (_isEmpty(l)) return c;
    if (_isEmpty(c)) return l;
    return l;
  }

  // 家庭级合并：本地家庭 ∪ 云端家庭（家庭以名称为键，双方取并集，同名以本地为准）
  // 核心修复：之前 sw_families 走「本地非空即忽略云端 / 推送时本地直接覆盖云端」，
  // 导致设备 A 建了家庭，设备 B（本地空 {}）永远拉不到；且 B 一旦推送就把云端家庭整体清空 → 「家长看不到学生」。
  // 改为并集合并后，无论哪端先写，最终都收敛为家庭并集，互不删除，跨设备可见。
  function mergeFamilies(localStr, cloudStr) {
    try {
      var L = JSON.parse(localStr || '{}');
      var C = JSON.parse(cloudStr || '{}');
      var M = {};
      var keys = {};
      var k;
      for (k in L) keys[k] = 1;
      for (k in C) keys[k] = 1;
      for (k in keys) {
        if (L[k] && !C[k]) M[k] = L[k];
        else if (C[k] && !L[k]) M[k] = C[k];
        else M[k] = L[k]; // 都有：本地优先
      }
      return JSON.stringify(M);
    } catch (e) { return localStr || cloudStr || '{}'; }
  }

  // 读取单个 key：返回 { value, version, ok } 或 { __error: true }
  // ok=true 表示请求成功（即使云端无数据），ok=false 表示网络错误
  function readKey(key) {
    return fetch(SUPABASE_URL + '/' + TABLE + '?key=eq.' + encodeURIComponent(key) + '&select=value,version', { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('read ' + r.status)); })
      .then(function (rows) {
        if (rows && rows.length) { rows[0].ok = true; return rows[0]; }
        return { ok: true }; // 云端无此 key，但请求成功
      })
      .catch(function () { return { __error: true }; });
  }

  // upsert 写入单个 key（key 冲突时更新 value/version）
  function writeKey(key, value, version) {
    return fetch(SUPABASE_URL + '/' + TABLE + '?on_conflict=key', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify([{ key: key, value: String(value), version: version }])
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // 拉取：云端数据合并到本地（账号不丢失，跨设备收敛）
  function pull(options) {
    options = options || {};
    if (_pulling) return Promise.resolve(false);
    _pulling = true;
    var changed = false;
    var fetchOk = false; // 至少一次请求成功（区分"云端无数据"和"网络失败"）
    var tasks = SYNC_KEYS.map(function (key) {
      return readKey(key).then(function (item) {
        if (!item || item.__error) return;
        fetchOk = true; // 请求成功（无论云端是否有数据，全新部署也算成功）
        if (item.value == null) return; // 云端无此 key
        var local = LS.getItem(key);
        var merged = (key === 'sw_users') ? mergeUsers(local, item.value) : (key === 'sw_families') ? mergeFamilies(local, item.value) : ((local != null) ? local : item.value);
        if (merged !== local) {
          _applyingRemote = true;
          _origSet(key, merged);
          _applyingRemote = false;
          changed = true;
        }
        setVer(key, parseInt(item.version || '0', 10) || 0);
        _setFp(key, _fp(merged)); // 同步指纹：避免 pull 后把刚拉到的数据再推回去推高版本号
      });
    });
    return Promise.all(tasks).then(function () {
      _pulling = false;
      // 仅在网络正常时才标记"拉取完成"，防止网络故障时默认数据覆盖云端
      if (fetchOk) {
        _firstPullDone = true;
        // 拉取就绪后，把排队中的推送立即补发（修复：首次拉取未完成期间家长端的写入被丢弃）
        if (_pendingPush) {
          _pendingPush = false;
          clearTimeout(_timer);
          _timer = setTimeout(function () { push(); }, 300);
        }
      }
      // 静默模式：不 reload，让调用方自行 re-render 当前页
      // 防抖：1.5 秒内只允许 reload 一次，防止多标签页/循环触发无限刷新
      if (changed && !options.silent && LS.getItem('sw_session')) {
        var now = Date.now();
        if (!_lastReloadAt || now - _lastReloadAt > 1500) {
          _lastReloadAt = now;
          try { window.location.reload(); } catch (e) {}
        }
      }
      return changed;
    });
  }

  // 推送：本地数据写入云端（仅内容变化时才写，防止无限循环推高版本号）
  // 指纹持久化到 localStorage：页面 reload 后依然能识别"内容没变"，从根源上杜绝多标签页/多设备互相推高版本导致的无限刷新
  var _pendingPush = false; // 首次拉取完成前收到的推送请求先排队，就绪后补发
  var _pushFails = 0;       // 连续失败次数（最多重试 3 次）
  function _fp(val) {
    var s = String(val == null ? '' : val);
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return s.length + ':' + h;
  }
  function _fpKey(k) { return 'sw_sync_fp_' + k; }
  function _getFp(k) { try { return LS.getItem(_fpKey(k)) || ''; } catch (e) { return ''; } }
  function _setFp(k, fp) { try { _origSet(_fpKey(k), fp); } catch (e) {} }
  // 推送：本地数据合并云端后写回（账号不丢失，跨设备收敛）。空设备推送不会删除云端已有账号。
  function push() {
    // 首次拉取未就绪 → 排队等待（修复：家长端在同步就绪前的写入不再被静默丢弃）
    if (!_firstPullDone) { _pendingPush = true; return Promise.resolve(true); }
    var tasks = SYNC_KEYS.map(function (key) {
      var local = LS.getItem(key);
      if (local == null) return Promise.resolve(true); // 本地无此 key，跳过
      var fp = _fp(local);
      // 内容与上次成功推送相同 → 不写云端（版本号不再虚高，循环就此终止）
      if (_getFp(key) === fp) return Promise.resolve(true);
      // read 云端当前值，与本地合并（账号并集）后再写回，避免本地空数据覆盖云端真实账号
      return readKey(key).then(function (item) {
        var cloud = (item && item.value != null) ? item.value : null;
        var merged = (key === 'sw_users') ? mergeUsers(local, cloud) : (key === 'sw_families') ? mergeFamilies(local, cloud) : local;
        var v = Date.now();
        return writeKey(key, merged, v).then(function (ok) {
          if (ok) { setVer(key, v); _setFp(key, _fp(merged)); }
          return ok;
        });
      });
    });
    return Promise.all(tasks).then(function (rs) {
      var ok = rs.indexOf(false) === -1;
      if (ok) { _pushFails = 0; return true; }
      // 推送失败（网络等）→ 3 秒后自动重试，最多 3 次，避免静默丢失
      _pushFails++;
      if (_pushFails <= 3) {
        clearTimeout(_timer);
        _timer = setTimeout(function () { push(); }, 3000);
      }
      return false;
    });
  }

  function schedulePush() {
    // 首次拉取未就绪时 push() 会自动排队，这里不再丢弃
    clearTimeout(_timer);
    _timer = setTimeout(function () { push(); }, 600);
  }

  // 劫持 setItem / removeItem：本地数据变更 → 自动推送（远程应用时跳过，避免回环）
  Storage.prototype.setItem = function (k, v) {
    _origSet(k, v);
    if (!_applyingRemote && SYNC_KEYS.indexOf(k) >= 0) schedulePush();
  };
  Storage.prototype.removeItem = function (k) {
    _origRemove(k);
    if (!_applyingRemote && SYNC_KEYS.indexOf(k) >= 0) schedulePush();
  };

  // ===== 对外 API（供登录页「云端同步」面板使用）=====
  window.SyncHub = {
    isReady: function () { return true; },            // 始终已连接
    getCode: function () { return 'supabase-cloud'; }, // 统一云端标识
    enable: function () { return Promise.resolve('supabase-cloud'); },
    bind: function () { return Promise.resolve(true); },
    push: push,
    pull: pull,
    getVersion: function (k) { return getVer(k || SYNC_KEYS[0]); },
    get _firstPullDone() { return _firstPullDone; }   // 供登录页检查同步状态
  };

  // 打开页面时：拉取一次最新数据（失败则 5 秒后重试，确保最终同步）
  var _initRetries = 0;
  function init() {
    pull().then(function (changed) {
      if (!_firstPullDone && _initRetries < 6) {
        _initRetries++;
        setTimeout(init, 5000); // 5 秒后重试，最多 6 次（30 秒内）
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 同浏览器多标签页：其他标签页修改 sw_* key 时（storage 事件）自动拉取最新数据。
  // 因版本号不再虚高（内容指纹持久化），拉取只会因真实数据变化而 reload 一次，不会循环。
  try {
    window.addEventListener('storage', function (e) {
      if (e && e.key && SYNC_KEYS.indexOf(e.key) >= 0 && _firstPullDone) {
        clearTimeout(_timer);
        _timer = setTimeout(function () { pull(); }, 300);
      }
    });
  } catch (e) {}
})();
