const firebaseConfig = {
  "apiKey": "AIzaSyCc3rwlIlZd7NaFkd2viT-tYhS9IemsV9o",
  "authDomain": "his-detention.firebaseapp.com",
  "databaseURL": "https://his-detention-default-rtdb.asia-southeast1.firebasedatabase.app/",
  "projectId": "his-detention",
  "storageBucket": "his-detention.firebasestorage.app",
  "messagingSenderId": "357843127217",
  "appId": "1:357843127217:web:88175e347add4931294b90",
  "measurementId": "G-K3X22E8JL5"
};

// Firebase 앱이 이미 초기화된 화면(import-data 등)에서도 common.js를 재사용할 수 있게 방어합니다.
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();
window.db = db;

// 최종 전환 이후에는 등록된 학교 Google 계정만 Firebase 인증에 사용합니다.
const firebaseAuth = (typeof firebase.auth === 'function') ? firebase.auth() : null;
window.firebaseAuth = firebaseAuth;
let _firebaseAuthPromise = null;

async function ensureFirebaseAuth() {
  if (!firebaseAuth) {
    throw new Error('Firebase Auth SDK가 로드되지 않았습니다. firebase-auth-compat.js를 확인하세요.');
  }
  if (firebaseAuth.currentUser && !firebaseAuth.currentUser.isAnonymous) return firebaseAuth.currentUser;
  if (_firebaseAuthPromise) return _firebaseAuthPromise;

  _firebaseAuthPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = () => {
      if (settled) return;
      settled = true;
      _firebaseAuthPromise = null;
      reject(new Error('학교 Google 로그인이 필요합니다.'));
    };

    const unsubscribe = firebaseAuth.onAuthStateChanged(user => {
      if (settled) return;
      try { unsubscribe(); } catch (_) {}
      if (user && !user.isAnonymous) {
        settled = true;
        resolve(user);
        return;
      }
      finishReject();
    }, err => {
      console.error('Firebase auth state failed:', err);
      try { unsubscribe(); } catch (_) {}
      finishReject();
    });
  });

  return _firebaseAuthPromise;
}
window.ensureFirebaseAuth = ensureFirebaseAuth;

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  if (!el) return alert(msg);

  el.textContent = msg;
  el.className = type;
  el.classList.add('on');

  setTimeout(() => el.classList.remove('on'), 3000);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'y', 'yes'].includes(String(v ?? '').trim().toLowerCase());
}

/**
 * Firebase RTDB key로 안전한 교사 key 생성
 * - email 우선, 없으면 name 사용
 * - 소문자/trim 처리
 * - Firebase에서 금지하는 문자 . # $ / [ ] 를 _ 로 치환
 */
