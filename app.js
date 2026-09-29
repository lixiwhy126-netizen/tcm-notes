/* 中医跟诊病例记录 —— 纯前端，数据保存在浏览器 localStorage */
(function () {
  'use strict';

  var LS_PATIENTS = 'tcm_patients_v2';
  var LS_PATIENTS_OLD = 'tcm_patients_v1';
  var LS_KB_CUSTOM = 'tcm_kb_custom_v1';

  // 内置知识库（来自 kb/*.js，加载失败时降级为空数组）
  var HERBS = typeof KB_HERBS !== 'undefined' ? KB_HERBS : [];
  var FORMULAS = typeof KB_FORMULAS !== 'undefined' ? KB_FORMULAS : [];
  var DISEASES = typeof KB_DISEASES !== 'undefined' ? KB_DISEASES : [];
  var SIGNS = typeof KB_SIGNS !== 'undefined' ? KB_SIGNS : [];
  var WESTERN = typeof KB_WESTERN !== 'undefined' ? KB_WESTERN : [];
  var LABS = typeof KB_LABS !== 'undefined' ? KB_LABS : [];
  var PAIRS = typeof KB_PAIRS !== 'undefined' ? KB_PAIRS : [];

  // ---------- 数据存取 ----------
  function loadJSON(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v === null || v === undefined ? fallback : v;
    } catch (e) { return fallback; }
  }

  var patients = loadJSON(LS_PATIENTS, null);
  if (patients === null) patients = loadJSON(LS_PATIENTS_OLD, []);
  var customKB = loadJSON(LS_KB_CUSTOM, { herbs: [], formulas: [], diseases: [], signs: [] });
  customKB.herbs = customKB.herbs || [];
  customKB.formulas = customKB.formulas || [];
  customKB.diseases = customKB.diseases || [];
  customKB.signs = customKB.signs || [];

  function persist() { localStorage.setItem(LS_PATIENTS, JSON.stringify(patients)); }
  function persistKB() { localStorage.setItem(LS_KB_CUSTOM, JSON.stringify(customKB)); }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function findPatient(id) {
    for (var i = 0; i < patients.length; i++) if (patients[i].id === id) return patients[i];
    return null;
  }
  function findVisit(patient, vid) {
    for (var i = 0; i < patient.visits.length; i++) if (patient.visits[i].id === vid) return patient.visits[i];
    return null;
  }
  function newVisit() {
    var t = new Date();
    return {
      id: uid(), updatedAt: Date.now(),
      visitDate: t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2),
      condition: '',
      tcmDiagnosis: '', syndrome: '', westernDiagnosis: '',
      treatment: '',
      herbs: [],
      prescriptionNote: '',
      notes: ''
    };
  }
  function sortedVisits(p) {
    return p.visits.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  // 旧版就诊记录字段迁移（v1 → v2）
  function migrateVisit(v) {
    if (v.condition !== undefined) return v;
    var parts = [];
    [['主诉', v.chiefComplaint], ['现病史', v.presentIllness], ['既往史', v.pastHistory],
     ['过敏史', v.allergyHistory], ['望诊', v.inspection], ['闻诊', v.auscultation],
     ['问诊', v.inquiry], ['舌象', v.tongue], ['脉象', v.pulse]].forEach(function (pair) {
      if (pair[1]) parts.push(pair[0] + '：' + pair[1]);
    });
    v.condition = parts.join('\n');
    var notes = [];
    [['针灸及其他疗法', v.acupuncture], ['医嘱', v.advice], ['跟诊体会', v.reflection]].forEach(function (pair) {
      if (pair[1]) notes.push(pair[0] + '：' + pair[1]);
    });
    v.notes = notes.join('\n');
    v.treatment = v.treatmentPrinciple || '';
    v.prescriptionNote = v.prescription || '';
    v.herbs = [];
    return v;
  }
  patients.forEach(function (p) { p.visits = (p.visits || []).map(migrateVisit); });

  // ---------- 词条索引（用于悬浮弹窗） ----------
  var TERM_INDEX = null;
  function addTerm(term, entry) {
    if (!term) return;
    if (!TERM_INDEX[term] || (TERM_INDEX[term].type === 'alias' && entry.type !== 'alias')) {
      TERM_INDEX[term] = entry;
    }
  }
  function buildTermIndex() {
    if (TERM_INDEX) return TERM_INDEX;
    TERM_INDEX = {};
    DISEASES.forEach(function (d) {
      addTerm(d.name, { type: 'disease', data: d });
      (d.alias || '').split(/[、,，]/).forEach(function (a) {
        a = a.trim();
        if (a) addTerm(a, { type: 'alias', data: d });
      });
      (d.syndromes || []).forEach(function (s) {
        addTerm(s.name, { type: 'syndrome', data: s, parent: d });
        addTerm(s.name.replace(/证$/, ''), { type: 'syndrome', data: s, parent: d });
      });
    });
    SIGNS.forEach(function (s) { addTerm(s.term, { type: 'sign', data: s }); });
    FORMULAS.forEach(function (f) { addTerm(f.name, { type: 'formula', data: f }); });
    WESTERN.forEach(function (w) { addTerm(w.name, { type: 'western', data: w }); });
    LABS.forEach(function (l) {
      addTerm(l.term, { type: 'lab', data: l });
      (l.alias || '').split(/[、,，]/).forEach(function (a) {
        a = a.trim();
        if (a && a.length >= 2) addTerm(a, { type: 'lab', data: l });
      });
    });
    // 自定义知识也参与识别
    customKB.diseases.forEach(function (d) { addTerm(d.name, { type: 'disease', data: d }); });
    customKB.signs.forEach(function (s) { addTerm(s.term, { type: 'sign', data: s }); });
    customKB.formulas.forEach(function (f) { addTerm(f.name, { type: 'formula', data: f }); });
    return TERM_INDEX;
  }

  // 在文本中识别词条（长词条优先，去掉被更长词条包含的）
  var PULSE_CHARS = '浮沉迟数弦细滑涩弱濡紧缓洪结代虚实芤革伏牢疾动微大长短';
  var COAT_CHARS = '薄白黄腻厚燥滑腐剥灰黑润少无积微黏';
  function isSubseq(sub, str) {
    var i = 0;
    for (var j = 0; j < str.length && i < sub.length; j++) if (str[j] === sub[i]) i++;
    return i === sub.length;
  }
  function detectTerms(text) {
    if (!text) return [];
    var idx = buildTermIndex();
    var found = [];
    var term, i;
    // 1. 直接包含
    for (term in idx) {
      if (term.length >= 2 && text.indexOf(term) >= 0) found.push(term);
    }
    // 2. 两字病名宽松匹配：如「头颠顶部疼痛」→ 头痛（首尾字之间允许插入 0-4 个非标点字）
    for (term in idx) {
      if (term.length === 2 && (idx[term].type === 'disease' || idx[term].type === 'alias') && found.indexOf(term) < 0) {
        var re = new RegExp(term.charAt(0) + '[^，。；、！？!?,;\\s]{0,4}' + term.charAt(1));
        if (re.test(text)) found.push(term);
      }
    }
    // 3. 脉象聚合拆分：「脉弦滑细数」→ 脉弦、脉细、脉滑、脉数；整体是已知相兼脉则用整体
    var pm = text.match(new RegExp('脉[' + PULSE_CHARS + ']{1,6}', 'g'));
    if (pm) {
      pm.forEach(function (seg) {
        if (idx[seg]) {
          if (found.indexOf(seg) < 0) found.push(seg);
          return;
        }
        // 聚合整体不是词条：先剔除落在聚合内的部分脉词条（来自直接包含匹配），再逐字拆分
        found = found.filter(function (t) {
          return !(t.charAt(0) === '脉' && seg.indexOf(t) >= 0);
        });
        var body = seg.slice(1);
        for (i = 0; i < body.length; i++) {
          var one = '脉' + body[i];
          if (idx[one] && found.indexOf(one) < 0) found.push(one);
        }
      });
    }
    // 4. 舌苔复合描述拆分：「苔薄白微腻」→ 苔薄白、苔白腻（子序列匹配已知苔类词条）
    var cm = text.match(new RegExp('苔[' + COAT_CHARS + ']{1,6}', 'g'));
    if (cm) {
      cm.forEach(function (seg) {
        if (idx[seg]) {
          if (found.indexOf(seg) < 0) found.push(seg);
          return;
        }
        var body = seg.slice(1);
        if (body.length < 2) return;
        SIGNS.forEach(function (s) {
          if (s.term.charAt(0) === '苔' && s.term.length >= 3 && s.term !== seg &&
              isSubseq(s.term.slice(1), body) && found.indexOf(s.term) < 0) {
            found.push(s.term);
          }
        });
      });
    }
    // 去掉被更长词条包含的短词条
    found = found.filter(function (t) {
      return !found.some(function (o) { return o !== t && o.indexOf(t) >= 0; });
    });
    return found;
  }

  // ---------- 悬浮弹窗 ----------
  var popEl = null;
  var popHideTimer = null;

  function popContent(type, data, parent) {
    var h = '';
    if (type === 'disease' || type === 'alias') {
      h += '<div class="kp-title">' + esc(data.name) + '</div>';
      if (data.alias) h += '<div class="kp-meta">中医病名/相关：' + esc(data.alias) + '</div>';
      (data.syndromes || []).forEach(function (s) {
        h += '<div class="kp-syn"><b>' + esc(s.name) + '</b>　' + esc(s.symptoms || '') +
          '<div class="kp-meta">舌脉：' + esc([s.tongue, s.pulse].filter(Boolean).join('，')) +
          '　治法：' + esc(s.treatment || '') + '　方：' + esc(s.formulas || '') + '</div></div>';
      });
      if (data.note) h += '<div class="kp-row">' + esc(data.note).replace(/\n/g, '<br>') + '</div>';
    } else if (type === 'syndrome') {
      h += '<div class="kp-title">' + esc(data.name) + (parent ? '<span class="kp-meta">　所属：' + esc(parent.name) + '</span>' : '') + '</div>';
      if (data.symptoms) h += '<div class="kp-row"><b>症状</b>　' + esc(data.symptoms) + '</div>';
      if (data.tongue) h += '<div class="kp-row"><b>舌象</b>　' + esc(data.tongue) + '</div>';
      if (data.pulse) h += '<div class="kp-row"><b>脉象</b>　' + esc(data.pulse) + '</div>';
      if (data.treatment) h += '<div class="kp-row"><b>治法</b>　' + esc(data.treatment) + '</div>';
      if (data.formulas) h += '<div class="kp-row"><b>代表方</b>　' + esc(data.formulas) + '</div>';
    } else if (type === 'sign') {
      h += '<div class="kp-title">' + esc(data.term) + '<span class="kp-meta">　' + esc(data.category || '') + '</span></div>';
      if (data.indicates) h += '<div class="kp-row"><b>指向</b>　' + esc(data.indicates) + '</div>';
      if (data.related) h += '<div class="kp-row"><b>说明</b>　' + esc(data.related) + '</div>';
      if (data.formulas) h += '<div class="kp-row"><b>常考虑方</b>　' + esc(data.formulas) + '</div>';
    } else if (type === 'formula') {
      h += '<div class="kp-title">' + esc(data.name) + '</div>';
      if (data.composition) h += '<div class="kp-row"><b>组成</b>　' + esc(data.composition) + '</div>';
      if (data.effect) h += '<div class="kp-row"><b>功用</b>　' + esc(data.effect) + '</div>';
      if (data.indications) h += '<div class="kp-row"><b>主治</b>　' + esc(data.indications) + '</div>';
    } else if (type === 'western') {
      h += '<div class="kp-title">' + esc(data.name) + '<span class="kp-meta">　西医疾病</span></div>';
      if (data.brief) h += '<div class="kp-row">' + esc(data.brief) + '</div>';
    } else if (type === 'lab') {
      h += '<div class="kp-title">' + esc(data.term) + '<span class="kp-meta">　' + esc(data.category || '') + '</span></div>';
      if (data.normal) h += '<div class="kp-row"><b>正常范围</b>　' + esc(data.normal) + '</div>';
      if (data.meaning) h += '<div class="kp-row"><b>临床意义</b>　' + esc(data.meaning) + '</div>';
    } else if (type === 'pair') {
      h += '<div class="kp-title">' + esc(data.a) + ' — ' + esc(data.b) + '<span class="kp-meta">　对药</span></div>';
      if (data.effect) h += '<div class="kp-row"><b>方解</b>　' + esc(data.effect) + '</div>';
      if (data.source) h += '<div class="kp-row"><b>出处</b>　' + esc(data.source) + '</div>';
    }
    return h;
  }

  function showPopRaw(anchorEl, innerHTML) {
    hidePop();
    popEl = document.createElement('div');
    popEl.className = 'kb-popover';
    popEl.innerHTML = innerHTML;
    document.body.appendChild(popEl);
    var r = anchorEl.getBoundingClientRect();
    var top = r.bottom + window.scrollY + 6;
    var left = Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - 340));
    popEl.style.top = top + 'px';
    popEl.style.left = left + 'px';
    popEl.addEventListener('mouseenter', function () { clearTimeout(popHideTimer); });
    popEl.addEventListener('mouseleave', scheduleHidePop);
  }
  function showPop(anchorEl, term) {
    var entry = buildTermIndex()[term];
    if (!entry) return;
    showPopRaw(anchorEl, '<div class="kp-term">' + esc(term) + '</div>' +
      popContent(entry.type, entry.data, entry.parent));
  }
  // 单味药悬浮说明
  function showHerbPop(anchorEl, name) {
    var h = findHerb(name);
    if (!h) {
      showPopRaw(anchorEl, '<div class="kp-title">' + esc(name) + '</div>' +
        '<div class="kp-row">知识库暂无该药，可在「知识库 → 添加我的知识」中录入。</div>');
      return;
    }
    showPopRaw(anchorEl,
      '<div class="kp-title">' + esc(h.name) +
      (h.dosage ? ' <span class="kp-meta">常用 ' + esc(h.dosage) + '</span>' : '') + '</div>' +
      (h.nature ? '<div class="kp-row"><b>性味归经</b>　' + esc(h.nature) + '</div>' : '') +
      (h.effect ? '<div class="kp-row"><b>功效</b>　' + esc(h.effect) + '</div>' : '') +
      (h.classic ? '<div class="kp-row"><b>经典</b>　' + esc(h.classic) + '</div>' : ''));
  }
  // 治法 → 对应证型 反查
  var TREAT_INDEX = null;
  function buildTreatIndex() {
    if (TREAT_INDEX) return TREAT_INDEX;
    TREAT_INDEX = {};
    DISEASES.concat(customKB.diseases).forEach(function (d) {
      (d.syndromes || []).forEach(function (s) {
        if (!s.treatment) return;
        (TREAT_INDEX[s.treatment] = TREAT_INDEX[s.treatment] || []).push({ syn: s, disease: d });
      });
    });
    return TREAT_INDEX;
  }
  function showTreatPop(anchorEl, treatment) {
    var list = buildTreatIndex()[treatment] || [];
    if (!list.length) return;
    var h = '<div class="kp-title">' + esc(treatment) + '</div>' +
      '<div class="kp-meta">该治法对应的常见证型：</div>';
    list.slice(0, 4).forEach(function (it) {
      h += '<div class="kp-syn"><b>' + esc(it.syn.name) + '</b>（' + esc(it.disease.name) + '）<br>' +
        esc(it.syn.symptoms || '') +
        '<div class="kp-meta">舌脉：' + esc([it.syn.tongue, it.syn.pulse].filter(Boolean).join('，')) +
        '　方：' + esc(it.syn.formulas || '') + '</div></div>';
    });
    showPopRaw(anchorEl, h);
  }
  function scheduleHidePop() {
    clearTimeout(popHideTimer);
    popHideTimer = setTimeout(hidePop, 250);
  }
  function hidePop() {
    clearTimeout(popHideTimer);
    if (popEl) { popEl.remove(); popEl = null; }
  }
  document.addEventListener('click', function (e) {
    if (!popEl || popEl.contains(e.target)) return;
    var t = e.target;
    if (t.classList && (t.classList.contains('term-chip') || t.classList.contains('rec-chip') || t.classList.contains('hc-name') || t.classList.contains('hc-usage') || t.classList.contains('pair-chip') || t.classList.contains('usage-opt'))) return;
    hidePop();
  });

  // ---------- 页面骨架 ----------
  var app = document.getElementById('app');
  var headerTitle = document.getElementById('headerTitle');
  var saveStatus = document.getElementById('saveStatus');
  var backBtn = document.getElementById('backBtn');
  var navHome = document.getElementById('navHome');
  var navKB = document.getElementById('navKB');

  function setHeader(title, showBack, backTarget) {
    headerTitle.textContent = title;
    backBtn.classList.toggle('hidden', !showBack);
    backBtn.onclick = showBack ? function () { location.hash = backTarget; } : null;
    navHome.classList.toggle('active', (location.hash || '#/').indexOf('#/kb') !== 0);
    navKB.classList.toggle('active', (location.hash || '').indexOf('#/kb') === 0);
  }
  function setStatus(s) { saveStatus.textContent = s; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function now() {
    var t = new Date();
    return pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
  }

  navHome.onclick = function () { location.hash = '#/'; };
  navKB.onclick = function () { location.hash = '#/kb'; };

  // ---------- 视图：患者列表 ----------
  function renderPatientList() {
    setHeader('跟诊病例', false);
    setStatus('');
    app.innerHTML =
      '<div class="container">' +
      '  <div class="card">' +
      '    <h2>开始记录</h2>' +
      '    <div class="field"><label>患者姓名（输入后自动匹配已有患者）</label>' +
      '      <input id="quickName" placeholder="如：张三" autocomplete="off"></div>' +
      '    <div id="nameMatch"></div>' +
      '  </div>' +
      '  <div class="toolbar">' +
      '    <input type="search" id="patientSearch" placeholder="搜索患者姓名 / 诊断 / 证型">' +
      '  </div>' +
      '  <div id="patientList"></div>' +
      '  <div class="card">' +
      '    <h2>数据备份与迁移</h2>' +
      '    <p class="hint">数据保存在本浏览器中。换设备或换浏览器前，请先「导出数据」，在新设备上「导入数据」。建议定期导出备份。</p>' +
      '    <div class="data-row mt16">' +
      '      <button class="secondary" id="exportBtn">导出数据</button>' +
      '      <button class="secondary" id="importBtn">导入数据</button>' +
      '      <input type="file" id="importFile" accept=".json,application/json" class="hidden">' +
      '    </div>' +
      '  </div>' +
      '</div>';

    var quickName = document.getElementById('quickName');
    var nameMatch = document.getElementById('nameMatch');
    var patientSearch = document.getElementById('patientSearch');

    function renderNameMatch() {
      var q = quickName.value.trim();
      if (!q) { nameMatch.innerHTML = ''; return; }
      var matched = patients.filter(function (p) { return p.name.indexOf(q) >= 0; });
      var h = '';
      matched.forEach(function (p) {
        var last = sortedVisits(p)[0];
        var sub = '已有 ' + p.visits.length + ' 次就诊';
        if (last) sub += ' · 最近 ' + (last.visitDate || '—') + (last.tcmDiagnosis ? ' · ' + last.tcmDiagnosis : '');
        if (p.note) sub += ' · ' + p.note;
        h += '<div class="match-item" data-pid="' + p.id + '">' + esc(p.name) +
          '<div class="sub">' + esc(sub) + ' → 点这里为其新建就诊（自动关联历史病例）</div></div>';
      });
      h += '<div class="match-item new" data-new="1">＋ 新建患者「' + esc(q) + '」（与上述均非同一人）</div>';
      nameMatch.innerHTML = '<div class="match-box">' + h + '</div>';

      Array.prototype.forEach.call(nameMatch.querySelectorAll('.match-item'), function (el) {
        el.onclick = function () {
          if (el.dataset.new) {
            var p = { id: uid(), name: q, gender: '', age: '', note: '', visits: [] };
            patients.push(p);
            persist();
            createVisitAndGo(p);
          } else {
            createVisitAndGo(findPatient(el.dataset.pid));
          }
        };
      });
    }
    quickName.addEventListener('input', renderNameMatch);

    function renderList() {
      var q = patientSearch.value.trim().toLowerCase();
      var list = patients.filter(function (p) {
        if (!q) return true;
        if (p.name.toLowerCase().indexOf(q) >= 0) return true;
        return p.visits.some(function (v) {
          return (v.tcmDiagnosis + ' ' + v.syndrome + ' ' + v.westernDiagnosis).toLowerCase().indexOf(q) >= 0;
        });
      });
      list.sort(function (a, b) {
        var la = sortedVisits(a)[0], lb = sortedVisits(b)[0];
        return (lb ? lb.updatedAt : 0) - (la ? la.updatedAt : 0);
      });
      if (!list.length) {
        document.getElementById('patientList').innerHTML =
          '<div class="empty">暂无病例<br>在上方输入患者姓名即可开始第一次记录</div>';
        return;
      }
      var h = '';
      list.forEach(function (p) {
        var visits = sortedVisits(p);
        var last = visits[0];
        var sub = [];
        if (last && last.tcmDiagnosis) sub.push(last.tcmDiagnosis);
        if (last && last.syndrome) sub.push(last.syndrome);
        h += '<div class="list-item" data-pid="' + p.id + '">' +
          '<div class="row1"><span class="name">' + esc(p.name) +
          (p.gender ? ' <span class="hint">' + esc(p.gender) + (p.age ? ' · ' + esc(p.age) + '岁' : '') + '</span>' : '') +
          '</span><span class="date">' + p.visits.length + ' 次就诊</span></div>' +
          '<div class="sub">' + esc(sub.join(' · ') || '—') + '</div></div>';
      });
      document.getElementById('patientList').innerHTML = h;
      Array.prototype.forEach.call(document.querySelectorAll('#patientList .list-item'), function (el) {
        el.onclick = function () { location.hash = '#/patient/' + el.dataset.pid; };
      });
    }
    patientSearch.addEventListener('input', renderList);
    renderList();

    document.getElementById('exportBtn').onclick = exportData;
    document.getElementById('importBtn').onclick = function () {
      document.getElementById('importFile').click();
    };
    document.getElementById('importFile').onchange = importData;
  }

  function createVisitAndGo(p) {
    if (!p) return;
    var v = newVisit();
    p.visits.push(v);
    persist();
    location.hash = '#/visit/' + p.id + '/' + v.id;
  }

  // ---------- 视图：患者详情 ----------
  function renderPatient(pid) {
    var p = findPatient(pid);
    if (!p) { location.hash = '#/'; return; }
    setHeader(p.name, true, '#/');
    setStatus('');

    var visits = sortedVisits(p);
    app.innerHTML =
      '<div class="container">' +
      '<div class="card"><h2>患者信息</h2>' +
      '<div class="field-row">' +
      '<div class="field"><label>姓名</label><input data-pfield="name" value="' + esc(p.name) + '"></div>' +
      '<div class="field"><label>性别</label><select data-pfield="gender">' +
      '<option value=""></option>' +
      '<option' + (p.gender === '男' ? ' selected' : '') + '>男</option>' +
      '<option' + (p.gender === '女' ? ' selected' : '') + '>女</option></select></div>' +
      '<div class="field"><label>年龄</label><input data-pfield="age" value="' + esc(p.age) + '"></div>' +
      '</div>' +
      '<div class="field"><label>备注（区分同名患者，如单位/特征）</label><input data-pfield="note" value="' + esc(p.note) + '"></div>' +
      '</div>' +
      '<div class="toolbar"><button id="newVisitBtn">＋ 新建就诊记录</button></div>' +
      '<div id="visitList"></div>' +
      '<div class="card"><h2>危险操作</h2>' +
      '<button class="danger small" id="delPatientBtn">删除该患者及全部就诊记录</button></div>' +
      '</div>';

    var vh = '';
    if (!visits.length) vh = '<div class="empty">还没有就诊记录</div>';
    visits.forEach(function (v) {
      var sub = [v.tcmDiagnosis, v.syndrome].filter(Boolean).join(' · ') ||
        (v.condition ? v.condition.slice(0, 30) : '—');
      vh += '<div class="list-item" data-vid="' + v.id + '">' +
        '<div class="row1"><span class="name">' + esc(v.visitDate || '未填日期') + '</span></div>' +
        '<div class="sub">' + esc(sub) + '</div></div>';
    });
    document.getElementById('visitList').innerHTML = vh;
    Array.prototype.forEach.call(document.querySelectorAll('#visitList .list-item'), function (el) {
      el.onclick = function () { location.hash = '#/visit/' + p.id + '/' + el.dataset.vid; };
    });

    Array.prototype.forEach.call(app.querySelectorAll('[data-pfield]'), function (el) {
      el.addEventListener('input', function () {
        p[el.dataset.pfield] = el.value;
        persist();
        headerTitle.textContent = p.name;
        setStatus('已保存 ' + now());
      });
    });

    document.getElementById('newVisitBtn').onclick = function () { createVisitAndGo(p); };
    document.getElementById('delPatientBtn').onclick = function () {
      if (!confirm('确定删除患者「' + p.name + '」及其全部 ' + p.visits.length + ' 条就诊记录吗？删除后无法恢复！')) return;
      patients = patients.filter(function (x) { return x.id !== p.id; });
      persist();
      location.hash = '#/';
    };
  }

  // ---------- 中药查找与用法 ----------
  var HERB_PREFIX = '炙煅生焦炒酒姜制盐蜜怀川法熟';
  function findHerb(name) {
    var all = HERBS.concat(customKB.herbs);
    for (var i = 0; i < all.length; i++) if (all[i].name === name) return all[i];
    for (var j = 0; j < 2; j++) {
      if (name.length > 1 && HERB_PREFIX.indexOf(name[0]) >= 0) {
        name = name.slice(1);
        for (var k = 0; k < all.length; k++) if (all[k].name === name) return all[k];
      }
    }
    return null;
  }
  // 《中国药典》煎服法补充表（effect 中未标注但需特殊煎法的药）
  var USAGE_EXTRA = {
    '大黄': '后下', '番泻叶': '泡服', '肉桂': '后下', '芒硝': '冲服',
    '水牛角': '先煎', '鹿角胶': '烊化', '龟甲胶': '烊化', '朱砂': '冲服',
    '青黛': '冲服', '饴糖': '烊化', '蜂蜜': '冲服', '琥珀': '冲服',
    '羚羊角': '另煎', '雷丸': '入丸散', '鹤虱': '入丸散', '甘遂': '入丸散',
    '京大戟': '入丸散', '芫花': '入丸散', '千金子': '入丸散'
  };
  function herbUsage(name) {
    var h = findHerb(name);
    var base = h ? h.name : name;
    if (USAGE_EXTRA[base]) return USAGE_EXTRA[base];
    if (!h || !h.effect) return '';
    var m = h.effect.match(/（([^（）]{1,14})）/);
    if (!m) return '';
    var t = m[1];
    var keys = ['先煎', '后下', '包煎', '烊化', '另煎', '冲服', '泡服', '入丸散', '研末'];
    for (var i = 0; i < keys.length; i++) if (t.indexOf(keys[i]) >= 0) return keys[i];
    return '';
  }
  function parseComposition(comp) {
    // "柴胡12g 黄芩9g 大枣4枚" → [{name,dose}]
    return (comp || '').split(/\s+/).filter(Boolean).map(function (tok) {
      var m = tok.match(/^([^\d（(]+?)([\d\.]+.*)$/);
      var name, dose;
      if (m) { name = m[1]; dose = m[2]; }
      else if (/适量$/.test(tok)) { name = tok.slice(0, -2); dose = '适量'; }
      else { name = tok; dose = (findHerb(tok) || {}).dosage || ''; }
      return { name: name, dose: dose, usage: herbUsage(name) };
    }).filter(function (h) { return h.name; });
  }
  var USAGE_OPTIONS = ['', '先煎', '后下', '包煎', '烊化', '冲服', '另煎', '捣碎'];

  // ---------- 视图：就诊编辑 ----------
  function renderVisitEditor(pid, vid) {
    var p = findPatient(pid);
    if (!p) { location.hash = '#/'; return; }
    var v = findVisit(p, vid);
    if (!v) { location.hash = '#/patient/' + pid; return; }
    v.herbs = Array.isArray(v.herbs) ? v.herbs : [];

    setHeader(p.name + ' · ' + (v.visitDate || '就诊记录'), true, '#/patient/' + pid);

    var others = sortedVisits(p).filter(function (x) { return x.id !== vid; });
    var chips = '';
    if (others.length) {
      chips = '<div class="history-bar"><span class="hint" style="align-self:center">历史就诊：</span>';
      others.slice(0, 6).forEach(function (o) {
        chips += '<span class="history-chip" data-vid="' + o.id + '">' +
          esc(o.visitDate || '?') + ' ' + esc(o.tcmDiagnosis || '') + '</span>';
      });
      chips += '</div>';
    }

    app.innerHTML =
      '<div class="container">' + chips +

      '<div class="card"><h2>就诊信息</h2>' +
      '<div class="field"><label>就诊日期</label><input type="date" data-field="visitDate" value="' + esc(v.visitDate) + '"></div>' +
      '</div>' +

      '<div class="card"><h2>病情记录</h2>' +
      '<div class="field"><label>主诉、现病史、既往史、过敏史、四诊（望闻问切、舌象、脉象）等，直接写在一起即可。写到「头痛」「舌红少苔」这类词会自动弹出相关证型提示</label>' +
      '<textarea data-field="condition" rows="9" placeholder="如：患者反复头痛3月余，胀痛为主，伴急躁易怒、口苦。纳可，眠差，二便调。舌红苔黄，脉弦数。">' + esc(v.condition) + '</textarea></div>' +
      '<div id="termStrip"></div>' +
      '</div>' +

      '<div class="card"><h2>诊断与治法</h2>' +
      '<div class="field-row">' +
      '<div class="field quick-wrap"><label>中医诊断（可输拼音首字母，如 gxy）</label>' +
      '<input data-field="tcmDiagnosis" id="diagInput" value="' + esc(v.tcmDiagnosis) + '" placeholder="如：胃脘痛 / wt" autocomplete="off">' +
      '<div id="diagResults" class="quick-results hidden"></div></div>' +
      '<div class="field quick-wrap"><label>西医诊断（可输拼音首字母，如 tn b → tnb）</label>' +
      '<input data-field="westernDiagnosis" id="wdiagInput" value="' + esc(v.westernDiagnosis) + '" placeholder="如：慢性胃炎 / mxwy" autocomplete="off">' +
      '<div id="wdiagResults" class="quick-results hidden"></div></div>' +
      '</div>' +
      '<div class="field-row">' +
      '<div class="field"><label>辨证（证型，识别后可在词条区悬停看详解）</label><input data-field="syndrome" value="' + esc(v.syndrome) + '" placeholder="如：肝郁脾虚证"></div>' +
      '<div class="field"><label>治法（下方推荐可悬停看详解、点击填入）</label><input data-field="treatment" value="' + esc(v.treatment) + '" placeholder="如：平肝潜阳"></div>' +
      '</div>' +
      '<div id="treatSugg"></div>' +
      '</div>' +

      '<div class="card"><h2>方药</h2>' +
      '<div class="field quick-wrap"><label>添加药物/方剂：输拼音首字母或名称（如 ch → 柴胡；xcht → 小柴胡汤整方拆成药块；重复的药自动跳过）。药块上悬停/点击药名可看药性</label>' +
      '<input id="herbInput" placeholder="如：ch / xcht / 柴胡" autocomplete="off">' +
      '<div id="herbResults" class="quick-results hidden"></div></div>' +
      '<div id="herbGrid"></div>' +
      '<div id="herbSkipHint" class="hint"></div>' +
      '<div id="pairRow"></div>' +
      '<div id="tempRow"></div>' +
      '<div class="field mt8"><label>方名 / 加减说明（识别到的方剂会显示在下方，悬停可看方解）</label>' +
      '<textarea data-field="prescriptionNote" rows="2" placeholder="如：小柴胡汤合二陈汤加减">' + esc(v.prescriptionNote) + '</textarea></div>' +
      '<div id="noteFormulaChips"></div>' +
      '</div>' +

      '<div class="card"><h2>备注</h2>' +
      '<div class="field"><label>针灸及其他疗法、医嘱、跟诊体会、老师讲解要点等</label>' +
      '<textarea data-field="notes" rows="4">' + esc(v.notes) + '</textarea></div>' +
      '</div>' +

      '<button class="danger" id="delVisitBtn" style="width:100%">删除本次就诊记录</button>' +
      '<div style="height:40px"></div>' +
      '</div>';

    setStatus('已保存');

    // 历史就诊跳转
    Array.prototype.forEach.call(app.querySelectorAll('.history-chip'), function (el) {
      el.onclick = function () { location.hash = '#/visit/' + p.id + '/' + el.dataset.vid; };
    });

    // 自动保存
    var saveTimer = null;
    function markDirty(cb) {
      v.updatedAt = Date.now();
      setStatus('保存中…');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        persist();
        if (cb) cb();
        setStatus('已保存 ' + now());
      }, 400);
    }
    Array.prototype.forEach.call(app.querySelectorAll('[data-field]'), function (el) {
      el.addEventListener('input', function () {
        v[el.dataset.field] = el.value;
        markDirty(function () {
          if (el.dataset.field === 'visitDate') {
            headerTitle.textContent = p.name + ' · ' + (v.visitDate || '就诊记录');
          }
        });
        if (el.dataset.field === 'condition' || el.dataset.field === 'tcmDiagnosis' || el.dataset.field === 'syndrome' || el.dataset.field === 'westernDiagnosis' || el.dataset.field === 'prescriptionNote') {
          onContentChange(el.dataset.field);
        }
      });
    });

    document.getElementById('delVisitBtn').onclick = function () {
      if (!confirm('确定删除这次就诊记录吗？删除后无法恢复！')) return;
      p.visits = p.visits.filter(function (x) { return x.id !== vid; });
      persist();
      location.hash = '#/patient/' + p.id;
    };

    // ===== 词条识别 + 悬浮弹窗 =====
    var termStrip = document.getElementById('termStrip');
    var lastAutoTerm = '';
    var autoPopTimer = null;

    function refreshTerms(autoPopAnchor) {
      var text = v.condition + ' ' + v.tcmDiagnosis + ' ' + v.syndrome + ' ' + v.westernDiagnosis;
      var terms = detectTerms(text);
      if (!terms.length) { termStrip.innerHTML = ''; return; }
      termStrip.innerHTML = '<div class="term-strip"><span class="hint">识别到（悬停/点击查看）：</span>' +
        terms.map(function (t) { return '<span class="term-chip" data-term="' + esc(t) + '">' + esc(t) + '</span>'; }).join('') +
        '</div>';
      Array.prototype.forEach.call(termStrip.querySelectorAll('.term-chip'), function (el) {
        el.addEventListener('mouseenter', function () { showPop(el, el.dataset.term); });
        el.addEventListener('mouseleave', scheduleHidePop);
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          showPop(el, el.dataset.term);
        });
      });
      // 刚输入完整词条时自动弹出一次
      if (autoPopAnchor) {
        var tail = v.condition.trim();
        var hit = null;
        for (var i = 0; i < terms.length; i++) {
          if (tail.slice(-terms[i].length) === terms[i]) { hit = terms[i]; break; }
        }
        if (hit && hit !== lastAutoTerm) {
          lastAutoTerm = hit;
          clearTimeout(autoPopTimer);
          showPop(autoPopAnchor, hit);
          autoPopTimer = setTimeout(hidePop, 5000);
        }
      }
    }

    // ===== 治法推荐 =====
    var treatSugg = document.getElementById('treatSugg');
    function refreshTreatment() {
      var sug = [];
      var syn = v.syndrome.trim();
      var idx = buildTermIndex();
      if (syn && idx[syn] && idx[syn].type === 'syndrome') {
        if (idx[syn].data.treatment) sug.push(idx[syn].data.treatment);
      }
      var diagEntry = idx[v.tcmDiagnosis.trim()];
      var diseases = [];
      if (diagEntry && (diagEntry.type === 'disease' || diagEntry.type === 'alias')) diseases.push(diagEntry.data);
      detectTerms(v.condition).forEach(function (t) {
        var e = idx[t];
        if (e && (e.type === 'disease' || e.type === 'alias') && diseases.indexOf(e.data) < 0) diseases.push(e.data);
      });
      diseases.forEach(function (d) {
        (d.syndromes || []).forEach(function (s) {
          if (s.treatment && sug.indexOf(s.treatment) < 0) sug.push(s.treatment);
        });
      });
      sug = sug.slice(0, 6);
      if (!sug.length) { treatSugg.innerHTML = ''; return; }
      treatSugg.innerHTML = '<div class="term-strip"><span class="hint">推荐治法（悬停看详解，点击填入）：</span>' +
        sug.map(function (s) { return '<span class="rec-chip" data-t="' + esc(s) + '">' + esc(s) + '</span>'; }).join('') + '</div>';
      Array.prototype.forEach.call(treatSugg.querySelectorAll('.rec-chip'), function (el) {
        el.addEventListener('mouseenter', function () { showTreatPop(el, el.dataset.t); });
        el.addEventListener('mouseleave', scheduleHidePop);
        el.onclick = function (e) {
          e.stopPropagation();
          v.treatment = el.dataset.t;
          app.querySelector('[data-field="treatment"]').value = v.treatment;
          markDirty();
          showTreatPop(el, el.dataset.t);
        };
      });
    }

    function onContentChange(field) {
      refreshTerms(field === 'condition' ? app.querySelector('[data-field="condition"]') : null);
      refreshTreatment();
      if (field === 'prescriptionNote') refreshNoteFormulas();
    }

    // ===== 诊断病名联想 =====
    var diagInput = document.getElementById('diagInput');
    var diagResults = document.getElementById('diagResults');
    function allDiseases() { return DISEASES.concat(customKB.diseases); }
    diagInput.addEventListener('input', function () {
      var q = diagInput.value.trim().toLowerCase();
      if (!q) { diagResults.classList.add('hidden'); return; }
      var items = allDiseases().filter(function (d) {
        return (d.py && d.py.indexOf(q) === 0) || d.name.toLowerCase().indexOf(q) >= 0 ||
          (d.alias && d.alias.indexOf(q) >= 0);
      }).slice(0, 8);
      if (!items.length) { diagResults.classList.add('hidden'); return; }
      diagResults.innerHTML = items.map(function (d, i) {
        return '<div class="q-item" data-i="' + i + '"><div class="t"><span class="tag">病</span>' + esc(d.name) + '</div>' +
          '<div class="sub">' + esc((d.syndromes || []).map(function (s) { return s.name; }).join('、') || d.alias || '') + '</div></div>';
      }).join('');
      diagResults.classList.remove('hidden');
      Array.prototype.forEach.call(diagResults.querySelectorAll('.q-item'), function (el) {
        el.onmousedown = function (e) {
          e.preventDefault();
          diagInput.value = items[Number(el.dataset.i)].name;
          diagResults.classList.add('hidden');
          diagInput.dispatchEvent(new Event('input'));
        };
      });
    });
    diagInput.addEventListener('blur', function () {
      setTimeout(function () { diagResults.classList.add('hidden'); }, 150);
    });

    // ===== 西医诊断联想 =====
    var wdiagInput = document.getElementById('wdiagInput');
    var wdiagResults = document.getElementById('wdiagResults');
    wdiagInput.addEventListener('input', function () {
      var q = wdiagInput.value.trim().toLowerCase();
      if (!q) { wdiagResults.classList.add('hidden'); return; }
      var items = WESTERN.filter(function (w) {
        return (w.py && w.py.indexOf(q) === 0) || w.name.toLowerCase().indexOf(q) >= 0;
      }).slice(0, 8);
      if (!items.length) { wdiagResults.classList.add('hidden'); return; }
      wdiagResults.innerHTML = items.map(function (w, i) {
        return '<div class="q-item" data-i="' + i + '"><div class="t"><span class="tag">西</span>' + esc(w.name) + '</div>' +
          '<div class="sub">' + esc(w.brief || '') + '</div></div>';
      }).join('');
      wdiagResults.classList.remove('hidden');
      Array.prototype.forEach.call(wdiagResults.querySelectorAll('.q-item'), function (el) {
        el.onmousedown = function (e) {
          e.preventDefault();
          wdiagInput.value = items[Number(el.dataset.i)].name;
          wdiagResults.classList.add('hidden');
          wdiagInput.dispatchEvent(new Event('input'));
        };
      });
    });
    wdiagInput.addEventListener('blur', function () {
      setTimeout(function () { wdiagResults.classList.add('hidden'); }, 150);
    });

    // ===== 方药：药块网格 =====
    var herbGrid = document.getElementById('herbGrid');
    var pairRow = document.getElementById('pairRow');
    var tempRow = document.getElementById('tempRow');

    // 按"去前缀后的药名"去重（如 炙甘草 与 甘草 视为同一味）
    function herbBaseName(name) {
      var h = findHerb(name);
      return h ? h.name : name;
    }
    // 剂量统一为克数（纯数字）：4枚→12、3片→9、30ml→30、适量/空→库中默认量
    function doseToGrams(doseStr, herbName) {
      var d = (doseStr || '').trim();
      var m = d.match(/^([\d.]+)(.*)$/);
      if (!m) {
        var h = findHerb(herbName);
        var dm = (((h || {}).dosage) || '').match(/^([\d.]+)/);
        return dm ? dm[1] : '';
      }
      var n = parseFloat(m[1]);
      var unit = m[2] || '';
      if (unit === '' || unit === 'g' || unit === '克' || unit === 'ml' || unit === 'mL') {
        return String(Math.round(n * 10) / 10);
      }
      if (unit.indexOf('枚') >= 0 || unit.indexOf('片') >= 0) return String(Math.round(n * 3 * 10) / 10);
      return String(Math.round(n * 10) / 10);
    }
    function addHerbs(list) {
      var skipped = [];
      list.forEach(function (hb) {
        var base = herbBaseName(hb.name);
        var dup = v.herbs.some(function (x) { return herbBaseName(x.name) === base; });
        if (dup) { skipped.push(hb.name); return; }
        hb.dose = doseToGrams(hb.dose, hb.name);
        v.herbs.push(hb);
      });
      return skipped;
    }
    // 药性寒热评分（-3大寒 … 0平 … +3大热）
    function natureScore(name) {
      var h = findHerb(name);
      if (!h || !h.nature) return null;
      var seg = h.nature.split('。')[0];
      var map = [['大热', 3], ['大寒', -3], ['微温', 0.5], ['微寒', -0.5], ['热', 2], ['寒', -2], ['温', 1], ['凉', -0.5], ['平', 0]];
      for (var i = 0; i < map.length; i++) {
        if (seg.indexOf(map[i][0]) >= 0) return map[i][1];
      }
      return 0;
    }
    // 加权寒热偏性（按克数加权）
    function calcTemp() {
      var sum = 0, wsum = 0, unknown = 0;
      v.herbs.forEach(function (hb) {
        var s = natureScore(hb.name);
        if (s === null) { unknown++; return; }
        var g = parseFloat(hb.dose);
        if (isNaN(g) || g <= 0) g = parseFloat((findHerb(hb.name) || {}).dosage) || 10;
        sum += s * g;
        wsum += g;
      });
      if (!wsum) return null;
      return { score: sum / wsum, unknown: unknown };
    }
    function tempLabel(s) {
      if (s <= -1.5) return '寒凉';
      if (s < -0.3) return '偏凉';
      if (s < 0.3) return '平和';
      if (s < 1.5) return '偏温';
      return '温热';
    }
    // 对药识别
    function findPairs() {
      var bases = v.herbs.map(function (hb) { return herbBaseName(hb.name); });
      return PAIRS.filter(function (pr) {
        return bases.indexOf(pr.a) >= 0 && bases.indexOf(pr.b) >= 0;
      });
    }

    function renderPairsAndTemp() {
      var pairs = findPairs();
      if (pairRow) {
        pairRow.innerHTML = pairs.length
          ? '<div class="term-strip"><span class="hint">对药（悬停/点击看方解）：</span>' +
            pairs.map(function (pr, i) {
              return '<span class="pair-chip" data-i="' + i + '">' + esc(pr.a) + '·' + esc(pr.b) + '</span>';
            }).join('') + '</div>'
          : '';
        Array.prototype.forEach.call(pairRow.querySelectorAll('.pair-chip'), function (el) {
          el.addEventListener('mouseenter', function () {
            showPopRaw(el, popContent('pair', pairs[Number(el.dataset.i)]));
          });
          el.addEventListener('mouseleave', scheduleHidePop);
          el.addEventListener('click', function (e) {
            e.stopPropagation();
            showPopRaw(el, popContent('pair', pairs[Number(el.dataset.i)]));
          });
        });
      }
      if (tempRow) {
        var t = calcTemp();
        if (!t) { tempRow.innerHTML = ''; return; }
        var pct = Math.max(2, Math.min(98, (t.score + 3) / 6 * 100));
        tempRow.innerHTML =
          '<div class="temp-wrap"><div class="temp-title">方剂寒热偏性：<b>' + tempLabel(t.score) + '</b>' +
          '<span class="hint">（按克数加权' + (t.unknown ? '，' + t.unknown + ' 味未知药性未计入' : '') + '）</span></div>' +
          '<div class="temp-bar"><div class="temp-marker" style="left:' + pct + '%"></div></div>' +
          '<div class="temp-labels"><span>寒</span><span>平</span><span>热</span></div></div>';
      }
    }

    function renderHerbs() {
      if (!v.herbs.length) {
        herbGrid.innerHTML = '<p class="hint mt8">尚未添加药物。在上方输入药名或方名即可生成药块。</p>';
        renderPairsAndTemp();
        return;
      }
      var h = '<div class="herb-grid">';
      v.herbs.forEach(function (hb, i) {
        h += '<div class="herb-chip">' +
          '<span class="hc-del" data-i="' + i + '" title="删除">×</span>' +
          '<span class="hc-usage' + (hb.usage ? '' : ' empty') + '" data-i="' + i + '" title="点击选择煎服法">' + esc(hb.usage || '用法') + '</span>' +
          '<div class="hc-name" data-i="' + i + '" title="悬停/点击查看药性">' + esc(hb.name) + '</div>' +
          '<div class="hc-dose-row"><input class="hc-dose" data-i="' + i + '" value="' + esc(hb.dose) + '" placeholder="量" inputmode="decimal"><span class="hc-unit">g</span></div>' +
          '</div>';
      });
      h += '</div>';
      herbGrid.innerHTML = h;

      Array.prototype.forEach.call(herbGrid.querySelectorAll('.hc-dose'), function (el) {
        el.addEventListener('input', function () {
          var cleaned = el.value.replace(/[^\d.]/g, '');
          if (cleaned !== el.value) el.value = cleaned;
          v.herbs[Number(el.dataset.i)].dose = cleaned;
          markDirty();
          renderPairsAndTemp();
        });
      });
      Array.prototype.forEach.call(herbGrid.querySelectorAll('.hc-del'), function (el) {
        el.onclick = function () {
          v.herbs.splice(Number(el.dataset.i), 1);
          markDirty();
          renderHerbs();
        };
      });
      Array.prototype.forEach.call(herbGrid.querySelectorAll('.hc-usage'), function (el) {
        el.onclick = function (e) {
          e.stopPropagation();
          var idx = Number(el.dataset.i);
          showUsageMenu(el, idx);
        };
      });
      Array.prototype.forEach.call(herbGrid.querySelectorAll('.hc-name'), function (el) {
        el.addEventListener('mouseenter', function () {
          showHerbPop(el, v.herbs[Number(el.dataset.i)].name);
        });
        el.addEventListener('mouseleave', scheduleHidePop);
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          showHerbPop(el, v.herbs[Number(el.dataset.i)].name);
        });
      });
      renderPairsAndTemp();
    }
    // 煎服法选择菜单
    var USAGE_MENU = ['先煎', '后下', '包煎', '烊化', '冲服', '另煎', '捣碎', '泡服', '无'];
    function showUsageMenu(anchorEl, idx) {
      var hb = v.herbs[idx];
      var h = '<div class="kp-title">' + esc(hb.name) + '<span class="kp-meta">　选择煎服法</span></div>' +
        '<div class="usage-menu">' + USAGE_MENU.map(function (u) {
          var label = u === '无' ? '（无）' : u;
          var on = (hb.usage || '无') === u || (u === '无' && !hb.usage);
          return '<span class="usage-opt' + (on ? ' on' : '') + '" data-u="' + u + '">' + label + '</span>';
        }).join('') + '</div>';
      showPopRaw(anchorEl, h);
      Array.prototype.forEach.call(popEl.querySelectorAll('.usage-opt'), function (opt) {
        opt.onclick = function (e) {
          e.stopPropagation();
          v.herbs[idx].usage = opt.dataset.u === '无' ? '' : opt.dataset.u;
          markDirty();
          hidePop();
          renderHerbs();
        };
      });
    }
    renderHerbs();

    // 合方命名：小柴胡汤 → 再加二陈汤 → 小柴胡汤合二陈汤加减
    function appendFormulaName(name) {
      var note = (v.prescriptionNote || '').trim();
      if (!note) return name + '加减';
      if (note.indexOf(name) >= 0) return note;
      if (/加减$/.test(note)) return note.slice(0, -2) + '合' + name + '加减';
      return note + '合' + name;
    }
    // 方名/加减说明中识别到的方剂，高亮可悬停看方解
    var noteChips = document.getElementById('noteFormulaChips');
    function refreshNoteFormulas() {
      if (!noteChips) return;
      var hits = [];
      FORMULAS.concat(customKB.formulas).forEach(function (f) {
        if (f.name && v.prescriptionNote && v.prescriptionNote.indexOf(f.name) >= 0 && hits.indexOf(f.name) < 0) {
          hits.push(f.name);
        }
      });
      noteChips.innerHTML = hits.length
        ? '<div class="term-strip"><span class="hint">方剂（悬停/点击看方解）：</span>' +
          hits.map(function (t) { return '<span class="term-chip" data-term="' + esc(t) + '">' + esc(t) + '</span>'; }).join('') + '</div>'
        : '';
      Array.prototype.forEach.call(noteChips.querySelectorAll('.term-chip'), function (el) {
        el.addEventListener('mouseenter', function () { showPop(el, el.dataset.term); });
        el.addEventListener('mouseleave', scheduleHidePop);
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          showPop(el, el.dataset.term);
        });
      });
    }
    refreshNoteFormulas();

    // 旧数据剂量统一为克数（一次性迁移）
    var doseMigrated = false;
    v.herbs.forEach(function (hb) {
      var g = doseToGrams(hb.dose, hb.name);
      if (g !== (hb.dose || '')) { hb.dose = g; doseMigrated = true; }
    });
    if (doseMigrated) { persist(); renderHerbs(); }

    var skipHintTimer = null;
    function showSkipHint(skipped) {
      var el = document.getElementById('herbSkipHint');
      if (!el) return;
      if (!skipped || !skipped.length) { el.textContent = ''; return; }
      el.textContent = '已自动跳过重复药物：' + skipped.join('、');
      clearTimeout(skipHintTimer);
      skipHintTimer = setTimeout(function () { el.textContent = ''; }, 5000);
    }

    var herbInput = document.getElementById('herbInput');
    var herbResults = document.getElementById('herbResults');
    function allHerbs() { return HERBS.concat(customKB.herbs); }
    function allFormulas() { return FORMULAS.concat(customKB.formulas); }
    herbInput.addEventListener('input', function () {
      var q = herbInput.value.trim().toLowerCase();
      if (!q) { herbResults.classList.add('hidden'); return; }
      var items = [];
      allFormulas().forEach(function (f) {
        if ((f.py && f.py.indexOf(q) === 0) || f.name.indexOf(q) >= 0) items.push({ kind: 'F', data: f });
      });
      allHerbs().forEach(function (hb) {
        if ((hb.py && hb.py.indexOf(q) === 0) || hb.name.indexOf(q) >= 0) items.push({ kind: 'H', data: hb });
      });
      items = items.slice(0, 8);
      if (!items.length) { herbResults.classList.add('hidden'); return; }
      herbResults.innerHTML = items.map(function (it, i) {
        if (it.kind === 'F') {
          return '<div class="q-item" data-i="' + i + '"><div class="t"><span class="tag">方</span>' + esc(it.data.name) + '</div>' +
            '<div class="sub">' + esc(it.data.composition || '') + '</div></div>';
        }
        return '<div class="q-item" data-i="' + i + '"><div class="t"><span class="tag">药</span>' + esc(it.data.name) +
          (it.data.dosage ? ' ' + esc(it.data.dosage) : '') + (herbUsage(it.data.name) ? '（' + herbUsage(it.data.name) + '）' : '') + '</div>' +
          '<div class="sub">' + esc(it.data.effect || '') + '</div></div>';
      }).join('');
      herbResults.classList.remove('hidden');
      Array.prototype.forEach.call(herbResults.querySelectorAll('.q-item'), function (el) {
        el.onmousedown = function (e) {
          e.preventDefault();
          var it = items[Number(el.dataset.i)];
          var skipped;
          if (it.kind === 'F') {
            skipped = addHerbs(parseComposition(it.data.composition));
            v.prescriptionNote = appendFormulaName(it.data.name);
            app.querySelector('[data-field="prescriptionNote"]').value = v.prescriptionNote;
            refreshNoteFormulas();
          } else {
            skipped = addHerbs([{ name: it.data.name, dose: it.data.dosage || '', usage: herbUsage(it.data.name) }]);
          }
          herbInput.value = '';
          herbResults.classList.add('hidden');
          markDirty();
          renderHerbs();
          showSkipHint(skipped);
        };
      });
    });
    herbInput.addEventListener('blur', function () {
      setTimeout(function () { herbResults.classList.add('hidden'); }, 150);
    });

    // 初次渲染：已有内容时识别词条与治法推荐（不自动弹窗）
    refreshTerms(null);
    refreshTreatment();
  }

  // ---------- 视图：知识库 ----------
  var kbState = { q: '', tab: '全部' };

  function renderKB() {
    setHeader('知识库', true, '#/');
    setStatus('');

    var tabs = ['全部', '疾病', '舌脉', '中药', '方剂', '我的添加'];
    app.innerHTML =
      '<div class="container">' +
      '<div class="toolbar"><input type="search" id="kbSearch" placeholder="如：高血压 / 舌红少苔 / 柴胡 / xcht" value="' + esc(kbState.q) + '"></div>' +
      '<div class="kb-tabs">' + tabs.map(function (t) {
        return '<button data-tab="' + t + '"' + (kbState.tab === t ? ' class="active"' : '') + '>' + t + '</button>';
      }).join('') + '</div>' +
      '<div class="toolbar"><button class="secondary" id="addCustomBtn">＋ 添加我的知识（老师讲的方、自己的总结）</button></div>' +
      '<div id="customFormWrap"></div>' +
      '<div id="kbResults"></div>' +
      '<p class="hint mt16">知识库内容仅供学习参考，临床用药请遵医嘱并核对剂量。</p>' +
      '</div>';

    var searchEl = document.getElementById('kbSearch');
    searchEl.addEventListener('input', function () {
      kbState.q = searchEl.value;
      renderKBResults();
    });
    Array.prototype.forEach.call(app.querySelectorAll('.kb-tabs button'), function (el) {
      el.onclick = function () {
        kbState.tab = el.dataset.tab;
        Array.prototype.forEach.call(app.querySelectorAll('.kb-tabs button'), function (x) {
          x.classList.toggle('active', x.dataset.tab === kbState.tab);
        });
        renderKBResults();
      };
    });
    document.getElementById('addCustomBtn').onclick = renderCustomForm;
    renderKBResults();
  }

  function diseaseCard(d, customIdx) {
    var h = '<div class="kb-card"><div class="kb-title">' + esc(d.name) + '</div>' +
      (d.alias ? '<div class="kb-meta">中医病名/相关：' + esc(d.alias) + '</div>' : '');
    (d.syndromes || []).forEach(function (s) {
      h += '<div class="kb-syn"><div class="kb-syn-name">' + esc(s.name) + '</div>' +
        (s.symptoms ? '<div class="kb-row"><b>症状</b>　' + esc(s.symptoms) + '</div>' : '') +
        (s.tongue ? '<div class="kb-row"><b>舌象</b>　' + esc(s.tongue) + '</div>' : '') +
        (s.pulse ? '<div class="kb-row"><b>脉象</b>　' + esc(s.pulse) + '</div>' : '') +
        (s.treatment ? '<div class="kb-row"><b>治法</b>　' + esc(s.treatment) + '</div>' : '') +
        (s.formulas ? '<div class="kb-row"><b>代表方</b>　' + esc(s.formulas) + '</div>' : '') +
        '</div>';
    });
    if (d.note) h += '<div class="kb-row">' + esc(d.note).replace(/\n/g, '<br>') + '</div>';
    if (customIdx !== undefined && customIdx !== null) {
      h += '<div class="kb-actions"><button class="danger small" data-del-type="diseases" data-del-i="' + customIdx + '">删除</button></div>';
    }
    return h + '</div>';
  }
  function signCard(s, customIdx) {
    return '<div class="kb-card"><div class="kb-title">' + esc(s.term) + '</div>' +
      '<div class="kb-meta">' + esc(s.category) + '</div>' +
      '<div class="kb-row"><b>指向</b>　' + esc(s.indicates) + '</div>' +
      (s.related ? '<div class="kb-row"><b>说明</b>　' + esc(s.related) + '</div>' : '') +
      (s.formulas ? '<div class="kb-row"><b>常考虑方</b>　' + esc(s.formulas) + '</div>' : '') +
      (customIdx !== undefined && customIdx !== null ? '<div class="kb-actions"><button class="danger small" data-del-type="signs" data-del-i="' + customIdx + '">删除</button></div>' : '') +
      '</div>';
  }
  function herbCard(h, customIdx) {
    return '<div class="kb-card"><div class="kb-title">' + esc(h.name) +
      (h.dosage ? ' <span class="hint">常用 ' + esc(h.dosage) + '</span>' : '') + '</div>' +
      (h.nature ? '<div class="kb-row"><b>性味归经</b>　' + esc(h.nature) + '</div>' : '') +
      (h.effect ? '<div class="kb-row"><b>功效</b>　' + esc(h.effect) + '</div>' : '') +
      (h.classic ? '<div class="kb-row"><b>经典</b>　' + esc(h.classic) + '</div>' : '') +
      (customIdx !== undefined && customIdx !== null ? '<div class="kb-actions"><button class="danger small" data-del-type="herbs" data-del-i="' + customIdx + '">删除</button></div>' : '') +
      '</div>';
  }
  function formulaCard(f, customIdx) {
    return '<div class="kb-card"><div class="kb-title">' + esc(f.name) + '</div>' +
      (f.composition ? '<div class="kb-row"><b>组成</b>　' + esc(f.composition) + '</div>' : '') +
      (f.effect ? '<div class="kb-row"><b>功用</b>　' + esc(f.effect) + '</div>' : '') +
      (f.indications ? '<div class="kb-row"><b>主治</b>　' + esc(f.indications) + '</div>' : '') +
      (customIdx !== undefined && customIdx !== null ? '<div class="kb-actions"><button class="danger small" data-del-type="formulas" data-del-i="' + customIdx + '">删除</button></div>' : '') +
      '</div>';
  }

  function renderKBResults() {
    var q = kbState.q.trim().toLowerCase();
    var tab = kbState.tab;
    var out = '';
    var total = 0;

    function matchText() {
      var args = Array.prototype.slice.call(arguments);
      if (!q) return true;
      return args.some(function (s) { return s && String(s).toLowerCase().indexOf(q) >= 0; });
    }
    function matchPY(py, name) {
      if (!q) return true;
      return (py && py.indexOf(q) === 0) || (name && name.toLowerCase().indexOf(q) >= 0);
    }

    if (tab === '全部' || tab === '疾病' || tab === '我的添加') {
      DISEASES.forEach(function (d) {
        var synNames = (d.syndromes || []).map(function (s) { return s.name; }).join(' ');
        if (matchText(d.name, d.alias, synNames, d.py)) { out += diseaseCard(d); total++; }
      });
      if (tab !== '疾病') customKB.diseases.forEach(function (d, i) {
        if (matchText(d.name, d.alias, d.note)) { out += diseaseCard(d, i); total++; }
      });
    }
    if (tab === '全部' || tab === '舌脉' || tab === '我的添加') {
      SIGNS.forEach(function (s) {
        if (matchText(s.term, s.indicates)) { out += signCard(s); total++; }
      });
      if (tab !== '舌脉') customKB.signs.forEach(function (s, i) {
        if (matchText(s.term, s.indicates, s.related)) { out += signCard(s, i); total++; }
      });
    }
    if (tab === '全部' || tab === '中药' || tab === '我的添加') {
      HERBS.forEach(function (h) {
        if (matchPY(h.py, h.name) || (q && h.effect && h.effect.indexOf(q) >= 0)) { out += herbCard(h); total++; }
      });
      if (tab !== '中药') customKB.herbs.forEach(function (h, i) {
        if (matchPY(h.py, h.name)) { out += herbCard(h, i); total++; }
      });
    }
    if (tab === '全部' || tab === '方剂' || tab === '我的添加') {
      FORMULAS.forEach(function (f) {
        if (matchPY(f.py, f.name) || (q && (f.composition || '').indexOf(q) >= 0)) { out += formulaCard(f); total++; }
      });
      if (tab !== '方剂') customKB.formulas.forEach(function (f, i) {
        if (matchPY(f.py, f.name)) { out += formulaCard(f, i); total++; }
      });
    }

    if (!total) {
      out = '<div class="empty">' + (q ? '没有找到「' + esc(kbState.q) + '」相关内容<br>可点击上方「添加我的知识」把它录入你的知识库' : '输入关键词开始查询') + '</div>';
    }
    document.getElementById('kbResults').innerHTML = out;

    Array.prototype.forEach.call(document.querySelectorAll('[data-del-type]'), function (el) {
      el.onclick = function () {
        if (!confirm('删除这条自定义知识？')) return;
        customKB[el.dataset.delType].splice(Number(el.dataset.delI), 1);
        persistKB();
        renderKBResults();
      };
    });
  }

  // ---------- 自定义知识 ----------
  function renderCustomForm() {
    var wrap = document.getElementById('customFormWrap');
    var typeFields = {
      herbs: [['name', '药名*'], ['py', '拼音首字母（如 ch）'], ['dosage', '常用剂量（如 10g）'], ['nature', '性味归经'], ['effect', '功效']],
      formulas: [['name', '方名*'], ['py', '拼音首字母（如 xcht）'], ['composition', '组成及剂量（如：柴胡12g 黄芩9g……）'], ['effect', '功用'], ['indications', '主治']],
      diseases: [['name', '病名*'], ['alias', '中医病名/别名'], ['note', '内容（证型、症状、方药等，自由记录）']],
      signs: [['term', '舌象/脉象*'], ['category', '类别（舌象 或 脉象）'], ['indicates', '指向证候'], ['related', '说明'], ['formulas', '常考虑方']]
    };
    var typeNames = { herbs: '中药', formulas: '方剂', diseases: '疾病', signs: '舌脉' };

    wrap.innerHTML =
      '<div class="card"><h2>添加我的知识</h2>' +
      '<div class="field"><label>类型</label><select id="ckType">' +
      Object.keys(typeNames).map(function (k) { return '<option value="' + k + '">' + typeNames[k] + '</option>'; }).join('') +
      '</select></div><div id="ckFields"></div>' +
      '<div class="data-row"><button id="ckSave">保存到我的知识库</button>' +
      '<button class="secondary" id="ckCancel">取消</button></div></div>';

    var typeSel = document.getElementById('ckType');
    function drawFields() {
      var fields = typeFields[typeSel.value];
      document.getElementById('ckFields').innerHTML = fields.map(function (f) {
        if (f[0] === 'note' || f[0] === 'related' || f[0] === 'composition' || f[0] === 'indications') {
          return '<div class="field"><label>' + f[1] + '</label><textarea data-ck="' + f[0] + '" rows="3"></textarea></div>';
        }
        return '<div class="field"><label>' + f[1] + '</label><input data-ck="' + f[0] + '"></div>';
      }).join('');
    }
    typeSel.onchange = drawFields;
    drawFields();

    document.getElementById('ckCancel').onclick = function () { wrap.innerHTML = ''; };
    document.getElementById('ckSave').onclick = function () {
      var type = typeSel.value;
      var obj = {};
      var hasName = false;
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-ck]'), function (el) {
        obj[el.dataset.ck] = el.value.trim();
        if (el.dataset.ck === 'name' || el.dataset.ck === 'term') hasName = !!el.value.trim();
      });
      if (!hasName) { alert('请至少填写名称'); return; }
      if (type === 'diseases' && !obj.syndromes) obj.syndromes = [];
      customKB[type].push(obj);
      persistKB();
      wrap.innerHTML = '';
      kbState.tab = '我的添加';
      renderKB();
      alert('已保存到「我的知识库」');
    };
  }

  // ---------- 导出 / 导入 ----------
  function exportData() {
    var data = {
      app: 'tcm-clinic-notes',
      version: 2,
      exportedAt: new Date().toISOString(),
      patients: patients,
      customKB: customKB
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    var t = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = '跟诊病例备份-' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // 同人识别：姓名相同 + 性别不冲突 + 年龄差 ≤2 岁（兼容年龄随时间变化和录入误差）
  function samePerson(a, b) {
    if (!a.name || a.name.trim() !== (b.name || '').trim()) return false;
    if (a.gender && b.gender && a.gender !== b.gender) return false;
    var ageA = parseFloat(a.age), ageB = parseFloat(b.age);
    if (!isNaN(ageA) && !isNaN(ageB) && Math.abs(ageA - ageB) > 2) return false;
    return true;
  }
  // 就诊记录判重：id 相同，或就诊日期相同且病情记录/诊断内容一致
  function sameVisit(x, y) {
    if (x.id && y.id && x.id === y.id) return true;
    if (!x.visitDate || x.visitDate !== y.visitDate) return false;
    var cx = (x.condition || '') + (x.tcmDiagnosis || '') + (x.prescriptionNote || '');
    var cy = (y.condition || '') + (y.tcmDiagnosis || '') + (y.prescriptionNote || '');
    return cx === cy;
  }
  // 把就诊记录并入目标患者，返回新增条数
  function mergeVisits(target, incoming) {
    var added = 0;
    (incoming || []).forEach(function (nv) {
      var exists = target.visits.some(function (ov) { return sameVisit(ov, nv); });
      if (!exists) {
        if (!nv.id) nv.id = uid();
        target.visits.push(nv);
        added++;
      }
    });
    return added;
  }

  function importData(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.patients)) throw new Error('bad');
        var newP = 0, mergedP = 0, addedV = 0, skippedV = 0;
        data.patients.forEach(function (p) {
          if (!p.id || !p.name) { return; }
          var totalV = (Array.isArray(p.visits) ? p.visits : []).length;
          p.visits = (Array.isArray(p.visits) ? p.visits : []).map(migrateVisit);
          // 先按 id 精确匹配，再按 姓名+性别+年龄(±2岁) 匹配
          var target = findPatient(p.id);
          if (!target) {
            target = patients.find(function (x) { return samePerson(x, p); }) || null;
          }
          if (target) {
            var added = mergeVisits(target, p.visits);
            if (added > 0) { mergedP++; addedV += added; }
            skippedV += totalV - added;
          } else {
            patients.push(p);
            newP++;
            addedV += totalV;
          }
        });
        var addKB = 0;
        if (data.customKB) {
          ['herbs', 'formulas', 'diseases', 'signs'].forEach(function (k) {
            (data.customKB[k] || []).forEach(function (item) {
              var key = k === 'signs' ? 'term' : 'name';
              var dup = customKB[k].some(function (x) { return x[key] === item[key]; });
              if (!dup) { customKB[k].push(item); addKB++; }
            });
          });
        }
        persist();
        persistKB();
        alert('导入完成：\n· 新建患者 ' + newP + ' 人\n· 合并到已有患者 ' + mergedP + ' 人（新增就诊 ' + addedV + ' 条）' +
          (skippedV ? '\n· 跳过已存在的就诊记录 ' + skippedV + ' 条' : '') +
          (addKB ? '\n· 新增自定义知识 ' + addKB + ' 条' : ''));
        route();
      } catch (err) {
        alert('导入失败：文件格式不正确');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  }

  // ---------- 路由 ----------
  function route() {
    hidePop();
    var h = location.hash || '#/';
    var m;
    if ((m = h.match(/^#\/visit\/([^/]+)\/([^/]+)/))) {
      renderVisitEditor(m[1], m[2]);
    } else if ((m = h.match(/^#\/patient\/([^/]+)/))) {
      renderPatient(m[1]);
    } else if (h.indexOf('#/kb') === 0) {
      renderKB();
    } else {
      renderPatientList();
    }
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', route);
  route();
})();
