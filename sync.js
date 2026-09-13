/*
 * 学生工作台 · 云端同步模块 v5（多后端：Supabase 主 + 可配置国内备份）
 * 把 localStorage 中的「账号(sw_users) / 家庭(sw_families) / 邀请码(sw_invite_code)」
 * 同步到云端，实现跨设备同步 + 灾备。
 *
 * v5 相对 v4 的变化：
 *   1) 多后端抽象：BACKENDS 配置，supabase 为 authoritative（决定 pull 来源/版本号），
 *      其余为镜像备份（仅接收 push + 可选 restoreFromBackup 灾备恢复）。
 *   2) 灾备回退：主后端网络失败时，pull 自动尝试备份后端，应用仍可拿到同步数据。
 *   3) 国内备份后端：填入 readUrl/writeUrl/headers 即可启用（默认关闭）。
 *      推荐用「Cloudflare Worker+KV」或「腾讯云开发云函数」做中转，由它对接七牛云/CloudBase/任意存储，
 *      密钥留在服务端，客户端只调一个 JSON 接口（契约见下方 http-json 适配器）。
 *
 * 数据结构（Supabase 表 wb_state / 备份后端 KV）：
 *   key     主键，如 sw_users / sw_families / sw_invite_code
 *   value   本地数据 JSON 字符串
 *   version 修改时间戳（越大越新），用于冲突判断
 *
 * 注意：Supabase 免费项目连续 1 周无访问会自动暂停，到后台点恢复即可。
 */
