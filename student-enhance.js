/* ============================================================
 * student-enhance.js — 学生端「家长同步」增强
 * 依赖 learning.html 内联脚本已定义的全局：
 *   session / todayLabel / showToast / PAGE_RENDERERS
 * 数据统一存放在 sw_users[username].data.* 与 .parentHomework，
 * 由 sync.js 自动跨设备同步（同浏览器即时同步）。
 * ============================================================ */
(function () {
  if (typeof window.PAGE_RENDERERS === 'undefined') return;

  var SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治'];
  var PUBLISHERS = [
    '人民教育出版社（人教版）',
    '北京师范大学出版社（北师大版）',
    '江苏教育出版社（苏教版）',
    '华东师范大学出版社（华东师大版）',
    '浙江教育出版社（浙教版）',
    '外语教学与研究出版社（外研社）',
    '语文出版社（语文版）',
    '其他'
  ];

  function uDB() { try { return JSON.parse(localStorage.getItem('sw_users')) || {}; } catch (e) { return {}; } }
  function sDB(db) { localStorage.setItem('sw_users', JSON.stringify(db)); } // 触发 sync.js 推送
  function me() { return (typeof session !== 'undefined' && session && session.username) ? session.username : null; }
  function myUser() { var db = uDB(); return db[me()] || null; }
  function myData() { var u = myUser(); if (!u) return null; if (!u.data) u.data = {}; return u.data; }
  function saveMyData(d) { var db = uDB(); var u = db[me()]; if (!u) return; u.data = d; sDB(db); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- 家长成绩（只读，自动同步）---------- */
  function renderScoresSyncPage(el) {
    if (!me()) { el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text2)">未登录，请重新登录</div>'; return; }
    var data = myData() || {};
    var scores = (data.scores && data.scores.length) ? data.scores.slice() : [];
    scores.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

    var h = '';
    h += '<div class="page-hero" style="background:linear-gradient(135deg,var(--pri2),var(--pur2))"><div class="hero-info"><div class="hero-badge"><span>📈</span><span>家长成绩</span></div><div class="hero-title">家长录入的考试成绩</div><div class="hero-tagline">由家长端录入 · 实时自动同步</div></div><div class="hero-emoji">📊</div><div class="hero-date">📅 ' + (typeof todayLabel === 'function' ? todayLabel() : '') + '</div></div>';

    if (scores.length === 0) {
      h += '<div class="section"><div style="text-align:center;padding:34px;color:var(--text3)">家长还没有录入考试成绩 📝<br>家长可在「家长端 → 学习成绩」中录入，这里会自动出现。</div></div>';
    } else {
      var bySub = {};
      for (var i = 0; i < scores.length; i++) { (bySub[scores[i].subject] = bySub[scores[i].subject] || []).push(scores[i]); }
      for (var s in bySub) {
        h += '<div class="section"><div class="section-title">' + esc(s) + ' <span class="section-right">' + bySub[s].length + ' 次</span></div>';
        h += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">';
        h += '<thead><tr style="color:var(--text2);text-align:left"><th style="padding:8px 6px">考试</th><th style="padding:8px 6px">得分</th><th style="padding:8px 6px">满分</th><th style="padding:8px 6px">日期</th></tr></thead><tbody>';
        for (var j = 0; j < bySub[s].length; j++) {
          var sc = bySub[s][j];
          h += '<tr style="border-top:1px solid var(--border)"><td style="padding:8px 6px">' + esc(sc.examName) + '</td><td style="padding:8px 6px;font-weight:700;color:var(--pri)">' + esc(sc.score) + '</td><td style="padding:8px 6px">' + esc(sc.totalScore) + '</td><td style="padding:8px 6px;color:var(--text2)">' + esc(sc.date) + '</td></tr>';
        }
        h += '</tbody></table></div></div>';
      }
    }
    el.innerHTML = h;
  }

  /* ---------- 教材与进度（只读，自动同步）---------- */
  function renderProgressSyncPage(el) {
    if (!me()) { el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text2)">未登录，请重新登录</div>'; return; }
    var data = myData() || {};
    var prog = data.progress || {};
    var pub = data.publisher || {};

    var h = '';
    h += '<div class="page-hero" style="background:linear-gradient(135deg,var(--grn2),var(--pri2))"><div class="hero-info"><div class="hero-badge"><span>📚</span><span>教材与进度</span></div><div class="hero-title">教材版本与学习进度</div><div class="hero-tagline">由家长端与学校对齐 · 自动同步</div></div><div class="hero-emoji">🎯</div><div class="hero-date">📅 ' + (typeof todayLabel === 'function' ? todayLabel() : '') + '</div></div>';

    h += '<div class="section"><div class="section-title">📕 教材出版社（按学科）</div>';
    for (var i = 0; i < SUBJECTS.length; i++) {
      var sj = SUBJECTS[i];
      var p = pub[sj] || '未设置';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);font-size:14px"><span>' + sj + '</span><span style="color:var(--text2)">' + esc(p) + '</span></div>';
    }
    h += '</div>';

    h += '<div class="section"><div class="section-title">📈 各学科学习进度</div>';
    for (var k = 0; k < SUBJECTS.length; k++) {
      var sj2 = SUBJECTS[k];
      var pr = prog[sj2] || { percent: 0, note: '' };
      var pc = pr.percent || 0;
      h += '<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>' + sj2 + '</span><span style="color:var(--text2)">' + pc + '%</span></div><div style="height:8px;background:var(--bg2);border-radius:6px;overflow:hidden"><div style="height:100%;width:' + pc + '%;background:linear-gradient(90deg,var(--pri),var(--grn))"></div></div>';
      if (pr.note) h += '<div style="font-size:12px;color:var(--text3);margin-top:4px">📌 ' + esc(pr.note) + '</div>';
      h += '</div>';
    }
    h += '</div>';
    el.innerHTML = h;
  }

  /* ---------- 家长布置的作业：注入到「作业管理」页 ---------- */
  var _origHomework = PAGE_RENDERERS.homework;
  PAGE_RENDERERS.homework = function (el) {
    _origHomework(el);
    if (!me()) return;
    var u = myUser();
    var phw = (u && u.parentHomework) || [];
    var box = document.createElement('div');
    box.className = 'section';
    var hh = '<div class="section-title">👨‍👩‍👧 家长布置的作业 <span class="section-right">' + phw.length + ' 项</span></div>';
    if (phw.length === 0) {
      hh += '<div style="text-align:center;padding:18px;color:var(--text3);font-size:13px">家长还没有布置作业哦～</div>';
    } else {
      for (var i = 0; i < phw.length; i++) {
        var hw = phw[i];
        var hid = hw.id || ('phw_' + i);
        hh += '<div class="checklist-item' + (hw.done ? ' done' : '') + '" onclick="window.__toggleParentHw(\'' + hid + '\')">';
        hh += '<div class="check-dot' + (hw.done ? ' done' : '') + '" id="phwdot_' + hid + '"></div>';
        hh += '<div style="flex:1"><div style="font-weight:500">' + esc(hw.subject) + ' · 作业</div><div style="font-size:12px;color:var(--text2)">' + esc(hw.content) + '</div></div>';
        hh += '<span style="font-size:12px;color:var(--org);white-space:nowrap">⭐' + (hw.points || 0) + '分</span>';
        hh += '</div>';
      }
    }
    box.innerHTML = hh;
    el.appendChild(box);
  };

  window.__toggleParentHw = function (id) {
    var db = uDB();
    var u = db[me()];
    if (!u || !u.parentHomework) return;
    for (var i = 0; i < u.parentHomework.length; i++) {
      var it = u.parentHomework[i];
      var hid = it.id || ('phw_' + i);
      if (hid === id) { it.done = !it.done; break; }
    }
    sDB(db); // 触发 sync.js 推送，家长端同步状态
    var pe = document.getElementById('page-homework');
    if (pe) PAGE_RENDERERS.homework(pe);
    if (typeof showToast === 'function') showToast('已更新作业状态 ✓');
  };

  /* ---------- 教材与进度（可编辑，四级联动选择器，由 learning.html 内联版提供）---------- */
  // 不再覆盖 PAGE_RENDERERS.progressSync，让 learning.html 内联的 renderStudentProgress 生效
  // （学习端可独立选教材版本/学期/单元/课并保存，与家长端共享 sw_users.data.progress）
  // 这里只在没有内联版本时提供一个最简只读后备
  if (typeof window.renderStudentProgress !== 'function') {
    PAGE_RENDERERS.progressSync = renderProgressSyncPage;
  }

  /* ---------- 跨标签页实时刷新（家长端改了，学生端打开的页立即更新）---------- */
  window.addEventListener('storage', function (e) {
    if (e.key === 'sw_users' && me()) {
      var cur = document.querySelector('.page.active');
      if (cur && (cur.id === 'page-scoresSync' || cur.id === 'page-progressSync' || cur.id === 'page-homework')) {
        var r = PAGE_RENDERERS[cur.id.replace('page-', '')];
        if (r) r(cur);
      }
    }
  });
})();
