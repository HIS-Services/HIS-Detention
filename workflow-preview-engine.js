/* HIS Detention unified workflow preview engine.
 * PURE / READ-ONLY: this file contains no Firebase references and performs no writes.
 * It derives the workflow that SHOULD exist from record history.
 */
(function(root, factory){
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HISWorkflowPreview = api;
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  const NOTICE_THRESHOLD = 3;
  const EDU_CURRENT_THRESHOLD = 12;
  const EDU_OVERALL_THRESHOLD = 30;

  function entriesOf(obj){ return Object.entries(obj || {}); }
  function valuesOf(obj){ return Object.values(obj || {}); }
  function s(v){ return String(v == null ? '' : v).trim(); }
  function n(v){ const x = Number(v); return Number.isFinite(x) ? x : 0; }
  function bool(v){ return v === true || v === 'true'; }

  function academicYearFromDate(value, fallback){
    const m = s(value).match(/^(\d{4})-(\d{2})/);
    if (!m) return s(fallback);
    const year = Number(m[1]), month = Number(m[2]);
    return String(month <= 2 ? year - 1 : year);
  }

  function recordYear(r, fallback){
    r = r || {};
    const direct = r.year || r.schoolYear || r.academicYear;
    if (direct != null && s(direct)) return s(direct);
    return academicYearFromDate(r.confirmedAt || r.completedAt || r.createdAt || r.referredAt, fallback);
  }

  function classLevel(className){
    const m = s(className).toUpperCase().match(/(\d{1,2})/);
    if (!m) return '';
    const grade = Number(m[1]);
    return grade >= 9 ? 'hs' : (grade >= 6 ? 'ms' : '');
  }

  function recordLevel(r, fallback){
    r = r || {};
    const direct = s(r.level || r.schoolLevel).toLowerCase();
    if (direct === 'ms' || direct === 'hs') return direct;
    return classLevel(r.className) || s(fallback).toLowerCase();
  }

  function eventTime(r){
    r = r || {};
    return s(r.completedAt || r.confirmedAt || r.createdAt || r.referredAt || r.rejectedAt);
  }

  function confirmedTime(r){ return s((r || {}).confirmedAt || (r || {}).createdAt); }

  function normalizeKeyList(v){
    if (Array.isArray(v)) return v.map(s).filter(Boolean);
    if (typeof v === 'string') return v.split(/[\s,]+/).map(s).filter(Boolean);
    return [];
  }

  function committeeEntryKeys(r){
    r = r || {};
    const out = [];
    if (s(r.entryKey)) out.push(s(r.entryKey));
    out.push(...normalizeKeyList(r.linkedEntryKeys));
    return Array.from(new Set(out));
  }

  function committeeFlow(r, entries){
    r = r || {};
    const type = s(r.type).toLowerCase();
    if (['referral','manual_referral','guidance','guidance_committee'].includes(type)) return 'referral';
    if (['edu','manual_edu','education','education_committee'].includes(type)) return 'edu';
    const explicit = s(r.committeeCategory || r.committeeKind || r.displayType).toLowerCase();
    if (['referral','guidance','선도위원회'].includes(explicit)) return 'referral';
    if (['edu','education','생활교육위원회'].includes(explicit)) return 'edu';
    const reason = s(r.reason || r.reasonSnapshot || r.reasonsSnapshot).toLowerCase();
    if (/잔여|누적|12\s*점|30\s*점|remaining|overall|total\s*points|point\s*threshold/.test(reason)) return 'edu';
    if (committeeEntryKeys(r).some(k => bool(((entries || {})[k] || {}).isReferral))) return 'referral';
    return type === 'referral' ? 'referral' : 'edu';
  }

  function sourceBaselineRaw(source, confirmedEntries){
    const r = source.record || {};
    const explicit = [
      r.rawPointsAtCompletion,
      r.overallPointsAtCompletion,
      r.overallTotalAtCompletion,
      r.rawPointsAtCommittee,
      r.overallTotal
    ].find(v => v !== undefined && v !== null && s(v) !== '');
    if (explicit !== undefined) return Math.max(0, n(explicit));
    const at = s(r.completedAt);
    if (!at) return 0;
    // Historical admin-edited dates are often stored at midnight. Treat a date-only/midnight
    // completion as covering the full calendar day so same-day confirmed entries do not
    // falsely appear as NEW points after the workflow event.
    const midnight = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?(?:Z)?)?$/.test(at);
    const cutoffDay = at.slice(0,10);
    return confirmedEntries
      .filter(e => {
        const t = confirmedTime(e.record);
        return midnight ? t.slice(0,10) <= cutoffDay : t <= at;
      })
      .reduce((sum, e) => sum + n(e.record.totalPoints), 0);
  }

  function inferRecoveryLinks(completedSources, recoveries){
    const sourceByKey = new Map(completedSources.map(src => [src.type + ':' + src.key, src]));
    const assigned = new Map();
    const recoveryInfo = [];
    const warnings = [];

    const sortedRecoveries = recoveries.slice().sort((a,b)=>eventTime(a.record).localeCompare(eventTime(b.record)));

    // Explicit links first. A source can only be completed once.
    sortedRecoveries.forEach(rec => {
      const t = s(rec.record.sourceType).toLowerCase();
      const k = s(rec.record.sourceKey);
      if (!t || !k) return;
      const src = sourceByKey.get(t + ':' + k);
      if (src && !assigned.has(src.id)) {
        assigned.set(src.id, rec);
        recoveryInfo.push({ recovery:rec, source:src, inferred:false, valid:true });
      } else {
        recoveryInfo.push({ recovery:rec, source:src || null, inferred:false, valid:false });
        warnings.push('Recovery '+rec.key+' has an invalid or duplicate explicit source link.');
      }
    });

    // Legacy/unlinked records: deterministic FIFO pairing to the earliest unresolved
    // completed source that existed by the time the Recovery was completed.
    sortedRecoveries.forEach(rec => {
      if (recoveryInfo.some(x => x.recovery.key === rec.key)) return;
      const rt = eventTime(rec.record);
      const candidate = completedSources
        .filter(src => !assigned.has(src.id) && (!rt || s(src.record.completedAt) <= rt))
        .sort((a,b)=>s(a.record.completedAt).localeCompare(s(b.record.completedAt)))[0] || null;
      if (candidate) {
        assigned.set(candidate.id, rec);
        recoveryInfo.push({ recovery:rec, source:candidate, inferred:true, valid:true });
      } else {
        recoveryInfo.push({ recovery:rec, source:null, inferred:true, valid:false });
        warnings.push('Recovery '+rec.key+' could not be matched to a completed Notice/Committee source.');
      }
    });

    return { assigned, recoveryInfo, warnings };
  }

  // Recovery deductions are a ledger, not a bank of negative points.
  // Each completed Recovery can deduct only points that actually existed at that moment.
  // This means an excessive/duplicate old Recovery can NEVER make the hidden balance negative
  // and can never consume detention points that are added later.
  function calculateRecoveryLedger(confirmedEntries, recoveryInfo){
    const valid = recoveryInfo.filter(x=>x.valid).slice().sort((a,b)=>eventTime(a.recovery.record).localeCompare(eventTime(b.recovery.record)));
    let deducted = 0;
    let latestZeroAt = '';
    const rows = [];

    valid.forEach(info=>{
      const at = eventTime(info.recovery.record);
      const rawAtTime = confirmedEntries
        .filter(e=>!at || confirmedTime(e.record) <= at)
        .reduce((sum,e)=>sum+n(e.record.totalPoints),0);
      const available = Math.max(0, rawAtTime - deducted);
      const requested = Math.max(0, n(info.recovery.record.recoveryPoints));
      const effective = Math.min(requested, available);
      deducted += effective;
      if (effective > 0 && Math.max(0, rawAtTime - deducted) === 0) latestZeroAt = at || latestZeroAt;
      rows.push({
        recoveryKey:info.recovery.key,
        source:info.source,
        requestedPoints:requested,
        effectivePoints:effective,
        rawPointsAtTime:rawAtTime,
        availableBefore:available,
        completedAt:at,
        inferred:info.inferred
      });
    });

    return { effectiveRecoveredPoints:deducted, latestZeroAt, rows };
  }

  function analyzeStudent(studentKey, level, data, options){
    data = data || {}; options = options || {};
    const year = s(options.year || '');
    const sk = s(studentKey), lv = s(level).toLowerCase();
    const entries = data.entries || {}, notices = data.notices || {}, recovery = data.recovery || {}, committee = data.committee || {};

    const confirmedEntries = entriesOf(entries)
      .filter(([,r]) => s((r||{}).studentKey) === sk && s((r||{}).status) === '확정' && recordYear(r, year) === year)
      .map(([key,record]) => ({key, record:record||{}}))
      .sort((a,b)=>confirmedTime(a.record).localeCompare(confirmedTime(b.record)));
    const rawPoints = confirmedEntries.reduce((sum,e)=>sum+n(e.record.totalPoints),0);

    const noticeRecords = entriesOf(notices)
      .filter(([,r]) => s((r||{}).studentKey) === sk && recordLevel(r, lv) === lv && recordYear(r, year) === year)
      .map(([key,record])=>({key,record:record||{}}));
    const activeNotices = noticeRecords.filter(x=>!s(x.record.completedAt)).sort((a,b)=>eventTime(a.record).localeCompare(eventTime(b.record)));
    const completedNotices = noticeRecords.filter(x=>!!s(x.record.completedAt)).sort((a,b)=>s(a.record.completedAt).localeCompare(s(b.record.completedAt)));

    const committeeRecords = entriesOf(committee)
      .filter(([,r]) => {
        const rr = r || {};
        const direct = s(rr.studentKey);
        const linkedSk = committeeEntryKeys(rr).map(k=>s(((entries||{})[k]||{}).studentKey)).find(Boolean) || '';
        return (direct === sk || (!direct && linkedSk === sk)) && recordYear(rr, year) === year;
      })
      .map(([key,record])=>({key,record:record||{},flow:committeeFlow(record, entries)}));
    const pendingCommittees = committeeRecords.filter(x=>!s(x.record.completedAt)).sort((a,b)=>eventTime(a.record).localeCompare(eventTime(b.record)));
    const completedCommittees = committeeRecords.filter(x=>!!s(x.record.completedAt)).sort((a,b)=>s(a.record.completedAt).localeCompare(s(b.record.completedAt)));

    const completedSources = [
      ...completedNotices.map(x=>({id:'notice:'+x.key,type:'notice',key:x.key,record:x.record})),
      ...completedCommittees.map(x=>({id:'committee:'+x.key,type:'committee',key:x.key,flow:x.flow,record:x.record}))
    ].sort((a,b)=>s(a.record.completedAt).localeCompare(s(b.record.completedAt)));

    const recoveryRecords = entriesOf(recovery)
      .filter(([,r]) => s((r||{}).studentKey) === sk && recordLevel(r, lv) === lv && recordYear(r, year) === year && !!s((r||{}).completedAt))
      .map(([key,record])=>({key,record:record||{}}));
    const links = inferRecoveryLinks(completedSources, recoveryRecords);
    const recoveryLedger = calculateRecoveryLedger(confirmedEntries, links.recoveryInfo);
    const effectiveRecoveredPoints = recoveryLedger.effectiveRecoveredPoints;
    const storedRecoveredPoints = recoveryRecords.reduce((sum,x)=>sum+Math.max(0,n(x.record.recoveryPoints)),0);
    // This subtraction is guaranteed non-negative by the recovery ledger itself; max() is
    // retained only as a final invariant guard, not to hide negative stored balances.
    const currentPoints = Math.max(0, rawPoints - effectiveRecoveredPoints);

    const pendingEdu = pendingCommittees.some(x=>x.flow==='edu');

    const referralConfirmed = confirmedEntries.filter(e=>bool(e.record.isReferral));
    function referralCovered(entry){
      return committeeRecords.some(c=>{
        if (c.flow !== 'referral') return false;
        const linked = committeeEntryKeys(c.record);
        if (linked.includes(entry.key)) return true;
        const ct = s(c.record.completedAt || c.record.createdAt || c.record.referredAt);
        return !!ct && ct >= confirmedTime(entry.record);
      });
    }
    const uncoveredReferralEntries = referralConfirmed.filter(e=>!referralCovered(e));
    const referralDue = uncoveredReferralEntries.length > 0;

    // A completed Education Committee covers only the entries that existed up to that
    // completion. New qualifying points may create a later Committee cycle.
    const completedEduRecords = completedCommittees.filter(x=>x.flow==='edu');
    const latestEduCompletedAt = completedEduRecords.map(x=>s(x.record.completedAt)).filter(Boolean).sort().pop() || '';
    const latestConfirmedAt = confirmedEntries.length ? confirmedTime(confirmedEntries[confirmedEntries.length-1].record) : '';
    const eduCoversLatestEntry = !!latestEduCompletedAt && (!latestConfirmedAt || latestEduCompletedAt >= latestConfirmedAt);
    const eduDue = !pendingEdu && !eduCoversLatestEntry && (currentPoints >= EDU_CURRENT_THRESHOLD || rawPoints > EDU_OVERALL_THRESHOLD);
    const committeeDue = pendingCommittees.length > 0 || referralDue || eduDue;
    const desiredCommitteeFlow = pendingCommittees.length ? pendingCommittees[0].flow : (referralDue ? 'referral' : (eduDue ? 'edu' : ''));

    const latestSource = completedSources.slice().sort((a,b)=>s(b.record.completedAt).localeCompare(s(a.record.completedAt)))[0] || null;
    // Clamp historical baselines to raw points that still exist after upstream cancellations.
    const baselineRaw = latestSource ? Math.min(rawPoints, sourceBaselineRaw(latestSource, confirmedEntries)) : 0;
    const uncoveredRawPoints = latestSource ? Math.max(0, rawPoints - baselineRaw) : currentPoints;

    // Committee supersedes a Notice for the same currently-uncovered cycle.
    const noticeDue = !committeeDue && uncoveredRawPoints >= NOTICE_THRESHOLD;
    const desiredActiveNoticeCount = noticeDue ? 1 : 0;

    // Sources explicitly completed by a Recovery are resolved. In addition, when a valid
    // Recovery brought the student's balance to exactly zero, every older obligation that
    // existed at that moment is satisfied as well. This prevents leftover Recoveries from
    // reappearing later when new detention points are added.
    const resolvedSourceIds = new Set(Array.from(links.assigned.keys()));
    if (recoveryLedger.latestZeroAt) {
      completedSources.forEach(src=>{
        if (s(src.record.completedAt) <= recoveryLedger.latestZeroAt) resolvedSourceIds.add(src.id);
      });
    }
    let unresolvedSources = completedSources.filter(src=>!resolvedSourceIds.has(src.id));
    if (currentPoints === 0) unresolvedSources = [];
    const pendingRecoveryCount = unresolvedSources.length;

    const issues = [];
    const actions = [];
    if (activeNotices.length > 1) {
      issues.push('Multiple active Notices exist; unified model allows only one.');
      actions.push('Merge/void '+(activeNotices.length-1)+' extra active Notice record(s).');
    }
    if (activeNotices.length !== desiredActiveNoticeCount) {
      actions.push(desiredActiveNoticeCount ? 'One active Notice should exist.' : 'No active Notice should exist.');
    }
    if (committeeDue && activeNotices.length) {
      issues.push('A Committee case and active Notice overlap; Committee should supersede the active Notice for this cycle.');
    }
    if (pendingCommittees.length > 1) {
      issues.push('Multiple pending Committee records exist for one student.');
    }
    if (links.warnings.length) issues.push(...links.warnings);
    if (storedRecoveredPoints !== effectiveRecoveredPoints) {
      issues.push('Stored Recovery deductions exceed what is currently valid/effective; the unified ledger prevents negative point banking.');
    }
    recoveryLedger.rows.filter(x=>x.requestedPoints>x.effectivePoints).forEach(x=>{
      issues.push('Recovery '+x.recoveryKey+' requested '+x.requestedPoints+' point(s), but only '+x.effectivePoints+' could validly be deducted at that time.');
    });

    const inferredLinks = links.recoveryInfo.filter(x=>x.inferred && x.valid).length;
    if (inferredLinks) issues.push(inferredLinks+' legacy Recovery link(s) were inferred for preview; migration should make these links explicit.');

    // Current persisted state is comparison-only; never authoritative.
    const stateKey = sk.replace(/[.#$/\[\]\s]/g,'_')+'_'+lv;
    const persistedState = (data.cycleState || {})[stateKey] || null;

    const needsReview = links.recoveryInfo.some(x=>!x.valid) || pendingCommittees.length > 1;
    const wouldChange = actions.length > 0 || issues.some(x=>/Multiple active|overlap|not attached/.test(x));

    return {
      studentKey:sk, level:lv, year,
      rawPoints, storedRecoveredPoints, effectiveRecoveredPoints, currentPoints,
      baselineRaw, uncoveredRawPoints,
      current:{
        activeNoticeCount:activeNotices.length,
        completedNoticeCount:completedNotices.length,
        pendingCommitteeCount:pendingCommittees.length,
        completedCommitteeCount:completedCommittees.length,
        completedRecoveryCount:recoveryRecords.length,
        persistedPhase:persistedState ? s(persistedState.phase) : ''
      },
      desired:{
        activeNoticeCount:desiredActiveNoticeCount,
        noticeDue,
        committeeDue,
        committeeFlow:desiredCommitteeFlow,
        pendingRecoveryCount,
        completedSourceCount:completedSources.length
      },
      details:{
        latestSource:latestSource ? {type:latestSource.type,key:latestSource.key,completedAt:s(latestSource.record.completedAt)} : null,
        pendingRecoverySources:unresolvedSources.map(src=>({type:src.type,key:src.key,flow:src.flow||'',completedAt:s(src.record.completedAt)})),
        recoveryLinks:links.recoveryInfo.map(x=>({recoveryKey:x.recovery.key,sourceType:x.source?x.source.type:'',sourceKey:x.source?x.source.key:'',inferred:x.inferred,valid:x.valid})),
        recoveryLedger:recoveryLedger.rows.map(x=>({recoveryKey:x.recoveryKey,requestedPoints:x.requestedPoints,effectivePoints:x.effectivePoints,availableBefore:x.availableBefore,completedAt:x.completedAt})),
        recoveryZeroedAt:recoveryLedger.latestZeroAt,
        uncoveredReferralEntryKeys:uncoveredReferralEntries.map(e=>e.key),
        activeNoticeKeys:activeNotices.map(x=>x.key),
        pendingCommitteeKeys:pendingCommittees.map(x=>x.key)
      },
      issues, actions,
      status: needsReview ? 'review' : (wouldChange ? 'change' : 'ok')
    };
  }

  function collectTargets(data, options){
    data=data||{}; options=options||{}; const year=s(options.year||'');
    const map = new Map();
    function add(sk,lv,cls){ sk=s(sk); lv=s(lv||classLevel(cls)).toLowerCase(); if(!sk||!['ms','hs'].includes(lv))return; map.set(sk+'|||'+lv,{studentKey:sk,level:lv}); }
    entriesOf(data.students||{}).forEach(([k,r])=>add(k,'',(r||{}).className));
    valuesOf(data.entries||{}).filter(r=>recordYear(r,year)===year).forEach(r=>add(r.studentKey,r.schoolLevel,r.className));
    valuesOf(data.notices||{}).filter(r=>recordYear(r,year)===year).forEach(r=>add(r.studentKey,recordLevel(r),r.className));
    valuesOf(data.recovery||{}).filter(r=>recordYear(r,year)===year).forEach(r=>add(r.studentKey,recordLevel(r),r.className));
    valuesOf(data.committee||{}).filter(r=>recordYear(r,year)===year).forEach(r=>{
      let sk=s(r.studentKey); if(!sk){const k=committeeEntryKeys(r)[0];sk=s(((data.entries||{})[k]||{}).studentKey);} add(sk,'',r.className||(((data.students||{})[sk]||{}).className));
    });
    return Array.from(map.values());
  }

  function analyzeAll(data, options){
    const results = collectTargets(data, options).map(t=>analyzeStudent(t.studentKey,t.level,data,options));
    const counts = {total:results.length, ok:0, change:0, review:0};
    results.forEach(r=>{counts[r.status]=(counts[r.status]||0)+1;});
    return {counts, results};
  }

  return {
    constants:{NOTICE_THRESHOLD,EDU_CURRENT_THRESHOLD,EDU_OVERALL_THRESHOLD},
    analyzeStudent,
    analyzeAll,
    _internals:{academicYearFromDate,recordYear,classLevel,recordLevel,committeeFlow,inferRecoveryLinks,sourceBaselineRaw,calculateRecoveryLedger}
  };
});