(function () {
  if (window.__sw_sync_v5) return; // 防重复注入
  window.__sw_sync_v5 = true;

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
      getCode: function () { try { return (window.top && window.top.SyncHub && window.top.SyncHub.getCode()) || 'cloud'; } catch (e) { return 'cloud'; } },
      enable: function () { return Promise.resolve('cloud'); },
      bind: function () { return Promise.resolve(true); },
      push: function () {
        try { if (window.top && window.top.SyncHub) return window.top.SyncHub.push(); } catch (e) {}
        return Promise.resolve(true);
      },
      pull: function (opts) {
        try { if (window.top && window.top.SyncHub) return window.top.SyncHub.pull(opts); } catch (e) {}
        return Promise.resolve(false);
      },
      restoreFromBackup: function () {
        try { if (window.top && window.top.SyncHub) return window.top.SyncHub.restoreFromBackup(); } catch (e) {}
        return Promise.resolve(false);
      },
      getVersion: function (k) {
        try { if (window.top && window.top.SyncHub) return window.top.SyncHub.getVersion(k); } catch (e) {}
        return 0;
      }
    };
    return;
  }

  // ====================== 多后端配置 ======================
  var SYNC_KEYS = ['sw_users', 'sw_families', 'sw_invite_code'];
  var AUTH_ID = 'supabase'; // 主同步后端（决定 pull 来源与版本号）
  var BACKENDS = {
    supabase: {
      id: 'supabase', type: 'supabase', authoritative: true, enabled: true,
      url: 'https://uybqrwrxoyiivndyaugf.supabase.co/rest/v1',
      key: 'sb_publishable_vmtGZwElbLEL6UyeoWsB3Q_Rv4A0jVM',
      table: 'wb_state'
    },
    // 国内备份后端（默认关闭）。填好下方 readUrl / writeUrl / headers 后把 enabled 改为 true 即启用。
    // 契约（http-json 适配器的期望）：
    //   读：GET {readUrl 中 {key} 替换为真实 key} → 返回 JSON { value, version }
    //   写：{writeMethod 默认 PUT} {writeUrl 中 {key} 替换} body=JSON { key, value, version }
    // 推荐实现：Cloudflare Worker + KV（全球免费）或 腾讯云开发云函数（国内免费），由它再对接七牛云/CloudBase。
    backup: {
      id: 'backup', type: 'http-json', authoritative: false, enabled: false,
      readUrl: '',          // 例：'https://<你的端点>/state/{key}'
      writeUrl: '',         // 例：'https://<你的端点>/state/{key}'
      writeMethod: 'PUT',
      headers: {}           // 例：{ 'Authorization': 'Bearer <你的密钥>', 'Content-Type': 'application/json' }
    }
  };
  function getBackend(id) { return BACKENDS[id]; }
  function enabledBackups() {
    var out = [];
    for (var id in BACKENDS) { var b = BACKENDS[id]; if (b.id !== AUTH_ID && b.enabled) out.push(b); }
    return out;
  }

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

  // ====================== 底层读写（按后端类型分发） ======================
  function sbHeaders(b) {
    return {
      'apikey': b.key,
      'Authorization': 'Bearer ' + b.key,
      'Content-Type': 'application/json'
    };
  }
  // 读取单个后端：返回 { value, version, ok } 或 { __error: true }
  function readKey(b, key) {
    if (b.type === 'supabase') {
      return fetch(b.url + '/' + b.table + '?key=eq.' + encodeURIComponent(key) + '&select=value,version', { headers: sbHeaders(b) })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('read ' + r.status)); })
        .then(function (rows) {
          if (rows && rows.length) { rows[0].ok = true; return rows[0]; }
          return { ok: true }; // 云端无此 key，但请求成功
        })
        .catch(function () { return { __error: true }; });
    }
    if (b.type === 'http-json') {
      if (!b.readUrl) return Promise.resolve({ __error: true });
      var u = b.readUrl.replace('{key}', encodeURIComponent(key));
      var h = {}; for (var k in (b.headers || {})) h[k] = b.headers[k];
      return fetch(u, { headers: h })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('read ' + r.status)); })
        .then(function (j) { return { value: j && j.value, version: j && j.version, ok: true }; })
        .catch(function () { return { __error: true }; });
    }
    return Promise.resolve({ __error: true });
  }

  // 写入单个后端（upsert）
  function writeKey(b, key, value, version) {
    if (b.type === 'supabase') {
      return fetch(b.url + '/' + b.table + '?on_conflict=key', {
        method: 'POST',
        headers: {
          'apikey': b.key,
          'Authorization': 'Bearer ' + b.key,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify([{ key: key, value: String(value), version: version }])
      }).then(function (r) { return r.ok; }).catch(function () { return false; });
    }
    if (b.type === 'http-json') {
      if (!b.writeUrl) return Promise.resolve(false);
      var u = b.writeUrl.replace('{key}', encodeURIComponent(key));
      var h = { 'Content-Type': 'application/json' }; for (var k in (b.headers || {})) h[k] = b.headers[k];
      return fetch(u, {
        method: b.writeMethod || 'PUT',
        headers: h,
        body: JSON.stringify({ key: key, value: String(value), version: version })
      }).then(function (r) { return r.ok; }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  // 从「主后端 + 已启用备份」中读取某 key：主后端优先；主后端出错时回退到备份（灾备）
  function readFromAny(key) {
    var order = [getBackend(AUTH_ID)].concat(enabledBackups());
    var tries = order.map(function (b) { return readKey(b, key); });
    return Promise.all(tries).then(function (res) {
      for (var i = 0; i < res.length; i++) {
        if (res[i] && !res[i].__error && res[i].value != null) return res[i]; // 优先返回有数据的结果
      }
      for (var j = 0; j < res.length; j++) {
        if (res[j] && !res[j].__error) return res[j]; // 都无数据但请求成功（全新部署）
      }
      return { __error: true }; // 全部失败
    });
  }

  // ====================== 合并逻辑（与 v4 完全一致，防数据丢失） ======================
  // 账号级合并：云端账号 ∪ 本地账号（字段级递归合并，不丢数据）
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
    if (_isEmpty(l)) return c;
    if (_isEmpty(c)) return l;
    return l;
  }
  // 家庭级合并：本地家庭 ∪ 云端家庭（家庭以名称为键，双方取并集，同名以本地为准）
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
  function mergeKey(key, local, cloud) {
    if (key === 'sw_users') return mergeUsers(local, cloud);
    if (key === 'sw_families') return mergeFamilies(local, cloud);
    return (local != null) ? local : cloud;
  }

  // ====================== 拉取 ======================
  function pull(options) {
    options = options || {};
    if (_pulling) return Promise.resolve(false);
    _pulling = true;
    var changed = false;
    var fetchOk = false; // 至少一次请求成功（区分"云端无数据"和"网络失败"）
    var tasks = SYNC_KEYS.map(function (key) {
      return readFromAny(key).then(function (item) {
        if (!item || item.__error) return;
        fetchOk = true; // 请求成功（无论云端是否有数据，全新部署也算成功）
        if (item.value == null) return; // 无此 key
        var local = LS.getItem(key);
        var merged = mergeKey(key, local, item.value);
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
      if (fetchOk) {
        _firstPullDone = true;
        if (_pendingPush) {
          _pendingPush = false;
          clearTimeout(_timer);
          _timer = setTimeout(function () { push(); }, 300);
        }
      }
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

  // ====================== 推送 ======================
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

  // 推送：先把本地合并主后端（账号不丢失），再把合并结果镜像到所有已启用备份（灾备）
  function push() {
    if (!_firstPullDone) { _pendingPush = true; return Promise.resolve(true); }
    var authB = getBackend(AUTH_ID);
    var backups = enabledBackups();
    var tasks = SYNC_KEYS.map(function (key) {
      var local = LS.getItem(key);
      if (local == null) return Promise.resolve(true);
      var fp = _fp(local);
      if (_getFp(key) === fp) return Promise.resolve(true); // 内容未变，跳过（防版本号虚高/无限刷新）
      return readKey(authB, key).then(function (item) {
        var cloud = (item && item.value != null) ? item.value : null;
        var merged = mergeKey(key, local, cloud);
        var v = Date.now();
        return writeKey(authB, key, merged, v).then(function (ok) {
          if (ok) { setVer(key, v); _setFp(key, _fp(merged)); }
          // 镜像到备份后端（best-effort，失败不影响主同步）
          if (backups.length) {
            backups.forEach(function (b) {
              writeKey(b, key, merged, v).then(function () {}).catch(function () {});
            });
          }
          return ok;
        });
      });
    });
    return Promise.all(tasks).then(function (rs) {
      var ok = rs.indexOf(false) === -1;
      if (ok) { _pushFails = 0; return true; }
      _pushFails++;
      if (_pushFails <= 3) {
        clearTimeout(_timer);
        _timer = setTimeout(function () { push(); }, 3000);
      }
      return false;
    });
  }

  // 灾备恢复：从备份后端把数据合并回本地（当主后端不可用 / 数据丢失时使用）
  function restoreFromBackup() {
    var backups = enabledBackups();
    if (!backups.length) return Promise.resolve(false);
    var changed = false;
    var tasks = SYNC_KEYS.map(function (key) {
      return readKey(backups[0], key).then(function (item) {
        if (!item || item.__error || item.value == null) return;
        var local = LS.getItem(key);
        var merged = mergeKey(key, local, item.value);
        if (merged !== local) {
          _applyingRemote = true;
          _origSet(key, merged);
          _applyingRemote = false;
          changed = true;
        }
        _setFp(key, _fp(merged));
      });
    });
    return Promise.all(tasks).then(function () {
      if (changed) push(); // 恢复后回写主后端
      return changed;
    });
  }

  function schedulePush() {
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

  // ===== 对外 API =====
  window.SyncHub = {
    isReady: function () { return true; },
    getCode: function () {
      var s = getBackend(AUTH_ID);
      var c = (s && s.type === 'supabase') ? 'supabase-cloud' : 'cloud';
      var bk = enabledBackups().length;
      return bk ? (c + '+backup(' + bk + ')') : c;
    },
    enable: function () { return Promise.resolve('cloud'); },
    bind: function () { return Promise.resolve(true); },
    push: push,
    pull: pull,
    restoreFromBackup: restoreFromBackup,
    backends: BACKENDS,
    getVersion: function (k) { return getVer(k || SYNC_KEYS[0]); },
    get _firstPullDone() { return _firstPullDone; }
  };

  // 打开页面时：拉取一次最新数据（失败则 5 秒后重试，确保最终同步）
  var _initRetries = 0;
  function init() {
    pull().then(function (changed) {
      if (!_firstPullDone && _initRetries < 6) {
        _initRetries++;
        setTimeout(init, 5000);
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 同浏览器多标签页：其他标签页修改 sw_* key 时（storage 事件）自动拉取最新数据。
  try {
    window.addEventListener('storage', function (e) {
      if (e && e.key && SYNC_KEYS.indexOf(e.key) >= 0 && _firstPullDone) {
        clearTimeout(_timer);
        _timer = setTimeout(function () { pull(); }, 300);
      }
    });
  } catch (e) {}
})();
