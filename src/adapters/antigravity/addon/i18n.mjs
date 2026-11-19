/**
 * Self-contained localization & formatting module for the AddonManifest.v1 inline statusbar (SRP).
 */

export function createInlineI18n(initialLocale = 'ko') {
  const STRINGS = {
    en: {
      connecting: 'Statusbar: Connecting…',
      reconnecting: 'Statusbar: Reconnecting…',
      standby: 'Statusbar: Waiting for Sidecar…',
      reloadNow: 'Reload',
      ctx: 'Ctx',
      cache: 'Cache',
      quota: 'Quota',
      softLimit: 'Limit Reached',
      autoCompacting: 'Auto-compacting…',
      compactingBadge: 'Compacting…',
      compact: 'compact',
      compacting: '…',
      compactSent: 'Compaction requested',
      compactInProgress: 'Compaction already in progress',
      compactFail: 'Compaction failed',
      noActiveSession: 'No active session found',
      settingsTitle: 'Statusbar',
      tabContext: 'Context',
      tabSettings: 'Settings',
      compactionSettingsTitle: 'Compaction',
      breakdownTitle: 'Token Breakdown',
      limitTitle: 'Session Context Limit',
      limitHint: 'Saved per session. Auto-compacts when reached.',
      autoCompactLabel: 'Auto /compact on limit',
      compactPromptTitle: 'Compaction Prompt (/compact …)',
      compactPromptPlaceholder: 'e.g. Focus on modified files and remaining tasks (blank = default)',
      compactPromptHint: 'Ctrl+Enter to save · blank = default /compact',
      save: 'Save',
      reset: 'Reset',
      limitPlaceholder: 'Custom tokens (32,000 - 980,000)',
      hostDefault: 'Host default',
      scopeSession: 'This session',
      scopeDefault: 'Default',
      apply: 'Apply',
      applied: 'Saved',
      appliedClamped: 'Saved ({val}) — clamped to model max ({max})',
      limitStatusNormal: 'Active: {eff} ({source}) · Model max {max}',
      limitStatusClamped: 'Set {custom} → clamped to model max {max}',
      sourceSession: 'this session',
      sourceDefault: 'default',
      sourceHost: 'host default',
      overModelMax: 'over {max} max',
      invalidLimit: 'Enter 32,000–980,000 or leave blank for host default.',
      steps: 'Steps',
      model: 'Model',
      close: 'Close',
      langLabel: 'Language',
      stale: 'stale',
      addonsTitle: 'Attached Add-ons',
      addonEmpty: 'No add-ons attached. Ask an agent to attach a button.',
      addonOn: 'ON',
      addonOff: 'OFF',
      delBtn: 'Remove',
      cmdSent: 'Sent',
      cmdFail: 'Failed',
    },
    ko: {
      connecting: '상태바: 연결 중…',
      reconnecting: '상태바: 재연결 중…',
      standby: '상태바: Sidecar 연결 대기 중…',
      reloadNow: '새로고침',
      ctx: '컨텍스트',
      cache: '캐시',
      quota: '할당량',
      softLimit: '한도 도달',
      autoCompacting: '자동 컴팩션 중…',
      compactingBadge: '컴팩션 중…',
      compact: 'compact',
      compacting: '…',
      compactSent: '컴팩션 요청됨',
      compactInProgress: '이미 컴팩션 진행 중',
      compactFail: '컴팩션 실패',
      noActiveSession: '활성 세션을 찾을 수 없습니다.',
      settingsTitle: '상태바',
      tabContext: '컨텍스트',
      tabSettings: '설정',
      compactionSettingsTitle: '컴팩션 설정',
      breakdownTitle: '토큰 구성',
      limitTitle: '세션 컨텍스트 한도',
      limitHint: '세션별로 저장되며 한도 도달 시 자동 /compact를 실행합니다.',
      autoCompactLabel: '한도 도달 시 자동 /compact',
      compactPromptTitle: '컴팩션 요약 문구 (/compact …)',
      compactPromptPlaceholder: '예: 수정 중인 파일과 남은 작업 위주로 요약해줘 (비우면 기본)',
      compactPromptHint: 'Ctrl+Enter로 저장 · 비우면 기본 /compact',
      save: '저장',
      reset: '초기화',
      limitPlaceholder: '직접 입력 (32,000 ~ 980,000)',
      hostDefault: '호스트 기본값',
      scopeSession: '현재 세션',
      scopeDefault: '기본값',
      apply: '적용',
      applied: '저장되었습니다.',
      appliedClamped: '{val} 저장됨 (모델 최대 {max}로 제한 적용)',
      limitStatusNormal: '적용 중: {eff} ({source}) · 모델 최대 {max}',
      limitStatusClamped: '{custom} 설정됨 → 모델 최대 {max}로 제한 적용됨',
      sourceSession: '현재 세션',
      sourceDefault: '기본값',
      sourceHost: '호스트 기본값',
      overModelMax: '최대 {max} 초과',
      invalidLimit: '32,000~980,000 사이 숫자 또는 비움(기본값)을 입력하세요.',
      steps: '스텝',
      model: '모델',
      close: '닫기',
      langLabel: '언어 선택',
      stale: '오래됨',
      addonsTitle: '연결된 애드온',
      addonEmpty: '연결된 애드온이 없습니다. 에이전트에게 버튼 추가를 요청하세요.',
      addonOn: '켜짐',
      addonOff: '꺼짐',
      delBtn: '삭제',
      cmdSent: '전송됨',
      cmdFail: '전송 실패',
    },
  };

  const KO_BREAKDOWN_LABELS = {
    System: '시스템',
    'System Prompt': '시스템 프롬프트',
    'Chat Messages': '대화 메시지',
    'User Messages': '사용자 메시지',
    'Assistant Messages': '응답 메시지',
    Tools: '도구',
    'Tool Results': '도구 결과',
    'Files / Context': '파일 · 컨텍스트',
    Thoughts: '사고 과정',
    Other: '기타',
  };

  let locale = initialLocale === 'en' ? 'en' : 'ko';

  function getLocale() {
    return locale;
  }

  function setLocale(next) {
    if (next === 'ko' || next === 'en') {
      locale = next;
    }
    return locale;
  }

  function t() {
    return STRINGS[locale] || STRINGS.ko;
  }

  function formatTokens(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '--';
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(Math.round(n));
  }

  function formatTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) =>
      Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : '',
    );
  }

  function localizeBreakdownLabel(rawLabel) {
    if (locale === 'ko' && Object.prototype.hasOwnProperty.call(KO_BREAKDOWN_LABELS, rawLabel)) {
      return KO_BREAKDOWN_LABELS[rawLabel];
    }
    return rawLabel;
  }

  return Object.freeze({
    getLocale,
    setLocale,
    t,
    formatTokens,
    formatTemplate,
    localizeBreakdownLabel,
  });
}