function teacherKey(email, name) {
  const raw = String(email || name || '').trim().toLowerCase();
  return raw.replace(/[.#$/\[\]]/g, '_');
}

/**
 * 학생 key 생성
 * - className + name 조합으로 동명이인 충돌 방지
 * - Firebase 금지 문자는 _ 로 치환
 * ⚠️ 기존 DB에 이름만으로 저장된 key가 있다면 마이그레이션 필요
 */
function studentKey(name, className) {
  const raw = [String(className || '').trim(), String(name || '').trim()]
    .filter(Boolean)
    .join('_');
  return raw.replace(/[.#$/\[\]\s]/g, '_');
}

function requireTeacherSession() {
  const raw = sessionStorage.getItem('his_teacher');
  if (!raw) {
    location.href = 'index.html';
    return null;
  }

  try {
    const teacher = JSON.parse(raw);
    if (!teacher || teacher.authProvider !== 'google' || !teacher.authEmailVerified) {
      sessionStorage.removeItem('his_teacher');
      location.href = 'index.html';
      return null;
    }
    return teacher;
  } catch (e) {
    sessionStorage.removeItem('his_teacher');
    location.href = 'index.html';
    return null;
  }
}

async function logoutTeacher() {
  sessionStorage.removeItem('his_teacher');
  sessionStorage.removeItem('his_admin_session');
  try {
    if (firebaseAuth && firebaseAuth.currentUser) {
      await firebaseAuth.signOut();
    }
  } catch (e) {
    console.error('Google logout failed:', e);
  }
  location.href = 'index.html';
}

function csvSplit(line) {
  const out = [];
  let cur = '';
  let q = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        q = !q;
      }
    } else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }

  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const headers = csvSplit(lines[0]).map(s => s.trim());

  return lines.slice(1).map(line => {
    const cols = csvSplit(line);
    const row = {};

    headers.forEach((h, i) => {
      row[h] = (cols[i] ?? '').trim();
    });

    return row;
  });
}

function readFileText(file, enc = 'utf-8') {
  return new Promise((resolve, reject) => {
    const r = new FileReader();

    r.onload = () => {
      try {
        resolve(new TextDecoder(enc).decode(r.result));
      } catch (e) {
        reject(e);
      }
    };

    r.onerror = reject;
    r.readAsArrayBuffer(file);
  });
}

/**
 * HIS 디텐션 상태 계산 공통 모듈
 * - 상태 기준은 이곳에서만 관리합니다.
 * - teacher.html / detention-admin.html / import-data.html은 이 함수만 호출합니다.
 */
(function(){
  function hisLevelFromClassName(className){
    const m = String(className || '').match(/^(\d+)/);
    if (!m) return '';
    const grade = Number(m[1]);
    if (grade >= 7 && grade <= 9) return 'ms';
    if (grade >= 10 && grade <= 12) return 'hs';
    return grade >= 10 ? 'hs' : 'ms';
  }

  function hisSafeStateKey(studentKey, level){
    return (String(studentKey || '') + '_' + String(level || '')).replace(/[.#$\[\]\/]/g, '_');
  }

  function hisClassFromStudentKey(studentKey){
    const key = String(studentKey || '').trim();
    const m = key.match(/^(\d{1,2}[A-Z]?)[_\-\s]/i) || key.match(/^(\d{1,2}[A-Z]?)/i);
    return m ? m[1].toUpperCase() : '';
  }

  function hisRecordLevel(record, fallbackLevel){
    const r = record || {};
    const raw = String(r.level || r.schoolLevel || r.division || '').trim().toLowerCase();
    if (raw === 'ms' || raw === 'middle' || raw === 'middle school' || raw === '중등') return 'ms';
    if (raw === 'hs' || raw === 'high' || raw === 'high school' || raw === '고등') return 'hs';
    return hisLevelFromClassName(r.className || hisClassFromStudentKey(r.studentKey)) || String(fallbackLevel || '');
  }

  function hisLatestEntryDate(v){
    return String((v && (v.confirmedAt || v.createdAt || v.completedAt)) || '');
  }

  function hisCurrentYear(){
    const now = new Date();
    // HIS 학년도는 3월 시작이므로 1~2월은 직전 연도로 계산합니다.
    return String(now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear());
  }

  function hisAcademicYearFromDateText(value, fallbackYear){
    const raw = String(value || '').trim();
    const m = raw.match(/^(\d{4})-(\d{2})/);
    if (!m) return String(fallbackYear || hisCurrentYear());
    const year = Number(m[1]);
    const month = Number(m[2]);
    return String(month <= 2 ? year - 1 : year);
  }

  function hisRecordYear(record, fallbackYear){
    const r = record || {};
    const direct = r.year || r.schoolYear || r.academicYear;
    if (direct !== undefined && direct !== null && String(direct).trim() !== '') {
      return String(direct).trim();
    }
    const dt = String(r.confirmedAt || r.createdAt || r.completedAt || '').trim();
    return hisAcademicYearFromDateText(dt, fallbackYear || hisCurrentYear());
  }

  function hisIsCurrentYearRecord(record, currentYear){
    return hisRecordYear(record, currentYear) === String(currentYear || hisCurrentYear());
  }

  function hisValues(obj){
    return Object.values(obj || {});
  }

  function hisEntries(obj){
    return Object.entries(obj || {});
  }

  function calculateStudentCycleState(studentKey, level, data, options){
    options = options || {};
    data = data || {};

    const sk = String(studentKey || '').trim();
    const lv = String(level || '').trim();
    const entries = data.entries || {};
    const notices = data.notices || {};
    const recovery = data.recovery || {};
    const committee = data.committee || {};
    const curYear = String(options.year || hisCurrentYear());

    const confirmedEntries = hisEntries(entries)
      .filter(([, r]) =>
        String((r || {}).studentKey || '') === sk &&
        String((r || {}).status || '') === '확정' &&
        hisIsCurrentYearRecord(r, curYear)
      )
      .sort((a, b) => hisLatestEntryDate(b[1]).localeCompare(hisLatestEntryDate(a[1])));

    // 현재 학년도 확정 디텐션 원점수입니다.
    const yearRawPoints = confirmedEntries.reduce((sum, [, r]) => sum + Number((r || {}).totalPoints || 0), 0);

    // 현재 학년도 + 같은 학년군의 회복교육 차감점수입니다.
    const recoveredTotal = hisValues(recovery)
      .filter(r =>
        String((r || {}).studentKey || '') === sk &&
        hisRecordLevel(r, lv) === lv &&
        hisIsCurrentYearRecord(r, curYear)
      )
      .reduce((sum, r) => sum + Number((r || {}).recoveryPoints || 0), 0);

    const currentPoints = Math.max(0, yearRawPoints - recoveredTotal);

    const activeNoticeArr = hisEntries(notices)
      .filter(([, v]) =>
        String((v || {}).studentKey || '') === sk &&
        hisRecordLevel(v, lv) === lv &&
        !(v || {}).completedAt &&
        hisIsCurrentYearRecord(v, curYear)
      )
      .sort((a, b) => String((b[1] || {}).createdAt || '').localeCompare(String((a[1] || {}).createdAt || '')));
    const activeNotice = activeNoticeArr.length ? { key: activeNoticeArr[0][0], notice: activeNoticeArr[0][1] || {} } : null;

    const completedNoticeArr = hisEntries(notices)
      .filter(([, v]) =>
        String((v || {}).studentKey || '') === sk &&
        hisRecordLevel(v, lv) === lv &&
        !!(v || {}).completedAt &&
        hisIsCurrentYearRecord(v, curYear)
      )
      .sort((a, b) => String((b[1] || {}).completedAt || '').localeCompare(String((a[1] || {}).completedAt || '')));
    const lastCompletedNotice = completedNoticeArr.length ? { key: completedNoticeArr[0][0], notice: completedNoticeArr[0][1] || {} } : null;

    // 위원회는 분류 없이 학생 단위의 수동 회부/완료 기록으로만 관리합니다.
    const committeeArr = hisEntries(committee)
      .filter(([, c]) =>
        String((c || {}).studentKey || '') === sk &&
        hisIsCurrentYearRecord(c, curYear)
      )
      .sort((a, b) => String((b[1] || {}).createdAt || (b[1] || {}).referredAt || '').localeCompare(String((a[1] || {}).createdAt || (a[1] || {}).referredAt || '')));

    const pendingCommitteeEntry = committeeArr.find(([, c]) => !(c || {}).completedAt) || null;
    const completedCommitteeArr = committeeArr
      .filter(([, c]) => !!(c || {}).completedAt)
      .sort((a, b) => String((b[1] || {}).completedAt || '').localeCompare(String((a[1] || {}).completedAt || '')));

    const latestCommitteeCompletedAt = completedCommitteeArr.length ? String((completedCommitteeArr[0][1] || {}).completedAt || '') : '';
    const latestConfirmedEntryAt = confirmedEntries.length ? hisLatestEntryDate(confirmedEntries[0][1]) : '';
    const committeeCoversLatestEntry = !!latestCommitteeCompletedAt && (!latestConfirmedEntryAt || latestCommitteeCompletedAt >= latestConfirmedEntryAt);
    const hasPendingCommittee = !!pendingCommitteeEntry;
    const needsCommittee = currentPoints >= 12 && !hasPendingCommittee && !committeeCoversLatestEntry;

    let phase = 'clean';
    if (hasPendingCommittee) {
      phase = 'committee_pending';
    } else if (committeeCoversLatestEntry && currentPoints >= 3) {
      // 위원회 완료 후에는 같은 위반 묶음을 다시 알림으로 보내지 않고 회복교육 단계로 보냅니다.
      phase = 'in_recovery';
    } else if (activeNotice) {
      phase = (activeNotice.notice.parentMailAt || activeNotice.notice.studentTeacherMailAt) ? 'notice_active' : 'notice_needed';
    } else if (lastCompletedNotice && currentPoints >= 3) {
      const latestEntryAt = confirmedEntries.length ? hisLatestEntryDate(confirmedEntries[0][1]) : '';
      const lastNoticeAt = String(lastCompletedNotice.notice.completedAt || '');
      phase = latestEntryAt > lastNoticeAt ? 'notice_needed' : 'in_recovery';
    } else if (lastCompletedNotice && currentPoints > 0) {
      phase = 'residual';
    } else if (currentPoints >= 3) {
      phase = 'notice_needed';
    }

    const committeeStatus = hasPendingCommittee ? 'pending' : (needsCommittee ? 'eligible' : 'none');

    const state = {
      phase,
      cyclePoints: currentPoints,
      overallPoints: yearRawPoints,
      currentPoints,
      yearRawPoints,
      recoveryPoints: recoveredTotal,
      currentYear: curYear,
      committeeStatus,
      committeeThreshold: 12,
      updatedAt: new Date().toISOString(),
      updatedBy: options.updatedBy || 'system_recalculate'
    };

    return {
      state,
      meta: {
        activeNotice,
        lastCompletedNotice,
        confirmedEntries,
        pendingCommitteeEntry,
        hasPendingCommittee,
        needsCommittee,
        latestCommitteeCompletedAt,
        committeeCoversLatestEntry,
        // 구버전 호출부 호환용 별칭
        hasActiveReferral: false,
        hasManualReferralPending: hasPendingCommittee,
        hasManualEduPending: false,
        needsEduCommittee: needsCommittee,
        eduCompletedThisYear: completedCommitteeArr.length > 0
      }
    };
  }

  async function readStateData(){
    const [studentsSnap, entriesSnap, noticesSnap, recoverySnap, committeeSnap] = await Promise.all([
      db.ref('students').once('value'),
      db.ref('detentionEntries').once('value'),
      db.ref('detentionNotices').once('value'),
      db.ref('recoveryEntries').once('value'),
      db.ref('committeeRecords').once('value')
    ]);
    return {
      students: studentsSnap.val() || {},
      entries: entriesSnap.val() || {},
      notices: noticesSnap.val() || {},
      recovery: recoverySnap.val() || {},
      committee: committeeSnap.val() || {}
    };
  }

  async function recalculateStudentCycleState(studentKey, level, options){
    options = options || {};
    if (typeof db === 'undefined' || !db || !db.ref) {
      throw new Error('Firebase database is not initialized.');
    }

    const data = options.freshData || await readStateData();
    const result = calculateStudentCycleState(studentKey, level, data, options);

    // 위원회 회부가 수동 등록되면 진행 중 알림은 자동 완료 처리할 수 있습니다.
    if (options.autoCompleteReferralNotice &&
        result.meta &&
        result.meta.hasPendingCommittee &&
        result.meta.activeNotice &&
        result.meta.activeNotice.key &&
        !(result.meta.activeNotice.notice || {}).completedAt) {
      await db.ref('detentionNotices/' + result.meta.activeNotice.key).update({
        completedAt: new Date().toISOString(),
        completedBy: 'system_committee'
      });
      const refreshed = options.freshData ? await readStateData() : await readStateData();
      const resultAfterNoticeClose = calculateStudentCycleState(studentKey, level, refreshed, options);
      await db.ref('studentCycleState/' + hisSafeStateKey(studentKey, level)).set(resultAfterNoticeClose.state);
      return resultAfterNoticeClose.state;
    }

    await db.ref('studentCycleState/' + hisSafeStateKey(studentKey, level)).set(result.state);
    return result.state;
  }

  function collectStateTargets(data){
    data = data || {};
    const targets = {};
    function addTarget(studentKey, level, className){
      const sk = String(studentKey || '').trim();
      const lv = String(level || hisLevelFromClassName(className) || '').trim();
      if (!sk || !lv) return;
      targets[sk + '|||' + lv] = { studentKey: sk, level: lv };
    }

    hisEntries(data.students || {}).forEach(([key, s]) => addTarget(key, hisLevelFromClassName(s && s.className), s && s.className));
    hisValues(data.entries || {}).forEach(r => addTarget(r && r.studentKey, r && r.schoolLevel, r && r.className));
    hisValues(data.notices || {}).forEach(r => addTarget(r && r.studentKey, hisRecordLevel(r), r && (r.className || hisClassFromStudentKey(r.studentKey))));
    hisValues(data.recovery || {}).forEach(r => addTarget(r && r.studentKey, hisRecordLevel(r), r && (r.className || hisClassFromStudentKey(r.studentKey))));
    hisValues(data.committee || {}).forEach(r => addTarget(r && r.studentKey, hisRecordLevel(r), r && (r.className || hisClassFromStudentKey(r.studentKey))));
    return Object.values(targets);
  }

  async function recalculateAllStudentCycleStates(options){
    options = options || {};
    if (typeof db === 'undefined' || !db || !db.ref) {
      throw new Error('Firebase database is not initialized.');
    }

    const data = await readStateData();
    const newStates = {};
    collectStateTargets(data).forEach(({ studentKey, level }) => {
      const result = calculateStudentCycleState(studentKey, level, data, options);
      newStates[hisSafeStateKey(studentKey, level)] = result.state;
    });

    await db.ref('studentCycleState').set(Object.keys(newStates).length ? newStates : null);
    return { count: Object.keys(newStates).length, states: newStates };
  }

  window.hisLevelFromClassName = hisLevelFromClassName;
  window.hisSafeStateKey = hisSafeStateKey;
  window.hisRecordYear = hisRecordYear;
  window.hisIsCurrentYearRecord = hisIsCurrentYearRecord;
  window.hisRecordLevel = hisRecordLevel;
  window.calculateStudentCycleState = calculateStudentCycleState;
  window.recalculateStudentCycleState = recalculateStudentCycleState;
  window.recalculateAllStudentCycleStates = recalculateAllStudentCycleStates;
})();
